import { Navigate, Route, Routes } from 'react-router';
import { PageHeader } from '@/components/ui';
import { TabNav } from './common';
import { AvailabilityTab } from './menu/AvailabilityTab';
import { CategoriesTab } from './menu/CategoriesTab';
import { ModifierGroupsTab } from './menu/ModifierGroupsTab';
import { ProductsTab } from './menu/ProductsTab';

const TABS = [
  { to: '/menu/products', label: 'Products' },
  { to: '/menu/availability', label: 'Outlet availability & prices' },
  { to: '/menu/categories', label: 'Categories' },
  { to: '/menu/modifiers', label: 'Modifier groups' },
];

export function MenuPage() {
  return (
    <>
      <PageHeader title="Menu" description="Products, portion sizes, categories and modifiers are shared by all outlets. Availability and price overrides are set per outlet." />
      <TabNav tabs={TABS} label="Menu sections" />
      <Routes>
        <Route index element={<Navigate to="/menu/products" replace />} />
        <Route path="products" element={<ProductsTab />} />
        <Route path="availability" element={<AvailabilityTab />} />
        <Route path="categories" element={<CategoriesTab />} />
        <Route path="modifiers" element={<ModifierGroupsTab />} />
        <Route path="*" element={<Navigate to="/menu/products" replace />} />
      </Routes>
    </>
  );
}
