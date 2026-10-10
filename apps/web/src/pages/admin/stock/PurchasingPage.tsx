import { Navigate, Route, Routes } from 'react-router';
import { PageHeader } from '@/components/ui';
import { useOutlet } from '@/lib/auth';
import { TabNav } from '../catalogue/common';
import { GoodsReceiptsTab } from './purchasing/GoodsReceiptsTab';
import { PurchaseOrdersTab } from './purchasing/PurchaseOrdersTab';
import { SuppliersTab } from './purchasing/SuppliersTab';

const TABS = [
  { to: '/purchasing/orders', label: 'Purchase orders' },
  { to: '/purchasing/receipts', label: 'Goods receipts' },
  { to: '/purchasing/suppliers', label: 'Suppliers' },
];

export function PurchasingPage() {
  const outlet = useOutlet();
  return (
    <>
      <PageHeader title="Purchasing" description={`Order ingredients from suppliers and receive them into stock at ${outlet.name}. Suppliers are shared by all outlets.`} />
      <TabNav tabs={TABS} label="Purchasing sections" />
      <Routes>
        <Route index element={<Navigate to="/purchasing/orders" replace />} />
        <Route path="orders" element={<PurchaseOrdersTab />} />
        <Route path="receipts" element={<GoodsReceiptsTab />} />
        <Route path="suppliers" element={<SuppliersTab />} />
        <Route path="*" element={<Navigate to="/purchasing/orders" replace />} />
      </Routes>
    </>
  );
}
