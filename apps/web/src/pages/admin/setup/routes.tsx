import { ListChecks, QrCode, Settings, Store, Wrench } from 'lucide-react';
import type { AdminRoute } from '../routes';
import { GoLivePage } from './GoLivePage';
import { OutletSetupPage } from './OutletSetupPage';
import { OutletsPage } from './OutletsPage';
import { QrCodesPage } from './QrCodesPage';
import { SettingsPage } from './SettingsPage';

export const setupRoutes: AdminRoute[] = [
  { path: 'settings', label: 'Settings', icon: Settings, group: 'Setup', permission: 'restaurant.manage', element: <SettingsPage /> },
  { path: 'outlets', label: 'Outlets', icon: Store, group: 'Setup', permission: 'outlet.manage', element: <OutletsPage /> },
  { path: 'outlet-setup', label: 'Outlet set-up', icon: Wrench, group: 'Setup', permission: 'table.view', element: <OutletSetupPage /> },
  { path: 'qr-codes', label: 'Table QR codes', icon: QrCode, group: 'Setup', permission: 'table.manage', element: <QrCodesPage /> },
  { path: 'go-live', label: 'Go-live checklist', icon: ListChecks, group: 'Setup', permission: 'restaurant.manage', element: <GoLivePage /> },
];
