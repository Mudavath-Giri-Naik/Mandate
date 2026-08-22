import { getOrder } from '@/lib/data';
import { ok, fail, withErrors, isUuid } from '@/lib/api';

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

    const result = await getOrder(id);
    if (!result.ok) {
      return fail(result.code, result.message, result.code === 'NOT_FOUND' ? 404 : 500);
    }

    return ok(result.data);
  },
);
