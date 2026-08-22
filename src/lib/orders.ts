import { supabaseAdmin } from './supabase';
import { createRazorpayOrderWithRetry } from './razorpay';
import type { Product, Order } from './types';
import type { ApiError } from './api';

/**
 * Order placement — the single implementation of the stock lock.
 *
 * Both callers go through `reserveAndCreateOrder`:
 *   - POST /api/orders/create  (browser checkout, quantity fixed at 1)
 *   - POST /api/orders         (agent/programmatic, quantity + discount)
 *
 * Neither route reimplements any of this. The reservation is one conditional
 * UPDATE inside Postgres (`reserve_product_stock_qty`), so the 409-on-race
 * behaviour is a property of the database, not of whichever route happened to
 * be called.
 */

/** Razorpay rejects orders below ₹1. */
export const RAZORPAY_MIN_AMOUNT_PAISE = 100;

export interface PlaceOrderInput {
  productId: string;
  customerName: string;
  customerEmail: string;
  /** Units to reserve. Defaults to 1. */
  quantity?: number;
  /** Whole percent, 0–100. Defaults to 0. */
  discountPercent?: number;
}

export interface PlacedOrder {
  order: Order;
  product: Product;
  /** Product row as it stands *after* the reservation. */
  reservedProduct: Product;
  pricing: {
    unit_price: number;
    quantity: number;
    subtotal: number;
    discount_percent: number;
    discount_amount: number;
    amount_charged: number;
  };
  razorpayOrder: {
    id: string;
    amount: number;
    currency: string;
    receipt: string | null;
    status: string;
  };
}

export type PlaceOrderResult =
  | { ok: true; data: PlacedOrder }
  | { ok: false; code: ApiError; status: number; message: string; details?: unknown };

const fail = (
  code: ApiError,
  status: number,
  message: string,
  details?: unknown,
): PlaceOrderResult => ({ ok: false, code, status, message, details });

/**
 * Every amount here is paise. `unit_price` comes straight out of
 * products.price, which is already the minor unit, and nothing divides by 100
 * at any point — rupees exist only in the UI's formatter.
 *
 * The discount rounds to a whole paise with Math.round, so the stored amount
 * is always an integer and always equals what Razorpay is asked to charge.
 */
export function computePricing(unitPrice: number, quantity: number, discountPercent: number) {
  const subtotal = unitPrice * quantity;
  const amountCharged = Math.round((subtotal * (100 - discountPercent)) / 100);
  return {
    unit_price: unitPrice,
    quantity,
    subtotal,
    discount_percent: discountPercent,
    discount_amount: subtotal - amountCharged,
    amount_charged: amountCharged,
  };
}

/**
 * Reserve stock, write the order, and create the Razorpay order.
 *
 * Ordering matters. Stock is reserved FIRST, atomically, before an order row
 * exists and before Razorpay is contacted — so losing the race costs nothing
 * and leaves nothing to clean up. Every step after the reservation is
 * compensated on failure: the units go back and the order is marked failed.
 */
