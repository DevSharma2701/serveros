import { Navigate, Route, Routes } from 'react-router';
import { PageHeader } from '@/components/ui';
import { useOutlet } from '@/lib/auth';
import { TabNav } from '../catalogue/common';
import { CountsTab } from './inventory/CountsTab';
import { IngredientsTab } from './inventory/IngredientsTab';
import { MovementsTab } from './inventory/MovementsTab';
import { StockTab } from './inventory/StockTab';

const TABS = [
  { to: '/inventory/stock', label: 'Stock on hand' },
  { to: '/inventory/movements', label: 'Movements' },
  { to: '/inventory/counts', label: 'Stock counts' },
  { to: '/inventory/ingredients', label: 'Ingredients' },
];

export function InventoryPage() {
  const outlet = useOutlet();
  return (
    <>
      <PageHeader title="Inventory" description={`Ingredient stock at ${outlet.name}. Stock goes up with goods receipts and down with sales (through recipes), wastage and transfers.`} />
      <TabNav tabs={TABS} label="Inventory sections" />
      <Routes>
        <Route index element={<Navigate to="/inventory/stock" replace />} />
        <Route path="stock" element={<StockTab />} />
        <Route path="movements" element={<MovementsTab />} />
        <Route path="counts" element={<CountsTab />} />
        <Route path="ingredients" element={<IngredientsTab />} />
        <Route path="*" element={<Navigate to="/inventory/stock" replace />} />
      </Routes>
    </>
  );
}
