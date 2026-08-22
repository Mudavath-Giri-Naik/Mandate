import Link from 'next/link';
import { apiGet } from '@/lib/server-fetch';
import type { Product } from '@/lib/types';
import { ErrorNotice, SetupNotice } from '@/components/ui';
import CheckoutForm from './checkout-form';

export const dynamic = 'force-dynamic';

type ProductDetail = Product & { in_stock: boolean };

export default async function CheckoutPage({ searchParams }: PageProps<'/checkout'>) {
  const params = await searchParams;
  const productId = typeof params.product_id === 'string' ? params.product_id : '';

  if (!productId) {
    return (
      <div className="mx-auto max-w-xl px-6 py-12">
        <ErrorNotice
          title="No product selected"
          message="Open a product and press Buy Now to reach checkout."
        />
        <Link href="/" className="mt-4 inline-block text-sm underline">
          Back to shop
        </Link>
      </div>
    );
  }

  const result = await apiGet<ProductDetail>(`/api/products/${productId}`);

  if (!result.ok) {
    return (
      <div className="mx-auto max-w-xl px-6 py-12">
        {result.error.code === 'CONFIGURATION_ERROR' ? (
          <SetupNotice message={result.error.message} />
        ) : (
          <ErrorNotice title="Could not load this product" message={result.error.message} />
        )}
      </div>
    );
  }

  return <CheckoutForm product={result.data} />;
}
