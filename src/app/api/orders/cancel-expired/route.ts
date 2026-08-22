import { supabaseAdmin } from '@/lib/supabase';
import { serverEnv } from '@/lib/env';
import { ok, fail, withErrors, readJson } from '@/lib/api';

export const dynamic = 'force-dynamic';
// Vercel Cron invokes this with GET; keep the function warm enough to finish.
export const maxDuration = 30;

interface ExpiredOrder {
  order_id: string;
  product_id: string | null;
  amount: number;
  created_at: string;
}

/**
 * Release stock held by orders abandoned in `reserved`.
 *
 * The whole sweep is one call to cancel_expired_orders(), a plpgsql function
 * that claims the expired rows by flipping their status *first* and only then
 * credits stock back. Because the claim and the credit share a transaction,
 * two overlapping cron runs cannot release the same unit twice.
 */
async function sweep(minutes: number) {
  const { data, error } = await supabaseAdmin().rpc('cancel_expired_orders', {
    p_minutes: minutes,
  });

  if (error) {
    return {
      error:
        `Sweep failed: ${error.message}. ` +
        'Have you run supabase/schema.sql? It defines cancel_expired_orders().',
    };
  }

  const released = (data as ExpiredOrder[] | null) ?? [];
  return {
    result: {
      swept_at: new Date().toISOString(),
      older_than_minutes: minutes,
      cancelled_count: released.length,
      cancelled_orders: released,
    },
  };
}

/**
 * Authorisation.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically when
 * CRON_SECRET is set as a project env var. If CRON_SECRET is unset (local
 * dev) the endpoint is open so you can poke it from Postman.
 */
function authorised(req: Request): boolean {
  const { cronSecret } = serverEnv();
  if (!cronSecret) return true;
  const header = req.headers.get('authorization');
  return header === `Bearer ${cronSecret}`;
}

/** GET — this is the verb Vercel Cron uses. */
export const GET = withErrors(async (req: Request) => {
  if (!authorised(req)) {
    return fail('UNAUTHORIZED', 'Missing or incorrect CRON_SECRET bearer token.', 401);
  }
  const { reservationTtlMinutes } = serverEnv();
  const { result, error } = await sweep(reservationTtlMinutes);
  return error ? fail('INTERNAL_ERROR', error, 500) : ok(result!);
});

/**
 * POST — manual trigger. Optional body `{ "minutes": 0 }` lets you expire
 * everything immediately when testing, without waiting ten real minutes.
 */
export const POST = withErrors(async (req: Request) => {
  if (!authorised(req)) {
    return fail('UNAUTHORIZED', 'Missing or incorrect CRON_SECRET bearer token.', 401);
  }

  const body = await readJson(req);
  const { reservationTtlMinutes } = serverEnv();

  let minutes = reservationTtlMinutes;
  if (body.minutes !== undefined) {
    const parsed = Number(body.minutes);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return fail('VALIDATION_ERROR', 'minutes must be a non-negative number.', 400);
    }
    minutes = parsed;
  }

  const { result, error } = await sweep(minutes);
  return error ? fail('INTERNAL_ERROR', error, 500) : ok(result!);
});
