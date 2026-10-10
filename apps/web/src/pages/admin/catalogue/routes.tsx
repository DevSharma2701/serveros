import { Percent, UtensilsCrossed } from 'lucide-react';
import type { AdminRoute } from '../routes';
import { MenuPage } from './MenuPage';
import { PricingPage } from './PricingPage';

export const catalogueRoutes: AdminRoute[] = [
  { path: 'menu', label: 'Menu', icon: UtensilsCrossed, group: 'Catalogue', permission: 'menu.view', element: <MenuPage /> },
  { path: 'pricing', label: 'Taxes & discounts', icon: Percent, group: 'Catalogue', permission: 'menu.view', element: <PricingPage /> },
];
