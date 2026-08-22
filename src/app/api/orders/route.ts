import { reserveAndCreateOrder } from '@/lib/orders';
import { serverEnv } from '@/lib/env';
import { ok, fail, withErrors, readJson, isUuid, isEmail } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * POST /api/orders — programmatic order placement.
 *
 * Built for agent callers (Parley) rather than the browser. Same stock lock as
 * the storefront checkout: both call reserveAndCreateOrder() in lib/orders,
 * which reserves through the `reserve_product_stock_qty` conditional UPDATE.
 * The 409-on-race guarantee lives in Postgres, so it holds identically here.
 *
 * Differences from POST /api/orders/create, which stays exactly as it was:
 *   - accepts `quantity` (create is always 1)
 *   - accepts `discount_percent`
 *   - returns a flat, agent-shaped payload instead of Checkout.js widget options
 *
 * Body:
 *   {
 *     "product_id":       "uuid",     required
 *     "customer_name":    "string",   required, >= 2 chars
 *     "customer_email":   "string",   required, valid email
 *     "quantity":         1,          optional, integer >= 1, default 1
 *     "discount_percent": 0           optional, integer 0-100, default 0
 *   }
 *
 * ALL AMOUNTS ARE PAISE, in and out. ₹499 is 49900. Nothing is ever converted
 * to rupees on this route.
 *
 *   201  order reserved, Razorpay order created
 *   400  VALIDATION_ERROR       bad body, bad quantity/discount, amount under ₹1
 *   404  NOT_FOUND              no such product
 *   409  OUT_OF_STOCK           insufficient stock; no order created
 *   502  PAYMENT_GATEWAY_ERROR  Razorpay refused; stock released
 */
export const POST = withErrors(async (req: Request) => {
  const body = await readJson(req);

  const productId = body.product_id;
  const customerName =
    typeof body.customer_name === 'string' ? body.customer_name.trim() : '';
  const customerEmail =
    typeof body.customer_email === 'string' ? body.customer_email.trim() : '';

  const fieldErrors: Record<string, string> = {};

  if (!isUuid(productId)) {
    fieldErrors.product_id = 'Required. Must be a product UUID.';
  }
  if (customerName.length < 2) {
    fieldErrors.customer_name = 'Required. At least 2 characters.';
  }
  if (!isEmail(customerEmail)) {
    fieldErrors.customer_email = 'Required. Must be a valid email address.';
  }

  // ---------------------------------------------------------- quantity --
  let quantity = 1;
  if (body.quantity !== undefined && body.quantity !== null) {
    const raw = body.quantity;
    // Reject "2" as well as 2.5 — an agent sending a string here is a bug on
    // its side, and silently coercing hides it.
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
      fieldErrors.quantity = 'Must be an integer >= 1 (JSON number, not a string).';
    } else if (raw > 100) {
      fieldErrors.quantity = 'Must be <= 100 units per order.';
    } else {
      quantity = raw;
    }
  }

  // -------------------------------------------------- discount_percent --
  let discountPercent = 0;
  if (body.discount_percent !== undefined && body.discount_percent !== null) {
    const raw = body.discount_percent;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 100) {
      fieldErrors.discount_percent =
        'Must be an integer between 0 and 100 (whole percent, JSON number).';
    } else {
      discountPercent = raw;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return fail('VALIDATION_ERROR', 'Invalid request body.', 400, { fields: fieldErrors });
  }

  // ------------------------------------------------------------ place it --
  const result = await reserveAndCreateOrder({
    productId: productId as string,
    customerName,
    customerEmail,
    quantity,
    discountPercent,
  });

  if (!result.ok) {
    return fail(result.code, result.message, result.status, result.details);
  }

  const { order, product, reservedProduct, pricing, razorpayOrder } = result.data;
  const { reservationTtlMinutes } = serverEnv();

  return ok(
    {
      order_id: order.id,
      status: order.status, // 'reserved' until payment is verified

      // Every figure below is PAISE.
      amount_charged: pricing.amount_charged,
      currency: 'INR',
      pricing: {
        unit_price: pricing.unit_price,
        quantity: pricing.quantity,
        subtotal: pricing.subtotal,
        discount_percent: pricing.discount_percent,
        discount_amount: pricing.discount_amount,
        amount_charged: pricing.amount_charged,
      },

      product: {
        id: product.id,
        name: product.name,
        size: product.size,
        color: product.color,
        stock_count_after_reservation: reservedProduct.stock_count,
      },

      customer: {
        name: order.customer_name,
        email: order.customer_email,
      },

      /**
       * The payment reference. `razorpay_order_id` is what a caller acts on:
       * open Checkout with it, or drive Razorpay's API directly. It is also
       * what POST /api/orders/verify expects back alongside the payment id and
       * signature.
       *
       * `key_id` is the publishable key — safe to hand onwards. The key secret
       * never leaves this server.
       */
      payment: {
        provider: 'razorpay',
        mode: 'test',
        razorpay_order_id: razorpayOrder.id,
        key_id: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? '',
        amount: razorpayOrder.amount, // paise, equals amount_charged
        currency: razorpayOrder.currency,
        receipt: razorpayOrder.receipt,
        status: razorpayOrder.status,
        verify_url: '/api/orders/verify',
        status_url: `/api/orders/${order.id}`,
      },

      reservation_expires_in_minutes: reservationTtlMinutes,
      created_at: order.created_at,
    },
    201,
  );
});
