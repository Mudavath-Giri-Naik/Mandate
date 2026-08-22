import { supabaseAdmin } from '@/lib/supabase';
import { ok, fail, withErrors, isUuid } from '@/lib/api';
import type { OrderWithProduct } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/orders/:id
 * Current status of one order, for the confirmation page to poll.
 */
export const GET = withErrors(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    if (!isUuid(id)) {
      return fail('VALIDATION_ERROR', `"${id}" is not a valid order id.`, 400);
    }

    const { data, error } = await supabaseAdmin()
      .from('orders')
      .select('*, product:products(id, name, size, color, image_url)')
      .eq('id', id)
      .maybeSingle();

    if (error) return fail('INTERNAL_ERROR', error.message, 500);
    if (!data) return fail('NOT_FOUND', `No order with id ${id}.`, 404);

    const order = data as OrderWithProduct;
    return ok({
      ...order,
      // Convenience flags so a poller does not have to know the state machine.
      is_settled: ['paid', 'failed', 'cancelled'].includes(order.status),
      is_paid: order.status === 'paid',
    });
  },
);
