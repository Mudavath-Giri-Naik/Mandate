import { supabaseAdmin } from '@/lib/supabase';
import { verifyWebhookSignature } from '@/lib/razorpay';
import { ok, fail, withErrors } from '@/lib/api';
import type { Order } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/orders/webhook  —  Razorpay server-to-server events.
 *
 * The browser callback (/api/orders/verify) is the happy path, but it only
 * fires if the customer's tab survives long enough to send it. This endpoint
 * is the backstop: Razorpay tells us directly what happened, so a closed
 * laptop mid-payment still settles correctly.
 *
 * Configure in the Razorpay dashboard → Settings → Webhooks:
 *   URL:    https://<your-app>.vercel.app/api/orders/webhook
 *   Events: payment.captured, payment.failed
 *   Secret: whatever you put in RAZORPAY_WEBHOOK_SECRET
 *
 * Optional — everything works without it in test mode.
 */
export const POST = withErrors(async (req: Request) => {
  // Signature is computed over the exact bytes sent, so read the raw body.
  const rawBody = await req.text();
  const signature = req.headers.get('x-razorpay-signature') ?? '';

  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    return fail(
      'CONFIGURATION_ERROR',
      'RAZORPAY_WEBHOOK_SECRET is not set, so webhooks cannot be verified.',
      503,
    );
  }

  if (!verifyWebhookSignature(rawBody, signature)) {
    return fail('INVALID_SIGNATURE', 'Webhook signature verification failed.', 400);
  }

  const event = JSON.parse(rawBody) as {
    event: string;
    payload?: { payment?: { entity?: { id?: string; order_id?: string } } };
  };

  const payment = event.payload?.payment?.entity;
  const razorpayOrderId = payment?.order_id;
  if (!razorpayOrderId) return ok({ ignored: true, event: event.event });

  const db = supabaseAdmin();
  const { data: found } = await db
    .from('orders')
    .select('*')
    .eq('razorpay_order_id', razorpayOrderId)
    .maybeSingle();

  if (!found) return ok({ ignored: true, reason: 'unknown razorpay_order_id' });
  const order = found as Order;

  if (event.event === 'payment.captured') {
    // Conditional on `reserved` — if /api/orders/verify already settled this
    // order, the update matches nothing and we simply acknowledge.
    const { data } = await db
      .from('orders')
      .update({ status: 'paid', razorpay_payment_id: payment?.id ?? null })
      .eq('id', order.id)
      .eq('status', 'reserved')
      .select('id');

    return ok({ event: event.event, order_id: order.id, changed: (data?.length ?? 0) > 0 });
  }

  if (event.event === 'payment.failed') {
    const { data } = await db
      .from('orders')
      .update({ status: 'failed' })
      .eq('id', order.id)
      .eq('status', 'reserved')
      .select('id');

    const changed = (data?.length ?? 0) > 0;
    // Only the call that actually performed the transition releases stock.
    if (changed && order.product_id) {
      await db.rpc('release_product_stock_qty', {
        p_product_id: order.product_id,
        p_quantity: order.quantity ?? 1,
      });
    }
    return ok({ event: event.event, order_id: order.id, changed, stock_released: changed });
  }

  return ok({ ignored: true, event: event.event });
});
