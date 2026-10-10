import { Navigate, Route, Routes } from 'react-router';
import { PageHeader } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { TabNav } from './common';
import { DiscountsTab } from './pricing/DiscountsTab';
import { TaxCategoriesTab } from './pricing/TaxCategoriesTab';

export function PricingPage() {
  const { can } = useAuth();
  const showDiscounts = can('discount.manage');
  const tabs = [{ to: '/pricing/taxes', label: 'Tax categories' }, ...(showDiscounts ? [{ to: '/pricing/discounts', label: 'Discounts & coupons' }] : [])];
  return (
    <>
      <PageHeader title="Taxes & discounts" description="Tax categories decide the tax lines on each bill. Discounts and coupons are what cashiers can apply." />
      {tabs.length > 1 ? <TabNav tabs={tabs} label="Pricing sections" /> : null}
      <Routes>
        <Route index element={<Navigate to="/pricing/taxes" replace />} />
        <Route path="taxes" element={<TaxCategoriesTab />} />
        {showDiscounts ? <Route path="discounts" element={<DiscountsTab />} /> : null}
        <Route path="*" element={<Navigate to="/pricing/taxes" replace />} />
      </Routes>
    </>
  );
}
