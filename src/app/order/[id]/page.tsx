import { getOrder } from '@/lib/data';
import { ErrorNotice, SetupNotice } from '@/components/ui';
import OrderStatusView from './order-status-view';

export const dynamic = 'force-dynamic';

export default async function OrderPage({ params }: PageProps<'/order/[id]'>) {
  const { id } = await params;
  const result = await getOrder(id);

  if (!result.ok) {
    return (
      <div className="mx-auto max-w-xl px-6 py-12">
        {result.code === 'CONFIGURATION_ERROR' ? (
          <SetupNotice message={result.message} />
        ) : (
          <ErrorNotice title="Could not load this order" message={result.message} />
        )}
      </div>
    );
  }

  return <OrderStatusView initialOrder={result.data} />;
}
