import type { PermissionKey } from '@serveos/shared';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { AppShell, useNavigation } from './components/AppShell';
import { EmptyState, Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import { adminRoutes } from './pages/admin/routes';
import { FloorPage } from './pages/Floor';
import { LoginPage, SetPasswordPage } from './pages/Login';
import { OrdersPage } from './pages/Orders';
import { PosPage } from './pages/pos/PosPage';
import { ShiftPage } from './pages/Shift';

/** Hides a page from users without the permission. The API refuses them as well; this is only tidiness. */
export function Guard({ permission, children }: { permission: PermissionKey; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(permission)) return <EmptyState title="You do not have access to this page" description="Ask a manager if you think you should." />;
  return <>{children}</>;
}

/** Sends each role to the first screen it can use. */
function Home() {
  const first = useNavigation()[0]?.items[0];
  if (!first) return <EmptyState title="Nothing to show" description="Your role has no screens in this app. Kitchen staff use the kitchen display." />;
  return <Navigate to={first.path} replace />;
}

export function App() {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner className="h-8 w-8" label="Starting ServeOS" />
      </div>
    );
  }
  if (status === 'anonymous') {
    return (
      <Routes>
        <Route path="/set-password" element={<SetPasswordPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/set-password" element={<SetPasswordPage />} />
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="pos" element={<Guard permission="order.create"><PosPage /></Guard>} />
        <Route path="floor" element={<Guard permission="table.view"><FloorPage /></Guard>} />
        <Route path="orders" element={<Guard permission="order.view"><OrdersPage /></Guard>} />
        <Route path="shift" element={<Guard permission="shift.operate"><ShiftPage /></Guard>} />
        {adminRoutes.map((r) => (
          <Route key={r.path} path={`${r.path}/*`} element={<Guard permission={r.permission}>{r.element}</Guard>} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
