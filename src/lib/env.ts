/**
 * Environment access, centralised.
 *
 * Anything read through `serverEnv()` is server-only. The Razorpay *secret*
 * and the Supabase *service-role* key must never reach a client bundle, so
 * they are only ever touched from files that run on the server.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

export function serverEnv() {
  return {
    supabaseUrl: required('NEXT_PUBLIC_SUPABASE_URL'),
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    razorpayKeyId: required('RAZORPAY_KEY_ID'),
    razorpayKeySecret: required('RAZORPAY_KEY_SECRET'),
    /** Minutes an order may sit in `reserved` before the sweeper releases it. */
    reservationTtlMinutes: Number(process.env.RESERVATION_TTL_MINUTES ?? 10),
    /** Optional shared secret guarding POST /api/orders/cancel-expired. */
    cronSecret: process.env.CRON_SECRET ?? null,
  };
}

/** The publishable key id — safe in the browser, needed by Checkout.js. */
export const publicRazorpayKeyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? '';
