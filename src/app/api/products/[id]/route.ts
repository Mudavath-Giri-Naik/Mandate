import { supabaseAdmin } from '@/lib/supabase';
import { ok, fail, withErrors, isUuid } from '@/lib/api';
import type { Product } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/products/:id
 * Full product detail including the live stock_count (never cached).
 */
export const GET = withErrors(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    if (!isUuid(id)) {
      return fail('VALIDATION_ERROR', `"${id}" is not a valid product id.`, 400);
    }

    const { data, error } = await supabaseAdmin()
      .from('products')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) return fail('INTERNAL_ERROR', error.message, 500);
    if (!data) return fail('NOT_FOUND', `No product with id ${id}.`, 404);

    const product = data as Product;
    return ok({
      ...product,
      in_stock: product.stock_count > 0 && product.status !== 'sold_out',
    });
  },
);
