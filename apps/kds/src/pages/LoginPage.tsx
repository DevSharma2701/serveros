import { ChefHat } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { errorMessage } from '../lib/api';

const FIELD = 'min-h-14 rounded-control border-2 border-kds-line bg-kds-bg px-4 text-xl text-kds-ink';

export function LoginPage({ onLogin }: { onLogin(email: string, password: string): Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onLogin(email.trim(), password);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <form onSubmit={(e) => void submit(e)} className="flex w-full max-w-md flex-col gap-5 rounded-card border-2 border-kds-line bg-kds-card p-8">
        <div className="flex items-center gap-3">
          <ChefHat aria-hidden className="size-12 text-brand-bright" />
          <div>
            <h1 className="text-3xl font-extrabold">Kitchen Display</h1>
            <p className="text-lg text-kds-faint">ServeOS</p>
          </div>
        </div>
        <label className="flex flex-col gap-2 text-lg font-semibold">
          Email
          <input type="email" name="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className={FIELD} />
        </label>
        <label className="flex flex-col gap-2 text-lg font-semibold">
          Password
          <input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={FIELD} />
        </label>
        {error && (
          <p role="alert" className="rounded-control bg-kds-bad px-4 py-3 text-lg font-bold text-kds-bg">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className="min-h-16 rounded-control bg-brand text-2xl font-extrabold text-white hover:bg-brand-strong">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
