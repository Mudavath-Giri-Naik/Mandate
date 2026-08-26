import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProduct } from '@/lib/data';
import { getProductJsonLd } from '@/lib/discovery';
import { formatPaise } from '@/lib/money';
import { ErrorNotice, SetupNotice } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function ProductPage({ params }: PageProps<'/product/[id]'>) {
  const { id } = await params;

  // Both reads describe the same product and neither depends on the other, so
  // they go out together. The JSON-LD is fetched here, at render time, rather
  // than injected in the browser: a crawler that does not run scripts has to
  // find the markup in the initial HTML or it finds nothing at all.
  const [result, jsonLd] = await Promise.all([getProduct(id), getProductJsonLd(id)]);

  if (!result.ok) {
    if (result.code === 'NOT_FOUND') notFound();
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        {result.code === 'CONFIGURATION_ERROR' ? (
          <SetupNotice message={result.message} />
        ) : (
          <ErrorNotice title="Could not load this product" message={result.message} />
        )}
      </div>
    );
  }

  const p = result.data;

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      {jsonLd && (
        <script
          type="application/ld+json"
          // Server-rendered from the Discovery Service's own markup for this id.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      )}

      <Link href="/" className="text-sm text-muted transition hover:text-foreground">
        ← Back to shop
      </Link>

      <div className="mt-6 grid gap-10 md:grid-cols-2">
        <div className="relative aspect-square overflow-hidden rounded-xl border border-line bg-stone-100">
          {p.image_url && (
            <Image
              src={p.image_url}
              alt={p.name}
              fill
              sizes="(max-width: 768px) 100vw, 50vw"
              className="object-cover"
              priority
            />
          )}
        </div>

        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
          <p className="mt-3 text-2xl font-semibold">{formatPaise(p.price)}</p>

          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 border-y border-line py-5 text-sm">
            <dt className="text-muted">Size</dt>
            <dd>{p.size ?? '—'}</dd>
            <dt className="text-muted">Colour</dt>
            <dd>{p.color ?? '—'}</dd>
            <dt className="text-muted">In stock</dt>
            <dd className={p.stock_count <= 3 ? 'font-medium text-red-700' : ''}>
              {p.stock_count} unit{p.stock_count === 1 ? '' : 's'}
            </dd>
            <dt className="text-muted">Status</dt>
            <dd>{p.status.replace('_', ' ')}</dd>
          </dl>

          {p.description && (
            <p className="mt-5 text-sm leading-relaxed text-muted">{p.description}</p>
          )}

          <div className="mt-8">
            {p.in_stock ? (
              <Link
                href={`/checkout?product_id=${p.id}`}
                className="inline-block w-full rounded-md bg-stone-900 px-6 py-3 text-center text-sm font-medium text-white transition hover:bg-stone-700"
              >
                Buy Now — {formatPaise(p.price)}
              </Link>
            ) : (
              <button
                disabled
                className="w-full cursor-not-allowed rounded-md bg-stone-200 px-6 py-3 text-sm font-medium text-stone-500"
              >
                Sold out
              </button>
            )}
            <p className="mt-3 text-xs text-muted">
              Test mode. No card is charged — use Razorpay&apos;s test credentials at checkout.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
