'use client';

import { useCallback, useEffect, useState } from 'react';

type Endpoint = {
  method: 'GET' | 'POST';
  path: string;
  title: string;
  description: string;
  /** Safe to call automatically for a health check (read-only). */
  check?: boolean;
  /** Example JSON body, for POST endpoints. */
  body?: string;
};

type Group = { name: string; endpoints: Endpoint[] };

const SAMPLE_PRODUCT = ':product_id';
const SAMPLE_ORDER = ':order_id';

const GROUPS: Group[] = [
  {
    name: 'Products',
    endpoints: [
      {
        method: 'GET',
        path: '/api/products',
        title: 'List / search products',
        description: 'Buyable products only (in stock). Add include_sold_out=true for all.',
        check: true,
      },
      {
        method: 'GET',
        path: '/api/products?size=M&color=Black&max_price=200000',
        title: 'Search products with filters',
        description: 'Filters: size, color (case-insensitive), max_price in paise (₹499 = 49900).',
        check: true,
      },
      {
        method: 'GET',
        path: `/api/products/${SAMPLE_PRODUCT}`,
        title: 'Product detail',
        description: 'One product with live stock_count. Replace :product_id with a product UUID.',
        check: true,
      },
      {
        method: 'POST',
        path: '/api/products/restock',
        title: 'Restock all products',
        description: 'Admin/testing: sets every product to 50 units and available.',
      },
    ],
  },
  {
    name: 'Orders',
    endpoints: [
      {
        method: 'GET',
        path: `/api/orders/${SAMPLE_ORDER}`,
        title: 'Order status',
        description: 'Current status of one order. Replace :order_id with an order UUID.',
      },
      {
        method: 'POST',
        path: '/api/orders',
        title: 'Place order (programmatic / agents)',
        description: 'Reserves stock and creates a Razorpay order. All amounts in paise.',
        body: JSON.stringify(
          {
            product_id: '<product uuid>',
            customer_name: 'Jane Doe',
            customer_email: 'jane@example.com',
            quantity: 1,
            discount_percent: 0,
          },
          null,
          2,
        ),
      },
      {
        method: 'POST',
        path: '/api/orders/create',
        title: 'Place order (storefront checkout)',
        description: 'One unit, no discount; returns Checkout.js options.',
        body: JSON.stringify(
          {
            product_id: '<product uuid>',
            customer_name: 'Jane Doe',
            customer_email: 'jane@example.com',
          },
          null,
          2,
        ),
      },
      {
        method: 'POST',
        path: '/api/orders/verify',
        title: 'Verify payment',
        description: 'Confirms a Razorpay payment signature for an order.',
      },
      {
        method: 'POST',
        path: '/api/orders/webhook',
        title: 'Razorpay webhook',
        description: 'Server-to-server payment events from Razorpay.',
      },
      {
        method: 'GET',
        path: '/api/orders/cancel-expired',
        title: 'Cancel expired reservations',
        description: 'Releases stock held by unpaid orders (cron). Also accepts POST.',
      },
    ],
  },
  {
    name: 'Admin & discovery',
    endpoints: [
      {
        method: 'GET',
        path: '/api/admin/overview',
        title: 'Admin overview',
        description: 'Stats, all products and recent orders.',
        check: true,
      },
      {
        method: 'GET',
        path: '/.well-known/ucp',
        title: 'UCP business profile',
        description: 'Discovery profile for agents, proxied from the Discovery Service.',
        check: true,
      },
    ],
  },
];

type Health = { state: 'idle' | 'checking' } | { state: 'up' | 'down'; status: number; ms: number };

function resolvePath(path: string, productId: string | null) {
  if (path.includes(SAMPLE_PRODUCT)) return productId ? path.replace(SAMPLE_PRODUCT, productId) : null;
  return path;
}

