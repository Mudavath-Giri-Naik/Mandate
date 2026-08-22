import { supabaseAdmin } from '@/lib/supabase';
import { verifyPaymentSignature } from '@/lib/razorpay';
import { ok, fail, withErrors, readJson, isUuid } from '@/lib/api';
import type { Order } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/orders/verify
 *
 * Body: { order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature }
 *   or: { order_id, failed: true }   ← client-side dismissal / payment failure
 *
 * The browser saying "it worked" proves nothing. The only evidence accepted
 * here is the HMAC signature, recomputed server-side from the key secret. A
 * forged or missing signature is treated exactly like a failed payment: the
 * order is marked failed and the reserved unit goes back on the shelf.
 *
 * Idempotent in both directions. Every state change is a conditional UPDATE
 * guarded on `status = 'reserved'`, so replaying this endpoint can never
 * release the same unit of stock twice.
 */
export const POST = withErrors(async (req: Request) => {
  const body = await readJson(req);

  const orderId = body.order_id;
  const razorpayOrderId = body.razorpay_order_id;
  const razorpayPaymentId = body.razorpay_payment_id;
  const razorpaySignature = body.razorpay_signature;
  const explicitFailure = body.failed === true;

  if (!isUuid(orderId)) {
    return fail('VALIDATION_ERROR', 'order_id is required and must be our order UUID.', 400);
  }

  const db = supabaseAdmin();

  const { data: found, error: lookupError } = await db
    .from('orders')
    .select('*')
    .eq('id', orderId as string)
    .maybeSingle();

  if (lookupError) return fail('INTERNAL_ERROR', lookupError.message, 500);
  if (!found) return fail('NOT_FOUND', `No order with id ${orderId}.`, 404);

  const order = found as Order;

  // --------------------------------------------------------- already done --
  // Replay of a successful verify: report success without touching anything.
  if (order.status === 'paid') {
    return ok({ order, verified: true, idempotent_replay: true });
  }

  if (order.status === 'failed' || order.status === 'cancelled') {
    // Stock for this order was already released when it reached this state.
    return ok({ order, verified: false, idempotent_replay: true });
  }

  /**
   * Move the order to `failed` and, only if this call is the one that actually
   * performed that transition, put the unit back. The `.eq('status','reserved')`
   * guard is what makes concurrent/duplicate calls safe.
   */
  const failOrder = async (reason: string) => {
    const { data: transitioned } = await db
      .from('orders')
      .update({ status: 'failed' })
      .eq('id', order.id)
      .eq('status', 'reserved')
      .select('*');

    const didTransition = (transitioned?.length ?? 0) > 0;

    if (didTransition && order.product_id) {
      const { error } = await db.rpc('release_product_stock', {
        p_product_id: order.product_id,
      });
      if (error) console.error('[orders/verify] stock release failed', order.id, error);
    }

    const { data: fresh } = await db
      .from('orders')
      .select('*')
      .eq('id', order.id)
      .maybeSingle();

    return { order: (fresh as Order) ?? order, stock_released: didTransition, reason };
  };

  // ------------------------------------- explicit failure from the client --
  if (explicitFailure) {
    const result = await failOrder('Client reported a failed or dismissed payment.');
    return ok({ ...result, verified: false });
  }

  // --------------------------------------------------- signature required --
  if (
    typeof razorpayOrderId !== 'string' ||
    typeof razorpayPaymentId !== 'string' ||
    typeof razorpaySignature !== 'string'
  ) {
    return fail(
      'VALIDATION_ERROR',
      'razorpay_order_id, razorpay_payment_id and razorpay_signature are all required ' +
        '(or send { failed: true } to abandon the order).',
      400,
    );
  }

  // The signature must belong to *this* order. Without this check a valid
  // signature from a cheap order could be replayed against an expensive one.
  if (order.razorpay_order_id && order.razorpay_order_id !== razorpayOrderId) {
    const result = await failOrder(
      'razorpay_order_id does not match the order it is being verified against.',
    );
    return fail(
      'INVALID_SIGNATURE',
      `This payment belongs to Razorpay order ${razorpayOrderId}, but order ${order.id} ` +
        `expects ${order.razorpay_order_id}. Order marked failed, stock released.`,
      400,
      result,
    );
  }

  const signatureValid = verifyPaymentSignature({
    razorpayOrderId,
    razorpayPaymentId,
    signature: razorpaySignature,
  });

  if (!signatureValid) {
    const result = await failOrder('HMAC signature verification failed.');
    return fail(
      'INVALID_SIGNATURE',
      'Signature verification failed. This payment was not confirmed by Razorpay. ' +
        'The order has been marked failed and the stock released.',
      400,
      result,
    );
  }

  // ------------------------------------------------------- 2. mark as paid --
  const { data: paidRows, error: payError } = await db
    .from('orders')
    .update({ status: 'paid', razorpay_payment_id: razorpayPaymentId })
    .eq('id', order.id)
    .eq('status', 'reserved')
    .select('*');

  if (payError) return fail('INTERNAL_ERROR', payError.message, 500);

  if (!paidRows || paidRows.length === 0) {
    // Something else moved the order out of `reserved` while we were verifying
    // — almost always the expiry sweeper reclaiming an abandoned reservation.
    const { data: fresh } = await db
      .from('orders')
      .select('*')
      .eq('id', order.id)
      .maybeSingle();

    return fail(
      'ORDER_STATE_CONFLICT',
      `Signature was valid, but order ${order.id} is no longer reserved ` +
        `(status: ${(fresh as Order | null)?.status ?? 'unknown'}). ` +
        'Its reservation most likely expired. Refund this payment manually in the ' +
        'Razorpay dashboard.',
      409,
      { order: fresh, razorpay_payment_id: razorpayPaymentId },
    );
  }

  return ok({ order: paidRows[0] as Order, verified: true, stock_released: false });
});
