import { listProducts } from '@/lib/data';
import { ok, fail, withErrors } from '@/lib/api';

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
 *
 * The query itself lives in lib/data so the storefront pages can call it
 * without going back over HTTP.
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

  const result = await listProducts({ size, color, maxPrice, includeSoldOut });
  if (!result.ok) return fail(result.code, result.message, 500);

  return ok({
    count: result.data.length,
    filters: { size, color, max_price: maxPrice, include_sold_out: includeSoldOut },
    products: result.data,
  });
});
