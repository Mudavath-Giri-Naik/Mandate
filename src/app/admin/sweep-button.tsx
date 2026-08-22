'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Manual trigger for the expiry sweeper, so you do not have to wait ten real
 * minutes to watch abandoned reservations return to stock. Sends
 * `{ minutes: 0 }`, which expires every currently-reserved order.
 */
export default function SweepButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function sweep() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/orders/cancel-expired', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes: 0 }),
      });
      const payload = await res.json();
      setResult(
        payload.ok
          ? `Released ${payload.data.cancelled_count} reservation(s).`
          : (payload.error?.message ?? 'Sweep failed.'),
      );
      router.refresh();
    } catch {
      setResult('Could not reach the sweeper endpoint.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-right">
      <div className="flex gap-2">
        <button
          onClick={() => router.refresh()}
          className="rounded-md border border-line bg-surface px-4 py-2 text-sm text-muted transition hover:text-foreground"
        >
          Refresh
        </button>
        <button
          onClick={sweep}
          disabled={busy}
          className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-700 disabled:bg-stone-300"
        >
          {busy ? 'Sweeping…' : 'Expire reservations now'}
        </button>
      </div>
      {result && <p className="mt-2 text-xs text-muted">{result}</p>}
    </div>
  );
}
