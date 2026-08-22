import { supabaseAdmin } from '@/lib/supabase';
import { ok, fail, withErrors } from '@/lib/api';
import type { Product } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/products
 *
 * Returns products that are actually buyable (stock_count > 0 and not
 * sold_out). Optional filters:
 *
 *   ?size=M            exact, case-insensitive
 *   ?color=Black       exact, case-insensitive
 *   ?max_price=200000  paise, inclusive
 *   ?include_sold_out=true   also return exhausted items (admin/debug)
 */
export const GET = withErrors(async (req: Request) => {
  const url = new URL(req.url);
  const size = url.searchParams.get('size');
  const color = url.searchParams.get('color');
  const maxPriceRaw = url.searchParams.get('max_price');
  const includeSoldOut = url.searchParams.get('include_sold_out') === 'true';

  let maxPrice: number | null = null;
  if (maxPriceRaw !== null && maxPriceRaw !== '') {
    maxPrice = Number(maxPriceRaw);
    if (!Number.isFinite(maxPrice) || maxPrice < 0) {
      return fail(
        'VALIDATION_ERROR',
        'max_price must be a non-negative integer in paise (₹499 = 49900).',
        400,
      );
    }
  }

  let query = supabaseAdmin()
    .from('products')
    .select('*')
    // All seed rows share a created_at, so without a tiebreaker the order
    // shuffles between requests. id keeps the grid stable.
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (!includeSoldOut) query = query.gt('stock_count', 0).neq('status', 'sold_out');
  if (size) query = query.ilike('size', size);
  if (color) query = query.ilike('color', color);
  if (maxPrice !== null) query = query.lte('price', maxPrice);

  const { data, error } = await query;
  if (error) return fail('INTERNAL_ERROR', error.message, 500);

  const products = (data ?? []) as Product[];
  return ok({
    count: products.length,
    filters: { size, color, max_price: maxPrice, include_sold_out: includeSoldOut },
    products,
  });
});
