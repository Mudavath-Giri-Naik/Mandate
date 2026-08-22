import { supabaseAdmin } from '@/lib/supabase';
import { razorpay } from '@/lib/razorpay';
import { serverEnv } from '@/lib/env';
import { ok, fail, withErrors, readJson, isUuid, isEmail } from '@/lib/api';
import type { Product, Order } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/orders/create
 *
 * Body: { product_id, customer_name, customer_email }
 *
 * The sequence matters. Stock is reserved FIRST, by a single conditional
 * UPDATE inside Postgres, before any order row exists and before Razorpay is
 * ever contacted. If the reservation loses the race there is nothing to clean
 * up — we return 409 and no order was created.
 *
 * Everything after the reservation is compensated on failure: if we cannot
 * write the order row, or Razorpay rejects us, the reserved unit goes back.
 *
 *  201 → { order, razorpay: { ... }, checkout: { ... } }
 *  409 → OUT_OF_STOCK
 */
export const POST = withErrors(async (req: Request) => {
  const body = await readJson(req);
  const productId = body.product_id;
  const customerName =
    typeof body.customer_name === 'string' ? body.customer_name.trim() : '';
  const customerEmail =
    typeof body.customer_email === 'string' ? body.customer_email.trim() : '';

  // ---------------------------------------------------------- validation --
  const fieldErrors: Record<string, string> = {};
  if (!isUuid(productId)) fieldErrors.product_id = 'Required. Must be a product UUID.';
  if (customerName.length < 2) fieldErrors.customer_name = 'Required. At least 2 characters.';
  if (!isEmail(customerEmail)) fieldErrors.customer_email = 'Required. Must be a valid email.';

  if (Object.keys(fieldErrors).length > 0) {
    return fail('VALIDATION_ERROR', 'Invalid request body.', 400, { fields: fieldErrors });
  }

  const db = supabaseAdmin();

  // Read the product first, purely so we can distinguish "no such product"
  // (404) from "exists but exhausted" (409). This read is NOT the stock check
  // — the authoritative check is the conditional UPDATE below.
  const { data: existing, error: lookupError } = await db
    .from('products')
    .select('*')
    .eq('id', productId as string)
    .maybeSingle();

  if (lookupError) return fail('INTERNAL_ERROR', lookupError.message, 500);
  if (!existing) return fail('NOT_FOUND', `No product with id ${productId}.`, 404);

  const product = existing as Product;

  // ------------------------------------------------- 1. atomic reservation --
  // Single statement, evaluated by Postgres under a row lock. Zero rows back
  // means another request took the last unit between our read and this write.
  const { data: reservedRows, error: reserveError } = await db.rpc(
    'reserve_product_stock',
    { p_product_id: productId },
  );

  if (reserveError) {
    return fail(
      'INTERNAL_ERROR',
      `Stock reservation failed: ${reserveError.message}. ` +
        'Have you run supabase/schema.sql? It defines reserve_product_stock().',
      500,
    );
  }

  const reserved = (reservedRows as Product[] | null) ?? [];
  if (reserved.length === 0) {
    return fail(
      'OUT_OF_STOCK',
      `"${product.name}" is out of stock. No order was created and you were not charged.`,
      409,
      { product_id: product.id, stock_count: 0 },
    );
  }

  const reservedProduct = reserved[0];

  /** Undo the reservation. Used on every failure path below. */
  const releaseStock = async () => {
    const { error } = await db.rpc('release_product_stock', { p_product_id: productId });
    if (error) console.error('[orders/create] failed to release stock', productId, error);
  };

  // -------------------------------------------- 2. create the order record --
  const { data: orderRow, error: orderError } = await db
    .from('orders')
    .insert({
      product_id: product.id,
      customer_name: customerName,
      customer_email: customerEmail,
      amount: product.price,
      status: 'reserved',
    })
    .select('*')
    .single();

  if (orderError || !orderRow) {
    await releaseStock();
    return fail(
      'INTERNAL_ERROR',
      `Could not create the order: ${orderError?.message ?? 'unknown error'}`,
      500,
    );
  }

  const order = orderRow as Order;

  // ------------------------------------------ 3. create the Razorpay order --
  let rzpOrder;
  try {
    rzpOrder = await razorpay().orders.create({
      amount: product.price,           // paise — same unit as our column
      currency: 'INR',
      receipt: order.id,               // our uuid is 36 chars, under Razorpay's 40
      notes: {
        order_id: order.id,
        product_id: product.id,
        product_name: product.name,
        customer_email: customerEmail,
      },
    });
  } catch (err) {
    // Razorpay never accepted the order, so nothing is pending on their side.
    // Roll our side all the way back.
    await releaseStock();
    await db.from('orders').update({ status: 'failed' }).eq('id', order.id);

    const description =
      (err as { error?: { description?: string } })?.error?.description ??
      (err instanceof Error ? err.message : 'Unknown Razorpay error');

    console.error('[orders/create] razorpay rejected order', description);
    return fail(
      'PAYMENT_GATEWAY_ERROR',
      `Razorpay could not create the payment order: ${description}. Stock has been released.`,
      502,
    );
  }

  const { data: updatedOrder } = await db
    .from('orders')
    .update({ razorpay_order_id: rzpOrder.id })
    .eq('id', order.id)
    .select('*')
    .single();

  // ------------------------------------------------------------ 4. respond --
  const { reservationTtlMinutes } = serverEnv();

  return ok(
    {
      order: (updatedOrder as Order) ?? { ...order, razorpay_order_id: rzpOrder.id },
      product: {
        id: reservedProduct.id,
        name: reservedProduct.name,
        size: reservedProduct.size,
        color: reservedProduct.color,
        image_url: reservedProduct.image_url,
        stock_count_after_reservation: reservedProduct.stock_count,
      },
      razorpay: {
        id: rzpOrder.id,
        amount: rzpOrder.amount,
        currency: rzpOrder.currency,
        receipt: rzpOrder.receipt,
        status: rzpOrder.status,
      },
      // Everything Checkout.js needs. Only the *public* key id is here —
      // the secret never leaves the server.
      checkout: {
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? '',
        amount: rzpOrder.amount,
        currency: rzpOrder.currency,
        order_id: rzpOrder.id,
        name: 'Mandate',
        description: reservedProduct.name,
        prefill: { name: customerName, email: customerEmail },
      },
      reservation_expires_in_minutes: reservationTtlMinutes,
    },
    201,
  );
});
