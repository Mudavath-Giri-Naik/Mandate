import Link from 'next/link';
import { getAdminOverview } from '@/lib/data';
import { formatPaise } from '@/lib/money';
import { StatusPill, ErrorNotice, SetupNotice } from '@/components/ui';
import SweepButton from './sweep-button';
import RestockButton from './restock-button';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const result = await getAdminOverview();

  if (!result.ok) {
    return (
      <div className="mx-auto max-w-xl px-6 py-12">
        {result.code === 'CONFIGURATION_ERROR' ? (
          <SetupNotice message={result.message} />
        ) : (
          <ErrorNotice title="Could not load the dashboard" message={result.message} />
        )}
      </div>
    );
  }

  const { stats, products, orders } = result.data;

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
          <p className="mt-1 text-sm text-muted">
            Live stock and order state. No auth on this page — testing only.
          </p>
        </div>
        <div className="flex items-start gap-2">
          <RestockButton />
          <SweepButton />
        </div>
      </div>

      {/* -------------------------------------------------------------- stats -- */}
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Products" value={String(stats.total_products)} />
        <Stat label="Units in stock" value={String(stats.total_stock)} />
        <Stat label="Sold out" value={String(stats.sold_out_products)} />
        <Stat label="Orders" value={String(stats.total_orders)} />
        <Stat label="Revenue (paid)" value={formatPaise(stats.revenue_paise)} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        {Object.entries(stats.orders_by_status).map(([status, count]) => (
          <span
            key={status}
            className="rounded-full border border-line bg-surface px-3 py-1 text-muted"
          >
            {status}: <strong className="text-foreground">{count}</strong>
          </span>
        ))}
      </div>

      {/* ----------------------------------------------------------- products -- */}
      <h2 className="mt-12 text-lg font-semibold tracking-tight">Products</h2>
      <div className="mt-4 overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="border-b border-line bg-stone-50 text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <Th>Name</Th>
              <Th>Size</Th>
              <Th>Colour</Th>
              <Th className="text-right">Price</Th>
              <Th className="text-right">Stock</Th>
              <Th>Status</Th>
              <Th>Id</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {products.map((p) => (
              <tr key={p.id} className={p.stock_count === 0 ? 'bg-red-50/40' : undefined}>
                <Td className="font-medium">{p.name}</Td>
                <Td>{p.size ?? '—'}</Td>
                <Td>{p.color ?? '—'}</Td>
                <Td className="text-right tabular-nums">{formatPaise(p.price)}</Td>
                <Td
                  className={`text-right tabular-nums ${
                    p.stock_count === 0
                      ? 'font-semibold text-red-700'
                      : p.stock_count <= 3
                        ? 'font-medium text-amber-700'
                        : ''
                  }`}
                >
                  {p.stock_count}
                </Td>
                <Td>
                  <StatusPill status={p.status} />
                </Td>
                <Td>
                  <code className="font-mono text-[11px] text-muted">{p.id}</code>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ------------------------------------------------------------- orders -- */}
      <h2 className="mt-12 text-lg font-semibold tracking-tight">Orders</h2>
      {orders.length === 0 ? (
        <p className="mt-4 rounded-xl border border-line bg-surface p-10 text-center text-sm text-muted">
          No orders yet. Buy something, or POST to{' '}
          <code className="font-mono">/api/orders/create</code>.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[960px] text-sm">
            <thead className="border-b border-line bg-stone-50 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <Th>Placed</Th>
                <Th>Customer</Th>
                <Th>Product</Th>
                <Th className="text-right">Amount</Th>
                <Th>Status</Th>
                <Th>Razorpay</Th>
                <Th>Order id</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {orders.map((o) => (
                <tr key={o.id}>
                  <Td className="whitespace-nowrap text-muted">
                    {new Date(o.created_at).toLocaleString('en-IN')}
                  </Td>
                  <Td>
                    <span className="font-medium">{o.customer_name ?? '—'}</span>
                    <br />
                    <span className="text-xs text-muted">{o.customer_email ?? '—'}</span>
                  </Td>
                  <Td>
                    {o.product ? (
                      <Link href={`/product/${o.product.id}`} className="hover:underline">
                        {o.product.name}
                        <span className="block text-xs text-muted">
                          {[o.product.size, o.product.color].filter(Boolean).join(' · ')}
                        </span>
                      </Link>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">{formatPaise(o.amount)}</Td>
                  <Td>
                    <StatusPill status={o.status} />
                  </Td>
                  <Td>
                    <code className="block font-mono text-[11px] text-muted">
                      {o.razorpay_order_id ?? '—'}
                    </code>
                    <code className="block font-mono text-[11px] text-muted">
                      {o.razorpay_payment_id ?? '—'}
                    </code>
                  </Td>
                  <Td>
                    <Link href={`/order/${o.id}`}>
                      <code className="font-mono text-[11px] text-muted hover:underline">
                        {o.id}
                      </code>
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-3 font-medium ${className}`}>{children}</th>;
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top ${className}`}>{children}</td>;
}
