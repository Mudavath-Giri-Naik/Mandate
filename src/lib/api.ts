import { NextResponse } from 'next/server';

/**
 * One response shape for every route, so Postman (and later the agent layer)
 * never has to guess:
 *
 *   success → { ok: true,  data: <payload> }
 *   failure → { ok: false, error: { code, message, details? } }
 */

export type ApiError =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'OUT_OF_STOCK'
  | 'INVALID_SIGNATURE'
  | 'ORDER_STATE_CONFLICT'
  | 'UNAUTHORIZED'
  | 'PAYMENT_GATEWAY_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'INTERNAL_ERROR';

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ ok: true as const, data }, { status });
}

export function fail(
  code: ApiError,
  message: string,
  status: number,
  details?: unknown,
) {
  return NextResponse.json(
    { ok: false as const, error: { code, message, ...(details ? { details } : {}) } },
    { status },
  );
}

/**
 * Wrap a handler so an unexpected throw becomes a JSON 500 rather than an
 * HTML error page — Postman clients should always get parseable JSON back.
 * Missing env vars are surfaced distinctly, since that is the most likely
 * first-run failure.
 */
export function withErrors<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
) {
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('Missing environment variable')) {
        console.error('[config]', message);
        return fail('CONFIGURATION_ERROR', message, 500);
      }
      console.error('[api]', err);
      return fail('INTERNAL_ERROR', 'Something went wrong handling this request.', 500, {
        message,
      });
    }
  };
}

/** Parse a JSON body, tolerating an empty or malformed one. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && UUID_RE.test(v);

export const isEmail = (v: unknown): v is string =>
  typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
