'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { formatPaise } from '@/lib/money';
import { StatusPill } from '@/components/ui';
import type { OrderWithProduct } from '@/lib/types';

type OrderPayload = OrderWithProduct & { is_settled: boolean; is_paid: boolean };

/**
 * Confirmation screen.
 *
 * An order can still be `reserved` when the customer lands here — the browser
 * verify call and the Razorpay webhook race each other, and either may win.
 * So we poll GET /api/orders/:id until the order settles, then stop.
 */
export default function OrderStatusView({ initialOrder }: { initialOrder: OrderPayload }) {
  const [order, setOrder] = useState<OrderPayload>(initialOrder);

  useEffect(() => {
    if (order.is_settled) return;

    let cancelled = false;
    let attempts = 0;

    const timer = setInterval(async () => {
      attempts += 1;
      // ~2 minutes of polling. After that the expiry sweeper owns the outcome.
      if (attempts > 40) {
        clearInterval(timer);
        return;
      }
      try {
        const res = await fetch(`/api/orders/${order.id}`, { cache: 'no-store' });
        const payload = await res.json();
        if (!cancelled && payload.ok) {
          setOrder(payload.data);
          if (payload.data.is_settled) clearInterval(timer);
        }
      } catch {
        // Transient — the next tick retries.
      }
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [order.id, order.is_settled]);

  const presentation = {
    paid: {
      icon: '✓',
      ring: 'bg-emerald-100 text-emerald-700',
      title: 'Payment successful',
      body: 'Your order is confirmed. A unit has been permanently deducted from stock.',
    },
    reserved: {
      icon: '⏳',
      ring: 'bg-amber-100 text-amber-700',
      title: 'Confirming your payment',
      body: 'Your item is reserved while we verify the payment with Razorpay. This page updates itself.',
    },
    created: {
      icon: '⏳',
      ring: 'bg-stone-200 text-stone-600',
      title: 'Order created',
      body: 'Waiting for payment to begin.',
    },
    failed: {
      icon: '✕',
      ring: 'bg-red-100 text-red-700',
      title: 'Payment not completed',
      body: 'Nothing was charged and the item has been returned to stock. You are welcome to try again.',
    },
    cancelled: {
      icon: '✕',
      ring: 'bg-stone-200 text-stone-600',
      title: 'Reservation expired',
      body: 'Payment was not completed in time, so the item was released back to stock.',
    },
  }[order.status];

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <div className="rounded-xl border border-line bg-surface p-8">
        <div className="flex items-start gap-4">
          <div
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-xl ${presentation.ring}`}
          >
            {presentation.icon}
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{presentation.title}</h1>
            <p className="mt-1.5 text-sm text-muted">{presentation.body}</p>
          </div>
        </div>

        {order.product && (
          <div className="mt-8 flex gap-4 border-t border-line pt-6">
            <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-md bg-stone-100">
              {order.product.image_url && (
                <Image
                  src={order.product.image_url}
                  alt={order.product.name}
                  fill
                  sizes="96px"
                  className="object-cover"
                />
              )}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">{order.product.name}</p>
              <p className="mt-1 text-xs text-muted">
                {[order.product.size, order.product.color].filter(Boolean).join(' · ')}
              </p>
              <p className="mt-2 text-sm font-semibold">{formatPaise(order.amount)}</p>
            </div>
          </div>
        )}

        <dl className="mt-6 space-y-3 border-t border-line pt-6 text-sm">
          <Row label="Status">
            <StatusPill status={order.status} />
          </Row>
          <Row label="Order id">
            <code className="font-mono text-xs break-all">{order.id}</code>
          </Row>
          {order.razorpay_order_id && (
            <Row label="Razorpay order">
              <code className="font-mono text-xs break-all">{order.razorpay_order_id}</code>
            </Row>
          )}
          {order.razorpay_payment_id && (
            <Row label="Payment id">
              <code className="font-mono text-xs break-all">{order.razorpay_payment_id}</code>
            </Row>
          )}
          <Row label="Customer">
            <span className="text-right">
              {order.customer_name}
              <br />
              <span className="text-muted">{order.customer_email}</span>
            </span>
          </Row>
          <Row label="Placed">
            <span>{new Date(order.created_at).toLocaleString('en-IN')}</span>
          </Row>
        </dl>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/"
            className="rounded-md bg-stone-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-stone-700"
          >
            Continue shopping
          </Link>
          <Link
            href="/admin"
            className="rounded-md border border-line px-5 py-2.5 text-sm text-muted transition hover:text-foreground"
          >
            View in admin
          </Link>
        </div>
      </div>

      <p className="mt-4 text-center text-xs text-muted">
        Poll this order directly:{' '}
        <code className="font-mono">GET /api/orders/{order.id}</code>
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
