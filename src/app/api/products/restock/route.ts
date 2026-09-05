import { supabaseAdmin } from '@/lib/supabase';
import { ok, fail, withErrors } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Every product is topped up to this many units when restocked. */
const RESTOCK_QUANTITY = 50;

/**
 * POST /api/products/restock — admin-only, testing convenience.
 *
 * Sets every product back to RESTOCK_QUANTITY units and 'available', so you
 * do not have to hand-edit the products table after running the storefront
 * down to sold-out while testing checkout.
 */
export const POST = withErrors(async () => {
  const db = supabaseAdmin();

  const { data, error } = await db
    .from('products')
    .update({ stock_count: RESTOCK_QUANTITY, status: 'available' })
    .gte('stock_count', 0)
    .select('id');

  if (error) {
    return fail('INTERNAL_ERROR', `Restock failed: ${error.message}`, 500);
  }

  return ok({
    restocked_at: new Date().toISOString(),
    stock_count: RESTOCK_QUANTITY,
    products_updated: (data ?? []).length,
  });
});
