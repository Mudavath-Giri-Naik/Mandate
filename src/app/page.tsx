import Image from 'next/image';
import Link from 'next/link';
import { apiGet } from '@/lib/server-fetch';
import { formatPaise } from '@/lib/money';
import type { Product } from '@/lib/types';
import { ErrorNotice, SetupNotice } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface ProductsPayload {
  count: number;
  products: Product[];
}

const SIZES = ['S', 'M', 'L', 'XL', '32', '34'];
const COLORS = [
  'White', 'Black', 'Olive', 'Charcoal', 'Navy', 'Grey',
  'Cream', 'Rust', 'Indigo', 'Khaki', 'Tan',
];
const PRICE_CAPS = [
  { label: 'Under ₹1,000', value: '100000' },
  { label: 'Under ₹2,000', value: '200000' },
  { label: 'Under ₹3,000', value: '300000' },
  { label: 'Under ₹5,000', value: '500000' },
];

export default async function HomePage({ searchParams }: PageProps<'/'>) {
  const params = await searchParams;
  const read = (k: string) => {
    const v = params[k];
    return typeof v === 'string' && v !== '' ? v : '';
  };

  const size = read('size');
  const color = read('color');
  const maxPrice = read('max_price');

  const qs = new URLSearchParams();
  if (size) qs.set('size', size);
  if (color) qs.set('color', color);
  if (maxPrice) qs.set('max_price', maxPrice);
  const query = qs.toString();

  const result = await apiGet<ProductsPayload>(`/api/products${query ? `?${query}` : ''}`);

  const hasFilters = Boolean(size || color || maxPrice);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Everyday essentials</h1>
        <p className="mt-2 text-sm text-muted">
          Single-item checkout. Stock is reserved the moment you press Buy Now and released
          automatically if payment is abandoned.
        </p>
      </div>

      {/* ------------------------------------------------------------ filters -- */}
      <form method="get" className="mb-8 rounded-xl border border-line bg-surface p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Size</span>
            <select
              name="size"
              defaultValue={size}
              className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm"
            >
              <option value="">Any size</option>
              {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Colour</span>
            <select
              name="color"
              defaultValue={color}
              className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm"
            >
              <option value="">Any colour</option>
              {COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Max price</span>
            <select
              name="max_price"
              defaultValue={maxPrice}
              className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm"
            >
              <option value="">Any price</option>
              {PRICE_CAPS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </label>

          <div className="flex items-end gap-2">
            <button
              type="submit"
              className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-700"
            >
              Apply
            </button>
            {hasFilters && (
              <Link
                href="/"
                className="rounded-md border border-line px-4 py-2 text-sm text-muted transition hover:text-foreground"
              >
                Clear
              </Link>
            )}
          </div>
        </div>
      </form>

      {/* ------------------------------------------------------------- results -- */}
      {!result.ok ? (
        result.error.code === 'CONFIGURATION_ERROR' ? (
          <SetupNotice message={result.error.message} />
        ) : (
          <ErrorNotice title="Could not load products" message={result.error.message} />
        )
      ) : result.data.products.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface p-10 text-center text-sm text-muted">
          {hasFilters
            ? 'Nothing in stock matches those filters.'
            : 'No products yet — run supabase/seed.sql to load the catalogue.'}
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted">
            {result.data.count} item{result.data.count === 1 ? '' : 's'} in stock
          </p>
          <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {result.data.products.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/product/${p.id}`}
                  className="group block overflow-hidden rounded-xl border border-line bg-surface transition hover:shadow-md"
                >
                  <div className="relative aspect-square bg-stone-100">
                    {p.image_url && (
                      <Image
                        src={p.image_url}
                        alt={p.name}
                        fill
                        sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                        className="object-cover transition duration-300 group-hover:scale-[1.02]"
                      />
                    )}
                    {p.stock_count <= 3 && (
                      <span className="absolute left-3 top-3 rounded-full bg-red-600 px-2.5 py-1 text-xs font-medium text-white">
                        Only {p.stock_count} left
                      </span>
                    )}
                  </div>
                  <div className="p-4">
                    <h2 className="text-sm font-medium leading-snug">{p.name}</h2>
                    <p className="mt-1 text-xs text-muted">
                      {[p.size, p.color].filter(Boolean).join(' · ')}
                    </p>
                    <p className="mt-3 text-sm font-semibold">{formatPaise(p.price)}</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
