import crypto from 'node:crypto';
import Razorpay from 'razorpay';
import { serverEnv } from './env';

/** SERVER ONLY — constructed with the key secret. */
let cached: Razorpay | null = null;

export function razorpay(): Razorpay {
  if (cached) return cached;
  const { razorpayKeyId, razorpayKeySecret } = serverEnv();
  cached = new Razorpay({ key_id: razorpayKeyId, key_secret: razorpayKeySecret });
  return cached;
}

/**
 * Verify the signature Razorpay Checkout hands back to the browser.
 *
 * The frontend telling us "payment succeeded" means nothing on its own — a
 * hostile client can POST whatever it likes to /api/orders/verify. The only
 * thing that proves payment is this HMAC, which only Razorpay and we can
 * produce because it is keyed on the secret:
 *
 *     HMAC_SHA256(razorpay_order_id + "|" + razorpay_payment_id, key_secret)
 *
 * Compared with timingSafeEqual so the comparison cannot be probed byte by
 * byte.
 */
export function verifyPaymentSignature(params: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  signature: string;
}): boolean {
  const { razorpayKeySecret } = serverEnv();

  const expected = crypto
    .createHmac('sha256', razorpayKeySecret)
    .update(`${params.razorpayOrderId}|${params.razorpayPaymentId}`)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(params.signature ?? '', 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Verify a Razorpay *webhook* body against the webhook secret. */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature ?? '', 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Create a Razorpay order, retrying transient gateway failures.
 *
 * Razorpay's *test* environment intermittently answers a perfectly valid key
 * with `401 Authentication failed` under rapid sequential load. Reproduced
 * directly against their API with three identical requests one second apart:
 * 200, then 401, then 200. Nothing about the credentials changed.
 *
 * A browser checkout rarely notices — one order per customer, minutes apart.
 * An agent placing orders in a loop hits it constantly, so the retry lives
 * here rather than in each caller.
 *
 * 401 is normally the one status you must NOT retry, because it means the
 * credentials are wrong. That still holds: if every attempt fails with 401 the
 * error is surfaced with a note that the key may genuinely be bad, so a real
 * misconfiguration fails loudly rather than just slowly.
 */
interface RazorpayOrderParams {
  amount: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function createRazorpayOrderWithRetry(
  params: RazorpayOrderParams,
  maxAttempts = 4,
) {
  let lastError: unknown;
  let sawOnly401 = true;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await razorpay().orders.create(params);
    } catch (err) {
      lastError = err;
      const status = (err as { statusCode?: number })?.statusCode ?? 0;
      if (status !== 401) sawOnly401 = false;

      const transient = status === 401 || status === 429 || status >= 500;
      if (!transient || attempt === maxAttempts) break;

      // 200ms, 400ms, 800ms, plus jitter so parallel callers do not resynchronise.
      const backoff = 200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
      console.warn(
        `[razorpay] attempt ${attempt}/${maxAttempts} failed with ${status}; retrying in ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }

  if (sawOnly401) {
    const e = lastError as { error?: { description?: string } };
    throw Object.assign(new Error(
      `Razorpay rejected the credentials on all ${maxAttempts} attempts ` +
      `(${e?.error?.description ?? 'Authentication failed'}). ` +
      'Check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.',
    ), { statusCode: 401, error: e?.error });
  }
  throw lastError;
}
