import { Boxes, NotebookPen, Truck } from 'lucide-react';
import type { AdminRoute } from '../routes';
import { InventoryPage } from './InventoryPage';
import { PurchasingPage } from './PurchasingPage';
import { RecipesPage } from './RecipesPage';

export const stockRoutes: AdminRoute[] = [
  { path: 'inventory', label: 'Inventory', icon: Boxes, group: 'Stock', permission: 'inventory.view', element: <InventoryPage /> },
  { path: 'recipes', label: 'Recipes', icon: NotebookPen, group: 'Stock', permission: 'inventory.view', element: <RecipesPage /> },
  { path: 'purchasing', label: 'Purchasing', icon: Truck, group: 'Stock', permission: 'inventory.view', element: <PurchasingPage /> },
];
