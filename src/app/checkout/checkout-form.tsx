'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import Script from 'next/script';
import { useRouter } from 'next/navigation';
import { formatPaise } from '@/lib/money';
import type { Product } from '@/lib/types';

type ProductDetail = Product & { in_stock: boolean };

/** Only the fields we actually pass to Checkout.js. */
interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  order_id: string;
  name: string;
  description: string;
  prefill: { name: string; email: string };
  theme?: { color: string };
  handler: (r: RazorpaySuccess) => void;
  modal?: { ondismiss: () => void };
}

interface RazorpaySuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open: () => void;
  on: (event: string, cb: (e: unknown) => void) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

type Stage = 'idle' | 'reserving' | 'awaiting_payment' | 'verifying';

export default function CheckoutForm({ product }: { product: ProductDetail }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [scriptReady, setScriptReady] = useState(false);

  const busy = stage !== 'idle';

  /**
   * Hand the payment result back to the server. The browser never decides
   * whether an order is paid — it only reports what Razorpay handed it, and
   * /api/orders/verify re-checks the HMAC before believing any of it.
   */
  async function settle(body: Record<string, unknown>, orderId: string) {
    setStage('verifying');
    try {
      await fetch('/api/orders/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // The confirmation page polls GET /api/orders/:id and the Razorpay
      // webhook is the server-side backstop, so a dropped verify call still
      // resolves. Send the customer there either way.
    }
    router.push(`/order/${orderId}`);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!window.Razorpay) {
      setError('Razorpay Checkout has not finished loading. Give it a second and try again.');
      return;
    }

    setStage('reserving');

    // --------------------------------- 1. reserve stock and create the order --
    let payload;
    try {
      const res = await fetch('/api/orders/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_id: product.id,
          customer_name: name,
          customer_email: email,
        }),
      });
      payload = await res.json();

      if (!res.ok || !payload.ok) {
        setStage('idle');
        setError(payload?.error?.message ?? `Checkout failed (HTTP ${res.status}).`);
        // Somebody took the last unit — pull fresh stock numbers.
        if (payload?.error?.code === 'OUT_OF_STOCK') router.refresh();
        return;
      }
    } catch {
      setStage('idle');
      setError('Could not reach the server. Check your connection and try again.');
      return;
    }

    const orderId: string = payload.data.order.id;
    const checkout = payload.data.checkout;

    if (!checkout.key) {
      setStage('idle');
      setError(
        'NEXT_PUBLIC_RAZORPAY_KEY_ID is not set, so the payment widget cannot open. ' +
          'Add it to .env.local and restart the dev server.',
      );
      return;
    }

    // ------------------------------------------ 2. open the Razorpay widget --
    setStage('awaiting_payment');

    const rzp = new window.Razorpay({
      key: checkout.key,
      amount: checkout.amount,
      currency: checkout.currency,
      order_id: checkout.order_id,
      name: checkout.name,
      description: checkout.description,
      prefill: checkout.prefill,
      theme: { color: '#1c1917' },
      handler: (response) =>
        settle(
          {
            order_id: orderId,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
          },
          orderId,
        ),
      modal: {
        // Customer closed the widget — release the reservation now rather
        // than making the next buyer wait for the expiry sweeper.
        ondismiss: () => void settle({ order_id: orderId, failed: true }, orderId),
      },
    });

    rzp.on('payment.failed', () => void settle({ order_id: orderId, failed: true }, orderId));
    rzp.open();
  }

  const stageLabel: Record<Stage, string> = {
    idle: `Pay ${formatPaise(product.price)}`,
    reserving: 'Reserving your item…',
    awaiting_payment: 'Waiting for payment…',
    verifying: 'Verifying payment…',
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <Script
        src="https://checkout.razorpay.com/v1/checkout.js"
        onLoad={() => setScriptReady(true)}
        onReady={() => setScriptReady(true)}
      />

      <Link
        href={`/product/${product.id}`}
        className="text-sm text-muted transition hover:text-foreground"
      >
        ← Back to product
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Checkout</h1>

      <div className="mt-8 grid gap-10 md:grid-cols-[1fr_320px]">
        {/* ----------------------------------------------------------- form -- */}
        <form onSubmit={handleSubmit} className="rounded-xl border border-line bg-surface p-6">
          <h2 className="text-sm font-semibold">Your details</h2>

          <label className="mt-5 block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Full name</span>
            <input
              type="text"
              required
              minLength={2}
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              placeholder="Asha Menon"
              className="w-full rounded-md border border-line px-3 py-2 text-sm disabled:bg-stone-50"
            />
          </label>

          <label className="mt-4 block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Email</span>
            <input
              type="email"
              required
              value={email}
              disabled={busy}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="asha@example.com"
              className="w-full rounded-md border border-line px-3 py-2 text-sm disabled:bg-stone-50"
            />
            <span className="mt-1.5 block text-xs text-muted">
              Your order confirmation link is tied to this address.
            </span>
          </label>

          {error && (
            <div className="mt-5 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy || !product.in_stock || !scriptReady}
            className="mt-6 w-full rounded-md bg-stone-900 px-6 py-3 text-sm font-medium text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:bg-stone-300"
          >
            {!product.in_stock
              ? 'Sold out'
              : !scriptReady
                ? 'Loading payment…'
                : stageLabel[stage]}
          </button>

          <p className="mt-4 text-xs leading-relaxed text-muted">
            <strong>Test mode.</strong> Card{' '}
            <code className="font-mono">4111 1111 1111 1111</code> with any future expiry and any
            CVV, or UPI id <code className="font-mono">success@razorpay</code>. Use{' '}
            <code className="font-mono">failure@razorpay</code> to test the failure path.
          </p>
        </form>

        {/* -------------------------------------------------------- summary -- */}
        <aside className="h-fit rounded-xl border border-line bg-surface p-6">
          <h2 className="text-sm font-semibold">Order summary</h2>

          <div className="mt-4 flex gap-4">
            <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-md bg-stone-100">
              {product.image_url && (
                <Image
                  src={product.image_url}
                  alt={product.name}
                  fill
                  sizes="80px"
                  className="object-cover"
                />
              )}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium leading-snug">{product.name}</p>
              <p className="mt-1 text-xs text-muted">
                {[product.size, product.color].filter(Boolean).join(' · ')}
              </p>
              <p className="mt-1 text-xs text-muted">Qty 1</p>
            </div>
          </div>

          <dl className="mt-5 space-y-2 border-t border-line pt-5 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">Subtotal</dt>
              <dd>{formatPaise(product.price)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Shipping</dt>
              <dd>Free</dd>
            </div>
            <div className="flex justify-between border-t border-line pt-3 text-base font-semibold">
              <dt>Total</dt>
              <dd>{formatPaise(product.price)}</dd>
            </div>
          </dl>

          <p className="mt-5 text-xs leading-relaxed text-muted">
            Pressing pay reserves one unit immediately. Closing the payment window releases it
            straight away, and any reservation that slips through is swept after 10 minutes.
          </p>
        </aside>
      </div>
    </div>
  );
}
