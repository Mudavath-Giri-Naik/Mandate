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
