import type { OrderStatus, ProductStatus } from '@/lib/types';

export function StatusPill({ status }: { status: OrderStatus | ProductStatus }) {
  const styles: Record<string, string> = {
    paid: 'bg-emerald-100 text-emerald-800',
    reserved: 'bg-amber-100 text-amber-900',
    created: 'bg-stone-200 text-stone-700',
    failed: 'bg-red-100 text-red-800',
    cancelled: 'bg-stone-200 text-stone-600',
    available: 'bg-emerald-100 text-emerald-800',
    sold_out: 'bg-red-100 text-red-800',
  };
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
        styles[status] ?? 'bg-stone-200 text-stone-700'
      }`}
    >
      {status.replace('_', ' ')}
    </span>
  );
}

export function ErrorNotice({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm">
      <p className="font-semibold text-red-900">{title}</p>
      <p className="mt-1 whitespace-pre-wrap text-red-800">{message}</p>
    </div>
  );
}

export function SetupNotice({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-6 text-sm">
      <p className="font-semibold text-amber-900">Not configured yet</p>
      <p className="mt-1 text-amber-900">{message}</p>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-amber-900">
        <li>
          Copy <code className="font-mono">.env.example</code> to{' '}
          <code className="font-mono">.env.local</code> and fill in your Supabase and
          Razorpay test keys.
        </li>
        <li>
          Run <code className="font-mono">supabase/schema.sql</code> then{' '}
          <code className="font-mono">supabase/seed.sql</code> in the Supabase SQL Editor.
        </li>
        <li>Restart the dev server.</li>
      </ol>
    </div>
  );
}
