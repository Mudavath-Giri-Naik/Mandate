import { supabaseAdmin } from '@/lib/supabase';
import { ok, fail, withErrors } from '@/lib/api';
import type { Product, OrderWithProduct } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/overview
 * Everything the /admin dashboard renders, in one round trip.
 * No auth by design for this phase — do not ship this publicly as-is.
 */
export const GET = withErrors(async () => {
  const db = supabaseAdmin();

  const [productsRes, ordersRes] = await Promise.all([
    db
      .from('products')
      .select('*')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
    db
      .from('orders')
      .select('*, product:products(id, name, size, color, image_url)')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(200),
  ]);

  if (productsRes.error) return fail('INTERNAL_ERROR', productsRes.error.message, 500);
  if (ordersRes.error) return fail('INTERNAL_ERROR', ordersRes.error.message, 500);

  const products = (productsRes.data ?? []) as Product[];
  const orders = (ordersRes.data ?? []) as OrderWithProduct[];

  const countBy = (status: string) => orders.filter((o) => o.status === status).length;

  return ok({
    stats: {
      total_products: products.length,
      total_stock: products.reduce((sum, p) => sum + p.stock_count, 0),
      sold_out_products: products.filter((p) => p.stock_count === 0).length,
      total_orders: orders.length,
      orders_by_status: {
        created: countBy('created'),
        reserved: countBy('reserved'),
        paid: countBy('paid'),
        failed: countBy('failed'),
        cancelled: countBy('cancelled'),
      },
      revenue_paise: orders
        .filter((o) => o.status === 'paid')
        .reduce((sum, o) => sum + o.amount, 0),
    },
    products,
    orders,
  });
});