export async function reserveAndCreateOrder(
  input: PlaceOrderInput,
): Promise<PlaceOrderResult> {
  const quantity = input.quantity ?? 1;
  const discountPercent = input.discountPercent ?? 0;
  const db = supabaseAdmin();

  // Read first, only to tell "no such product" (404) apart from "exists but
  // exhausted" (409). This is NOT the stock check — the conditional UPDATE is.
  const { data: existing, error: lookupError } = await db
    .from('products')
    .select('*')
    .eq('id', input.productId)
    .maybeSingle();

  if (lookupError) return fail('INTERNAL_ERROR', 500, lookupError.message);
  if (!existing) return fail('NOT_FOUND', 404, `No product with id ${input.productId}.`);

  const product = existing as Product;
  const pricing = computePricing(product.price, quantity, discountPercent);

  if (pricing.amount_charged < RAZORPAY_MIN_AMOUNT_PAISE) {
    return fail(
      'VALIDATION_ERROR',
      400,
      `Amount after discount is ${pricing.amount_charged} paise; Razorpay will not accept ` +
        `an order below ${RAZORPAY_MIN_AMOUNT_PAISE} paise (₹1). Reduce discount_percent ` +
        'or increase quantity.',
      { pricing },
    );
  }

  // ------------------------------------------------ 1. atomic reservation --
  const { data: reservedRows, error: reserveError } = await db.rpc(
    'reserve_product_stock_qty',
    { p_product_id: input.productId, p_quantity: quantity },
  );

  if (reserveError) {
    return fail(
      'INTERNAL_ERROR',
      500,
      `Stock reservation failed: ${reserveError.message}. ` +
        'Have you run supabase/migration-002-agent-orders.sql? It defines ' +
        'reserve_product_stock_qty().',
    );
  }

  const reserved = (reservedRows as Product[] | null) ?? [];
  if (reserved.length === 0) {
    return fail(
      'OUT_OF_STOCK',
      409,
      quantity === 1
        ? `"${product.name}" is out of stock. No order was created and you were not charged.`
        : `"${product.name}" does not have ${quantity} units available ` +
          `(${product.stock_count} in stock at last read). No order was created.`,
      {
        product_id: product.id,
        requested_quantity: quantity,
        stock_count: product.stock_count,
      },
    );
  }

  const reservedProduct = reserved[0];

  /** Undo the reservation. Used on every failure path below. */
  const releaseStock = async () => {
    const { error } = await db.rpc('release_product_stock_qty', {
      p_product_id: input.productId,
      p_quantity: quantity,
    });
    if (error) console.error('[orders] failed to release stock', input.productId, error);
  };

  // ------------------------------------------- 2. create the order record --
  const { data: orderRow, error: orderError } = await db
    .from('orders')
    .insert({
      product_id: product.id,
      customer_name: input.customerName,
      customer_email: input.customerEmail,
      quantity,
      unit_price: product.price,
      discount_percent: discountPercent,
      amount: pricing.amount_charged,
      status: 'reserved',
    })
    .select('*')
    .single();

  if (orderError || !orderRow) {
    await releaseStock();
    return fail(
      'INTERNAL_ERROR',
      500,
      `Could not create the order: ${orderError?.message ?? 'unknown error'}. ` +
        'If this mentions a missing column, run supabase/migration-002-agent-orders.sql.',
    );
  }

  const order = orderRow as Order;

  // ------------------------------------------ 3. create the Razorpay order --
  let rzpOrder;
  try {
    rzpOrder = await createRazorpayOrderWithRetry({
      amount: pricing.amount_charged, // paise — same unit as our column
      currency: 'INR',
      receipt: order.id, // our uuid is 36 chars, under Razorpay's 40
      notes: {
        order_id: order.id,
        product_id: product.id,
        product_name: product.name,
        customer_name: input.customerName,
        customer_email: input.customerEmail,
        quantity: String(quantity),
        discount_percent: String(discountPercent),
      },
    });
  } catch (err) {
    await releaseStock();
    await db.from('orders').update({ status: 'failed' }).eq('id', order.id);

    const description =
      (err as { error?: { description?: string } })?.error?.description ??
      (err instanceof Error ? err.message : 'Unknown Razorpay error');

    console.error('[orders] razorpay rejected order', description);
    return fail(
      'PAYMENT_GATEWAY_ERROR',
      502,
      `Razorpay could not create the payment order: ${description}. Stock has been released.`,
    );
  }

  const { data: updatedOrder } = await db
    .from('orders')
    .update({ razorpay_order_id: rzpOrder.id })
    .eq('id', order.id)
    .select('*')
    .single();

  return {
    ok: true,
    data: {
      order: (updatedOrder as Order) ?? { ...order, razorpay_order_id: rzpOrder.id },
      product,
      reservedProduct,
      pricing,
      razorpayOrder: {
        id: rzpOrder.id,
        amount: Number(rzpOrder.amount),
        currency: rzpOrder.currency,
        receipt: rzpOrder.receipt ?? null,
        status: rzpOrder.status,
      },
    },
  };
}
