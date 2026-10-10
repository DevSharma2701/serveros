import type { PermissionKey } from '@serveos/shared';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { catalogueRoutes } from './catalogue/routes';
import { insightsRoutes } from './insights/routes';
import { peopleRoutes } from './people/routes';
import { setupRoutes } from './setup/routes';
import { stockRoutes } from './stock/routes';

/** A back-office page: appears in the sidebar and is routed at /<path> for users holding `permission`. */
export interface AdminRoute {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Sidebar section heading. */
  group: 'Insights' | 'Catalogue' | 'Stock' | 'People' | 'Setup';
  permission: PermissionKey;
  element: ReactNode;
}

export const adminRoutes: AdminRoute[] = [...insightsRoutes, ...catalogueRoutes, ...stockRoutes, ...peopleRoutes, ...setupRoutes];
