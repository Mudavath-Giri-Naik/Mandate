import { getAdminOverview } from '@/lib/data';
import { ok, fail, withErrors } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/overview
 * Everything the /admin dashboard renders, in one round trip.
 * No auth by design for this phase — do not ship this publicly as-is.
 */
export const GET = withErrors(async () => {
  const result = await getAdminOverview();
  if (!result.ok) return fail(result.code, result.message, 500);
  return ok(result.data);
});
