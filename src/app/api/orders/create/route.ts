import { reserveAndCreateOrder } from '@/lib/orders';
import { serverEnv } from '@/lib/env';
import { ok, fail, withErrors, readJson, isUuid, isEmail } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * POST /api/orders/create — the storefront checkout endpoint.
 *
 * Body: { product_id, customer_name, customer_email }
 *
 * Behaviour and response shape are unchanged: always one unit, no discount,
 * and a `checkout` block shaped for Checkout.js. The browser flow depends on
 * this contract, so it stays fixed.
 *
 * What changed is only where the work happens. The reservation, order insert
 * and Razorpay call now live in lib/orders (`reserveAndCreateOrder`), shared
 * with POST /api/orders. One implementation of the stock lock, so the two
 * paths cannot drift.
 *
 *  201 → { order, product, razorpay, checkout }
 *  409 → OUT_OF_STOCK
 */
export const POST = withErrors(async (req: Request) => {
  const body = await readJson(req);
  const productId = body.product_id;
  const customerName =
    typeof body.customer_name === 'string' ? body.customer_name.trim() : '';
  const customerEmail =
    typeof body.customer_email === 'string' ? body.customer_email.trim() : '';

  const fieldErrors: Record<string, string> = {};
  if (!isUuid(productId)) fieldErrors.product_id = 'Required. Must be a product UUID.';
  if (customerName.length < 2) fieldErrors.customer_name = 'Required. At least 2 characters.';
  if (!isEmail(customerEmail)) fieldErrors.customer_email = 'Required. Must be a valid email.';

  if (Object.keys(fieldErrors).length > 0) {
    return fail('VALIDATION_ERROR', 'Invalid request body.', 400, { fields: fieldErrors });
  }

  const result = await reserveAndCreateOrder({
    productId: productId as string,
    customerName,
    customerEmail,
    quantity: 1,
    discountPercent: 0,
  });

  if (!result.ok) {
    return fail(result.code, result.message, result.status, result.details);
  }

  const { order, reservedProduct, razorpayOrder } = result.data;
  const { reservationTtlMinutes } = serverEnv();

  return ok(
    {
      order,
      product: {
        id: reservedProduct.id,
        name: reservedProduct.name,
        size: reservedProduct.size,
        color: reservedProduct.color,
        image_url: reservedProduct.image_url,
        stock_count_after_reservation: reservedProduct.stock_count,
      },
      razorpay: {
        id: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        receipt: razorpayOrder.receipt,
        status: razorpayOrder.status,
      },
      // Everything Checkout.js needs. Only the *public* key is here — the
      // secret never leaves the server.
      checkout: {
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? '',
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        order_id: razorpayOrder.id,
        name: 'SnapCart',
        description: reservedProduct.name,
        prefill: { name: customerName, email: customerEmail },
      },
      reservation_expires_in_minutes: reservationTtlMinutes,
    },
    201,
  );
});
