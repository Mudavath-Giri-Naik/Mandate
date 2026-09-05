'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Manual top-up so you do not have to hand-edit the products table after
 * testing runs stock down to sold-out. Sets every product to 50 units and
 * 'available'.
 */
export default function RestockButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function restock() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/products/restock', { method: 'POST' });
      const payload = await res.json();
      setResult(
        payload.ok
          ? `Restocked ${payload.data.products_updated} product(s) to ${payload.data.stock_count} units.`
          : (payload.error?.message ?? 'Restock failed.'),
      );
      router.refresh();
    } catch {
      setResult('Could not reach the restock endpoint.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={restock}
      disabled={busy}
      className="rounded-md border border-line bg-surface px-4 py-2 text-sm font-medium text-foreground transition hover:bg-stone-100 disabled:text-muted"
    >
      {busy ? 'Restocking…' : 'Restock all products'}
    </button>
  );
}
