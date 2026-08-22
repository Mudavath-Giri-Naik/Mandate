import { headers } from 'next/headers';

/**
 * Call our own API routes from a server component.
 *
 * The pages deliberately go through HTTP rather than querying Supabase
 * inline: the API routes are the contract the future agent layer will use, so
 * the storefront exercises exactly the same surface. If a page renders, that
 * route works.
 */
export async function apiBaseUrl(): Promise<string> {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;

  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const base = await apiBaseUrl();
  try {
    const res = await fetch(`${base}${path}`, { cache: 'no-store' });
    return (await res.json()) as ApiResult<T>;
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'FETCH_FAILED',
        message: err instanceof Error ? err.message : 'Could not reach the API.',
      },
    };
  }
}
