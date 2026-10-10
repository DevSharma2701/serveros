import { zodResolver } from '@hookform/resolvers/zod';
import { passwordSchema } from '@serveos/shared';
import { ChefHat } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { Button, Card, Field, Input, Notice } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';

function Frame({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-sidebar p-4">
      <Card className="w-full max-w-sm p-7">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-control bg-brand text-white">
            <ChefHat className="h-6 w-6" aria-hidden />
          </div>
          <div>
            <h1 className="text-xl font-bold leading-tight text-ink">{title}</h1>
            <p className="text-sm text-ink-soft">{subtitle}</p>
          </div>
        </div>
        {children}
      </Card>
    </div>
  );
}

const loginForm = z.object({ email: z.email('Enter your work email'), password: z.string().min(1, 'Enter your password') });
type LoginForm = z.infer<typeof loginForm>;

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'login' | 'forgot' | 'sent'>('login');
  const form = useForm<LoginForm>({ resolver: zodResolver(loginForm), defaultValues: { email: '', password: '' } });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await login(values.email, values.password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  const sendReset = async () => {
    setError(null);
    if (!(await form.trigger('email'))) return;
    try {
      await api('/auth/password/forgot', { method: 'POST', body: { email: form.getValues('email') }, outletId: null });
      setMode('sent');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Frame title="ServeOS" subtitle={mode === 'login' ? 'Sign in to your restaurant' : 'Reset your password'}>
      {mode === 'sent' ? (
        <div className="flex flex-col gap-4">
          <Notice tone="ok" title="Check your email">
            If an account exists for that address, a reset link is on its way. It is valid for 30 minutes.
          </Notice>
          <Button onClick={() => setMode('login')}>Back to sign in</Button>
        </div>
      ) : (
        <form
          onSubmit={
            mode === 'login'
              ? submit
              : (e) => {
                  e.preventDefault();
                  void sendReset();
                }
          }
          className="flex flex-col gap-4"
          noValidate
        >
          <Field label="Email" error={errors.email?.message}>
            {(p) => <Input {...p} type="email" autoComplete="username" autoFocus {...form.register('email')} />}
          </Field>
          {mode === 'login' ? (
            <Field label="Password" error={errors.password?.message}>
              {(p) => <Input {...p} type="password" autoComplete="current-password" {...form.register('password')} />}
            </Field>
          ) : null}
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <Button type="submit" variant="primary" size="lg" loading={isSubmitting}>
            {mode === 'login' ? 'Sign in' : 'Send reset link'}
          </Button>
          <button
            type="button"
            className="text-sm font-medium text-brand hover:underline"
            onClick={() => {
              setError(null);
              setMode(mode === 'login' ? 'forgot' : 'login');
            }}
          >
            {mode === 'login' ? 'Forgot your password?' : 'Back to sign in'}
          </button>
        </form>
      )}
    </Frame>
  );
}

const passwordForm = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: 'The passwords do not match', path: ['confirm'] });
type PasswordForm = z.infer<typeof passwordForm>;

/** Landing page for invitation and password-reset links (/set-password?token=...). */
export function SetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<PasswordForm>({ resolver: zodResolver(passwordForm), defaultValues: { password: '', confirm: '' } });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api('/auth/password/reset', { method: 'POST', body: { token, password: values.password }, outletId: null });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  return (
    <Frame title="Set your password" subtitle="Choose a password for ServeOS">
      {done ? (
        <div className="flex flex-col gap-4">
          <Notice tone="ok" title="Password saved">
            You can now sign in with your new password.
          </Notice>
          <Button asChild variant="primary">
            <Link to="/">Go to sign in</Link>
          </Button>
        </div>
      ) : !token ? (
        <Notice tone="bad" title="This link is incomplete">
          Open the link from your email again, or ask for a new one.
        </Notice>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label="New password" error={errors.password?.message} hint="At least 10 characters.">
            {(p) => <Input {...p} type="password" autoComplete="new-password" autoFocus {...form.register('password')} />}
          </Field>
          <Field label="Repeat password" error={errors.confirm?.message}>
            {(p) => <Input {...p} type="password" autoComplete="new-password" {...form.register('confirm')} />}
          </Field>
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <Button type="submit" variant="primary" size="lg" loading={isSubmitting}>
            Save password
          </Button>
        </form>
      )}
    </Frame>
  );
}
