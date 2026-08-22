import Link from 'next/link';
import { getProduct } from '@/lib/data';
import { ErrorNotice, SetupNotice } from '@/components/ui';
import CheckoutForm from './checkout-form';

export const dynamic = 'force-dynamic';

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

  const result = await getProduct(productId);

  if (!result.ok) {
    return (
      <div className="mx-auto max-w-xl px-6 py-12">
        {result.code === 'CONFIGURATION_ERROR' ? (
          <SetupNotice message={result.message} />
        ) : (
          <ErrorNotice title="Could not load this product" message={result.message} />
        )}
      </div>
    );
  }

  return <CheckoutForm product={result.data} />;
}
