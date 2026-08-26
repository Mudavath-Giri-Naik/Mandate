/**
 * The Discovery Service lives in a separate deployment (the Parley repo). This
 * storefront does not reimplement any of it — it points at it.
 *
 * Two things are wired through here:
 *
 *   - `/.well-known/ucp`, which a UCP-aware agent fetches at the apex of *this*
 *     domain. It is proxied, never redirected: some platform fetchers refuse to
 *     follow a cross-origin 3xx on a well-known path, and a redirect there fails
 *     silently rather than loudly.
 *   - the `Product` JSON-LD embedded in each product page, read per render from
 *     the service so the markup can never drift from the catalogue behind it.
 *
 * There is no hardcoded fallback URL. A wrong-but-plausible default would make a
 * misconfigured deployment look wired up while serving an agent nothing.
 */

export const DISCOVERY_SERVICE_URL_VAR = 'DISCOVERY_SERVICE_URL';

/** The service's base origin, or null when it has not been configured. */
export function discoveryBaseUrl(): string | null {
  const raw = process.env[DISCOVERY_SERVICE_URL_VAR]?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

/** How long to wait on the service before giving up on it. */
const TIMEOUT_MS = 8_000;

export async function fetchFromDiscovery(path: string): Promise<Response> {
  const base = discoveryBaseUrl();
  if (!base) {
    throw new Error(
      `Missing environment variable ${DISCOVERY_SERVICE_URL_VAR}. Set it to the ` +
        'origin of the deployed Discovery Service, e.g. https://parley.example.com.',
    );
  }
  return fetch(`${base}${path}`, {
    // Agents read this for a live answer; a cached one can be wrong about stock.
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** schema.org `Product` markup for one product id, or null if unavailable. */
export async function getProductJsonLd(id: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchFromDiscovery(`/api/discovery/jsonld/${encodeURIComponent(id)}`);
    if (!res.ok) {
      console.error(`[discovery] jsonld ${id} -> ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { jsonld?: Record<string, unknown> };
    return body.jsonld ?? null;
  } catch (err) {
    // A product page must render whether or not the Discovery Service answers.
    console.error('[discovery] jsonld', err);
    return null;
  }
}
