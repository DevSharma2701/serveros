import { LoaderCircle, Store, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './lib/auth';
import { BoardPage } from './pages/BoardPage';
import { LoginPage } from './pages/LoginPage';

function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-3xl font-extrabold">{title}</h1>
      {children}
    </main>
  );
}

const BIG_BUTTON = 'flex min-h-16 items-center justify-center gap-3 rounded-control border-2 border-kds-line bg-kds-card px-8 text-2xl font-bold hover:bg-kds-raised';

function Screens() {
  const auth = useAuth();

  if (auth.status === 'loading') {
    return (
      <Notice title="Starting kitchen display…">
        <LoaderCircle aria-hidden className="size-10 animate-spin text-kds-faint" />
      </Notice>
    );
  }
  if (auth.status === 'unreachable') {
    return (
      <Notice title="Cannot reach the server">
        <WifiOff aria-hidden className="size-16 text-kds-bad" />
        <p role="alert" className="max-w-xl text-xl text-kds-soft">
          No orders can be shown until the connection returns. Check the network; this screen retries every few seconds.
        </p>
      </Notice>
    );
  }
  if (auth.status === 'anonymous' || !auth.me) return <LoginPage onLogin={auth.login} />;

  const signOut = () => void auth.logout();
  if (!auth.outlet) {
    return (
      <Notice title={auth.me.outlets.length ? 'Choose an outlet' : 'No outlet assigned'}>
        {auth.me.outlets.length === 0 && <p className="text-xl text-kds-soft">Ask a manager to give this account access to an outlet.</p>}
        <ul className="flex w-full max-w-md flex-col gap-3">
          {auth.me.outlets.map((o) => (
            <li key={o.id}>
              <button type="button" onClick={() => auth.selectOutlet(o.id)} className={`${BIG_BUTTON} w-full`}>
                <Store aria-hidden className="size-7" /> {o.name}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" onClick={signOut} className="min-h-14 px-4 text-lg text-kds-faint underline">
          Sign out
        </button>
      </Notice>
    );
  }
  if (!auth.can('kitchen.view')) {
    return (
      <Notice title="This account cannot view kitchen tickets">
        <p className="text-xl text-kds-soft">Sign in with a kitchen account, or ask a manager for the “View kitchen tickets” permission.</p>
        <button type="button" onClick={signOut} className={BIG_BUTTON}>
          Sign out
        </button>
      </Notice>
    );
  }
  return (
    // Keyed by outlet: switching outlet starts a fresh board, so one outlet's tickets never show under another's name.
    <BoardPage
      key={auth.outlet.id}
      outlet={auth.outlet}
      userName={auth.me.user.name}
      canUpdate={auth.can('kitchen.update')}
      onSignOut={signOut}
      onChangeOutlet={auth.me.outlets.length > 1 ? () => auth.selectOutlet(null) : undefined}
    />
  );
}

export function App() {
  return (
    <AuthProvider>
      <Screens />
    </AuthProvider>
  );
}
