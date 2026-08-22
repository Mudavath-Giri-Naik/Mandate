import { apiGet } from '@/lib/server-fetch';
import type { OrderWithProduct } from '@/lib/types';
import { ErrorNotice, SetupNotice } from '@/components/ui';
import OrderStatusView from './order-status-view';

export const dynamic = 'force-dynamic';

type OrderPayload = OrderWithProduct & { is_settled: boolean; is_paid: boolean };

export default async function OrderPage({ params }: PageProps<'/order/[id]'>) {
  const { id } = await params;
  const result = await apiGet<OrderPayload>(`/api/orders/${id}`);

  if (!result.ok) {
    return (
      <div className="mx-auto max-w-xl px-6 py-12">
        {result.error.code === 'CONFIGURATION_ERROR' ? (
          <SetupNotice message={result.error.message} />
        ) : (
          <ErrorNotice title="Could not load this order" message={result.error.message} />
        )}
      </div>
    );
  }

  return <OrderStatusView initialOrder={result.data} />;
}
