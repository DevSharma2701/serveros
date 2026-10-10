import type { PermissionKey } from '@serveos/shared';
import { ChefHat, ClipboardList, LayoutGrid, LogOut, Menu as MenuIcon, MonitorSmartphone, RefreshCw, ShoppingCart, Wallet, WifiOff, X, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '@/lib/auth';
import { useOnline } from '@/lib/online';
import { useRealtime } from '@/lib/realtime';
import { useSyncQueue } from '@/offline/useSyncQueue';
import { adminRoutes } from '@/pages/admin/routes';
import { Badge, Button, Card, cn, Select } from './ui';

interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  permission: PermissionKey;
}

const OPERATIONS: NavItem[] = [
  { path: '/pos', label: 'Point of sale', icon: ShoppingCart, permission: 'order.create' },
  { path: '/floor', label: 'Tables', icon: LayoutGrid, permission: 'table.view' },
  { path: '/orders', label: 'Orders', icon: ClipboardList, permission: 'order.view' },
  { path: '/shift', label: 'Cash shift', icon: Wallet, permission: 'shift.operate' },
];
const KDS_URL = import.meta.env.VITE_KDS_URL ?? 'http://localhost:5174';

/** Navigation entries the current user is allowed to see, grouped by section. */
export function useNavigation(): Array<{ group: string; items: NavItem[] }> {
  const { can } = useAuth();
  const groups: Array<{ group: string; items: NavItem[] }> = [{ group: 'Operations', items: OPERATIONS.filter((i) => can(i.permission)) }];
  for (const route of adminRoutes) {
    if (!can(route.permission)) continue;
    const group = groups.find((g) => g.group === route.group) ?? groups[groups.push({ group: route.group, items: [] }) - 1]!;
    group.items.push({ path: `/${route.path}`, label: route.label, icon: route.icon, permission: route.permission });
  }
  return groups.filter((g) => g.items.length > 0);
}

function OutletPicker() {
  const { me, outlet, selectOutlet } = useAuth();
  if (!me || me.outlets.length <= 1) return <p className="truncate text-sm font-medium text-sidebar-ink">{outlet?.name}</p>;
  return (
    <Select aria-label="Outlet" value={outlet?.id ?? ''} onChange={(e) => selectOutlet(e.target.value)} className="h-10 border-sidebar-raised bg-sidebar-raised text-sidebar-ink">
      {me.outlets.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </Select>
  );
}

/** Shown when a user with several outlets has not picked one yet. */
function ChooseOutlet() {
  const { me, selectOutlet, logout } = useAuth();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <Card className="w-full max-w-md p-6">
        <h1 className="text-xl font-bold text-ink">Choose an outlet</h1>
        <p className="mt-1 text-sm text-ink-soft">{me?.outlets.length ? 'You can switch outlets later from the sidebar.' : 'You have not been assigned to any outlet yet. Ask your manager to add you.'}</p>
        <div className="mt-5 flex flex-col gap-2">
          {me?.outlets.map((o) => (
            <Button key={o.id} size="lg" className="justify-between" onClick={() => selectOutlet(o.id)}>
              <span>{o.name}</span>
              <span className="text-sm font-normal text-ink-faint">{o.city || o.code}</span>
            </Button>
          ))}
        </div>
        <Button variant="ghost" className="mt-4 w-full" onClick={() => void logout()}>
          Sign out
        </Button>
      </Card>
    </div>
  );
}

export function AppShell() {
  const { me, outlet, logout, offlineSession, can } = useAuth();
  const online = useOnline();
  const live = useRealtime(online ? (outlet?.id ?? null) : null);
  const queue = useSyncQueue();
  const navigation = useNavigation();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  // The POS takes the whole screen: no page padding, and the sidebar collapses to icons.
  const immersive = location.pathname.startsWith('/pos');

  if (!outlet) return <ChooseOutlet />;
  const pending = queue.counts.queued + queue.counts.syncing + queue.counts.conflict;

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col bg-sidebar text-sidebar-ink">
      <div className="flex items-center gap-3 px-4 pb-3 pt-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-control bg-brand text-white">
          <ChefHat className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold leading-tight">ServeOS</p>
          <p className="truncate text-xs text-sidebar-faint">{me?.restaurant?.name}</p>
        </div>
      </div>
      <div className="px-4 pb-4">
        <OutletPicker />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {navigation.map((section) => (
          <div key={section.group} className="mb-4">
            <p className="px-3 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-sidebar-faint">{section.group}</p>
            {section.items.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  cn('flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors', isActive ? 'bg-brand text-white' : 'text-sidebar-ink/85 hover:bg-sidebar-raised hover:text-white')
                }
              >
                <item.icon className="h-[1.125rem] w-[1.125rem] shrink-0" aria-hidden />
                <span className="truncate">{item.label}</span>
                {item.path === '/pos' && pending > 0 ? <span className="ml-auto rounded-full bg-warn px-2 text-xs font-bold text-white">{pending}</span> : null}
              </NavLink>
            ))}
          </div>
        ))}
        {can('kitchen.view') ? (
          <a href={KDS_URL} target="_blank" rel="noreferrer" className="flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-medium text-sidebar-ink/85 hover:bg-sidebar-raised hover:text-white">
            <MonitorSmartphone className="h-[1.125rem] w-[1.125rem]" aria-hidden />
            Kitchen display
          </a>
        ) : null}
      </div>
      <div className="border-t border-sidebar-raised p-3">
        <div className="flex items-center gap-3 px-1 pb-2">
          <div aria-hidden className="flex h-9 w-9 items-center justify-center rounded-full bg-sidebar-raised text-sm font-bold">
            {me?.user.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{me?.user.name}</p>
            <p className="truncate text-xs text-sidebar-faint">{me?.user.role.name}</p>
          </div>
        </div>
        <button type="button" onClick={() => void logout()} className="flex min-h-10 w-full items-center gap-3 rounded-control px-3 text-sm text-sidebar-ink/85 hover:bg-sidebar-raised hover:text-white">
          <LogOut className="h-4 w-4" aria-hidden />
          Sign out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas">
      <aside className="hidden w-60 shrink-0 lg:block">{sidebar}</aside>
      {menuOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-ink/50" onClick={() => setMenuOpen(false)} />
          <aside className="relative h-full w-64 shadow-pop">{sidebar}</aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        {!online || offlineSession ? (
          <div role="alert" className="flex items-center justify-center gap-2 bg-bad px-4 py-2 text-sm font-semibold text-white">
            <WifiOff className="h-4 w-4" aria-hidden />
            OFFLINE — new orders are saved on this device and will be sent when the connection returns. Payments and discounts cannot be confirmed offline.
          </div>
        ) : null}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 lg:hidden">
          <Button variant="ghost" size="icon" aria-label={menuOpen ? 'Close menu' : 'Open menu'} onClick={() => setMenuOpen((v) => !v)}>
            {menuOpen ? <X className="h-5 w-5" /> : <MenuIcon className="h-5 w-5" />}
          </Button>
          <p className="truncate font-semibold text-ink">{outlet.name}</p>
          <div className="ml-auto flex items-center gap-2">
            {pending > 0 ? (
              <Badge tone="warn">
                <RefreshCw className="h-3 w-3" aria-hidden /> {pending} to sync
              </Badge>
            ) : null}
            <Badge tone={online && live ? 'ok' : 'neutral'}>{online ? (live ? 'Live' : 'Connecting') : 'Offline'}</Badge>
          </div>
        </header>
        <main className={cn('min-h-0 flex-1', immersive ? 'overflow-hidden' : 'overflow-y-auto p-4 md:p-6 lg:p-8')}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