export default function EndpointsView() {
  const [origin, setOrigin] = useState('');
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => setOrigin(window.location.origin), []);

  const checkAll = useCallback(async () => {
    const checkable = GROUPS.flatMap((g) => g.endpoints).filter((e) => e.check);
    setHealth(Object.fromEntries(checkable.map((e) => [e.path, { state: 'checking' } as Health])));

    // Product-detail check needs a real id; take the first one from the list.
    let productId: string | null = null;
    try {
      const res = await fetch('/api/products?include_sold_out=true', { cache: 'no-store' });
      const json = await res.json();
      productId = json?.data?.products?.[0]?.id ?? null;
    } catch {}

    await Promise.all(
      checkable.map(async (e) => {
        const target = resolvePath(e.path, productId);
        if (!target) {
          setHealth((h) => ({ ...h, [e.path]: { state: 'down', status: 0, ms: 0 } }));
          return;
        }
        const t0 = performance.now();
        try {
          const res = await fetch(target, { cache: 'no-store' });
          setHealth((h) => ({
            ...h,
            [e.path]: { state: res.ok ? 'up' : 'down', status: res.status, ms: Math.round(performance.now() - t0) },
          }));
        } catch {
          setHealth((h) => ({ ...h, [e.path]: { state: 'down', status: 0, ms: 0 } }));
        }
      }),
    );
  }, []);

  useEffect(() => {
    checkAll();
  }, [checkAll]);

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {}
  }

  const allUrls = GROUPS.flatMap((g) => g.endpoints)
    .map((e) => `${e.method} ${origin}${e.path}`)
    .join('\n');

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Endpoints</h1>
          <p className="mt-1 text-sm text-muted">
            Copy any endpoint and check its health. Base URL:{' '}
            <code className="font-mono">{origin || '…'}</code>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => copy('all', allUrls)}
            className="rounded-md border border-line bg-surface px-4 py-2 text-sm font-medium transition hover:bg-stone-100"
          >
            {copied === 'all' ? 'Copied!' : 'Copy all'}
          </button>
          <button
            onClick={checkAll}
            className="rounded-md border border-line bg-surface px-4 py-2 text-sm font-medium transition hover:bg-stone-100"
          >
            Check health
          </button>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">
        Health checks only call read-only GET endpoints. POST endpoints are listed for copying and are never called from this page.
      </p>

      {GROUPS.map((group) => (
        <section key={group.name} className="mt-10">
          <h2 className="text-lg font-semibold tracking-tight">{group.name}</h2>
          <div className="mt-4 divide-y divide-stone-100 rounded-xl border border-line bg-surface">
            {group.endpoints.map((e) => {
              const url = `${origin}${e.path}`;
              const h = health[e.path];
              return (
                <div key={e.method + e.path} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">{e.title}</p>
                    <HealthBadge check={e.check} health={h} />
                  </div>
                  <p className="mt-1 text-xs text-muted">{e.description}</p>
                  <div className="mt-3 flex items-center gap-2">
                    <span
                      className={`rounded px-2 py-1 text-[11px] font-semibold ${
                        e.method === 'GET' ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'
                      }`}
                    >
                      {e.method}
                    </span>
                    <code className="min-w-0 flex-1 break-all rounded bg-stone-50 px-2 py-1 font-mono text-xs">
                      {url}
                    </code>
                    <button
                      onClick={() => copy(e.method + e.path, url)}
                      className="shrink-0 rounded-md border border-line px-3 py-1 text-xs font-medium hover:bg-stone-100"
                    >
                      {copied === e.method + e.path ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  {e.body && (
                    <div className="mt-2 flex items-start gap-2">
                      <pre className="min-w-0 flex-1 overflow-x-auto rounded bg-stone-50 p-2 font-mono text-[11px]">
                        {e.body}
                      </pre>
                      <button
                        onClick={() => copy('body' + e.path, e.body!)}
                        className="shrink-0 rounded-md border border-line px-3 py-1 text-xs font-medium hover:bg-stone-100"
                      >
                        {copied === 'body' + e.path ? 'Copied!' : 'Copy body'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function HealthBadge({ check, health }: { check?: boolean; health?: Health }) {
  if (!check) return <span className="text-xs text-muted">Not auto-checked</span>;
  if (!health || health.state === 'idle') return <span className="text-xs text-muted">—</span>;
  if (health.state === 'checking') return <span className="text-xs text-muted">Checking…</span>;
  const up = health.state === 'up';
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
        up ? 'bg-emerald-100 text-emerald-900' : 'bg-red-100 text-red-800'
      }`}
    >
      {up ? `Healthy · ${health.status} · ${health.ms}ms` : `Down${health.status ? ` · ${health.status}` : ''}`}
    </span>
  );
}
