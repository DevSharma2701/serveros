import { BarChart3 } from 'lucide-react';
import type { AdminRoute } from '../routes';
import { ReportsPage } from './ReportsPage';

export const insightsRoutes: AdminRoute[] = [{ path: 'reports', label: 'Reports', icon: BarChart3, group: 'Insights', permission: 'report.view', element: <ReportsPage /> }];
