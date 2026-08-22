import { supabaseAdmin } from './supabase';
import type { Product, OrderWithProduct } from './types';
import type { ApiError } from './api';

/**
 * The read layer, shared by the API routes and the server components.
 *
 * Both entry points call these same functions. The routes wrap the result in
 * HTTP; the pages render it. There is exactly one implementation of each
 * query, so the two can never drift.
 *
 * Pages used to reach their own /api routes over HTTP instead. That worked
 * locally and broke on Vercel: a server-side request back to the deployment
 * can be answered with an HTML page rather than JSON — Deployment Protection's
 * SSO interstitial, or a mis-resolved origin behind the proxy — and the page
 * died on `Unexpected token '<'`. A function call cannot fail that way.
 */

export type DataResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ApiError; message: string };

const fail = <T>(code: ApiError, message: string): DataResult<T> => ({
  ok: false,
  code,
  message,
});

/**
 * Run a query, converting the two failures every caller must handle —
 * missing configuration and a dead database — into a result rather than a
 * throw. Pages render these as notices; routes turn them into 500s.
 */
async function guard<T>(fn: () => Promise<DataResult<T>>): Promise<DataResult<T>> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Missing environment variable')) {
      return fail('CONFIGURATION_ERROR', message);
    }
    console.error('[data]', err);
    return fail('INTERNAL_ERROR', message);
  }
}

// =================================================================== products ==

export interface ProductFilters {
  size?: string | null;
  color?: string | null;
  /** Paise, inclusive. */
  maxPrice?: number | null;
  includeSoldOut?: boolean;
}

export async function listProducts(
  filters: ProductFilters = {},
): Promise<DataResult<Product[]>> {
  return guard(async () => {
    let query = supabaseAdmin()
      .from('products')
      .select('*')
      // All seed rows share a created_at, so without a tiebreaker the order
      // shuffles between requests. id keeps the grid stable.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });

    if (!filters.includeSoldOut) {
      query = query.gt('stock_count', 0).neq('status', 'sold_out');
    }
    if (filters.size) query = query.ilike('size', filters.size);
    if (filters.color) query = query.ilike('color', filters.color);
    if (filters.maxPrice != null) query = query.lte('price', filters.maxPrice);

    const { data, error } = await query;
    if (error) return fail<Product[]>('INTERNAL_ERROR', error.message);
    return { ok: true, data: (data ?? []) as Product[] };
  });
}

export type ProductDetail = Product & { in_stock: boolean };

export async function getProduct(id: string): Promise<DataResult<ProductDetail>> {
  return guard(async () => {
    const { data, error } = await supabaseAdmin()
      .from('products')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) return fail<ProductDetail>('INTERNAL_ERROR', error.message);
    if (!data) return fail<ProductDetail>('NOT_FOUND', `No product with id ${id}.`);

    const product = data as Product;
    return {
      ok: true,
      data: {
        ...product,
        in_stock: product.stock_count > 0 && product.status !== 'sold_out',
      },
    };
  });
}

// ===================================================================== orders ==

export type OrderDetail = OrderWithProduct & {
  is_settled: boolean;
  is_paid: boolean;
};

export async function getOrder(id: string): Promise<DataResult<OrderDetail>> {
  return guard(async () => {
    const { data, error } = await supabaseAdmin()
      .from('orders')
      .select('*, product:products(id, name, size, color, image_url)')
      .eq('id', id)
      .maybeSingle();

    if (error) return fail<OrderDetail>('INTERNAL_ERROR', error.message);
    if (!data) return fail<OrderDetail>('NOT_FOUND', `No order with id ${id}.`);

    const order = data as OrderWithProduct;
    return {
      ok: true,
      data: {
        ...order,
        // Convenience flags so a poller need not know the state machine.
        is_settled: ['paid', 'failed', 'cancelled'].includes(order.status),
        is_paid: order.status === 'paid',
      },
    };
  });
}

// ====================================================================== admin ==

export interface AdminOverview {
  stats: {
    total_products: number;
    total_stock: number;
    sold_out_products: number;
    total_orders: number;
    orders_by_status: Record<string, number>;
    revenue_paise: number;
  };
  products: Product[];
  orders: OrderWithProduct[];
}

export async function getAdminOverview(): Promise<DataResult<AdminOverview>> {
  return guard(async () => {
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

    if (productsRes.error) return fail<AdminOverview>('INTERNAL_ERROR', productsRes.error.message);
    if (ordersRes.error) return fail<AdminOverview>('INTERNAL_ERROR', ordersRes.error.message);

    const products = (productsRes.data ?? []) as Product[];
    const orders = (ordersRes.data ?? []) as OrderWithProduct[];
    const countBy = (status: string) => orders.filter((o) => o.status === status).length;

    return {
      ok: true,
      data: {
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
      },
    };
  });
}
