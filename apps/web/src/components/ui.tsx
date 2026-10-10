/**
 * ServeOS design-system components (shadcn/ui style: Radix primitives + Tailwind + variants).
 * Colours and radii come from packages/config/tokens.css. Keep app pages built from these
 * so the POS and back office stay consistent.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx, type ClassValue } from 'clsx';
import { AlertTriangle, CheckCircle2, Inbox, Info, Loader2, Search, X, XCircle } from 'lucide-react';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));

// ───────────── Buttons ─────────────

const buttonStyles = cva(
  'inline-flex select-none items-center justify-center gap-2 rounded-control font-semibold transition-colors duration-150 disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap',
  {
    variants: {
      variant: {
        primary: 'bg-brand text-white hover:bg-brand-strong active:bg-brand-strong shadow-card',
        secondary: 'bg-surface text-ink border border-line-strong hover:bg-sunken active:bg-line',
        ghost: 'text-ink-soft hover:bg-sunken hover:text-ink',
        danger: 'bg-bad text-white hover:brightness-90',
        success: 'bg-ok text-white hover:brightness-90',
        dark: 'bg-ink text-white hover:bg-sidebar-raised',
      },
      size: {
        sm: 'h-9 px-3 text-sm',
        md: 'h-11 px-4 text-sm',
        lg: 'h-14 px-6 text-base', // primary POS actions: comfortable on a touchscreen
        icon: 'h-11 w-11',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonStyles> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ className, variant, size, asChild, loading, disabled, children, type, ...props }, ref) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp ref={ref} type={asChild ? undefined : (type ?? 'button')} className={cn(buttonStyles({ variant, size }), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {children}
        </>
      ) : (
        children
      )}
    </Comp>
  );
});

// ───────────── Form controls ─────────────

const controlBase =
  'w-full rounded-control border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-faint transition-colors focus:border-brand disabled:bg-sunken disabled:text-ink-faint aria-[invalid=true]:border-bad';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(controlBase, 'h-11', className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(controlBase, 'min-h-20 py-2', className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...props }, ref) {
  return (
    <select ref={ref} className={cn(controlBase, 'h-11 pr-8', className)} {...props}>
      {children}
    </select>
  );
});

/** Label + control + hint/error, wired together for screen readers. */
export function Field({ label, error, hint, children, className }: { label: string; error?: string; hint?: string; children: (props: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => ReactNode; className?: string }) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-bad">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-ink-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Checkbox({ label, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={cn('flex min-h-11 items-center gap-3 text-sm text-ink', className)}>
      <input type="checkbox" className="h-5 w-5 rounded border-line-strong accent-[var(--color-brand)]" {...props} />
      <span>{label}</span>
    </label>
  );
}

export const SearchInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { onClear?: () => void }>(function SearchInput({ className, onClear, value, ...props }, ref) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
      <Input ref={ref} type="search" value={value} className="pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden" {...props} />
      {value && onClear ? (
        <button type="button" onClick={onClear} aria-label="Clear search" className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-control text-ink-faint hover:bg-sunken hover:text-ink">
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
});

/** A row of mutually exclusive choices (order type, report range...). */
export function Segmented<T extends string>({ value, onChange, options, label, className }: { value: T; onChange: (value: T) => void; options: Array<{ value: T; label: ReactNode; disabled?: boolean }>; label: string; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-control border border-line bg-sunken p-1', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cn('h-9 rounded-[0.375rem] px-3 text-sm font-medium transition-colors disabled:opacity-40', value === o.value ? 'bg-surface text-ink shadow-card' : 'text-ink-soft hover:text-ink')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ───────────── Display ─────────────

const badgeStyles = cva('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap', {
  variants: {
    tone: {
      neutral: 'bg-sunken text-ink-soft',
      ok: 'bg-ok-soft text-ok',
      warn: 'bg-warn-soft text-warn',
      bad: 'bg-bad-soft text-bad',
      info: 'bg-info-soft text-info',
      brand: 'bg-brand-soft text-brand-strong',
    },
  },
  defaultVariants: { tone: 'neutral' },
});
export type Tone = NonNullable<VariantProps<typeof badgeStyles>['tone']>;

export function Badge({ tone, className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return <span className={cn(badgeStyles({ tone }), className)}>{children}</span>;
}

const STATUS_TONES: Record<string, Tone> = {
  DRAFT: 'neutral', PLACED: 'info', CONFIRMED: 'info', PREPARING: 'warn', READY: 'ok', COMPLETED: 'ok', CANCELLED: 'bad', REFUNDED: 'bad',
  UNPAID: 'warn', PARTIALLY_PAID: 'warn', PAID: 'ok', PARTIALLY_REFUNDED: 'bad',
  PENDING: 'warn', SUCCEEDED: 'ok', FAILED: 'bad',
  AVAILABLE: 'ok', OCCUPIED: 'brand', RESERVED: 'info',
  OPEN: 'ok', CLOSED: 'neutral', ACTIVE: 'ok', INVITED: 'info', DISABLED: 'bad',
  SENT: 'info', PARTIALLY_RECEIVED: 'warn', RECEIVED: 'ok', POSTED: 'ok', BOOKED: 'info', SEATED: 'brand', NO_SHOW: 'bad',
};

/** A coloured pill for any status value the API returns. */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const label = status.toLowerCase().replace(/_/g, ' ');
  return (
    <Badge tone={STATUS_TONES[status] ?? 'neutral'} className={cn('capitalize', className)}>
      {label}
    </Badge>
  );
}

export function Card({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-card border border-line bg-surface shadow-card', className)} {...props}>
      {children}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-ink-soft">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return <Loader2 role="status" aria-label={label} className={cn('h-5 w-5 animate-spin text-ink-faint', className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-control bg-line/70', className)} />;
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-3 p-4">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-sunken text-ink-faint">{icon ?? <Inbox className="h-6 w-6" aria-hidden />}</div>
      <div>
        <p className="font-semibold text-ink">{title}</p>
        {description ? <p className="mx-auto mt-1 max-w-sm text-sm text-ink-soft">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-bad-soft text-bad">
        <AlertTriangle className="h-6 w-6" aria-hidden />
      </div>
      <div>
        <p className="font-semibold text-ink">Could not load this</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-ink-soft">{message}</p>
      </div>
      {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}

export function Notice({ tone = 'info', title, children, className }: { tone?: 'info' | 'warn' | 'bad' | 'ok'; title?: string; children?: ReactNode; className?: string }) {
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'bad' ? XCircle : tone === 'warn' ? AlertTriangle : Info;
  const styles = { info: 'bg-info-soft text-info border-info/20', warn: 'bg-warn-soft text-warn border-warn/25', bad: 'bg-bad-soft text-bad border-bad/20', ok: 'bg-ok-soft text-ok border-ok/20' }[tone];
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={cn('flex gap-3 rounded-control border px-3 py-2.5 text-sm', styles, className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cn(title && 'mt-0.5', 'text-ink')}>{children}</div> : null}
      </div>
    </div>
  );
}

// ───────────── Data table ─────────────

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}

/** Compact operational table. Pass `onRowClick` to make rows open a detail view. */
export function DataTable<T>({ columns, rows, rowKey, onRowClick, empty, className }: { columns: Array<Column<T>>; rows: T[]; rowKey: (row: T) => string; onRowClick?: (row: T) => void; empty?: ReactNode; className?: string }) {
  if (rows.length === 0) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  const align = (a?: string) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left');
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line bg-sunken/60">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn('px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-ink-faint', align(c.align), c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onRowClick(row)) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              className={cn('border-b border-line last:border-0', onRowClick && 'cursor-pointer hover:bg-sunken/60 focus-visible:bg-sunken/60')}
            >
              {columns.map((c) => (
                <td key={c.key} className={cn('px-4 py-3 align-middle text-ink', align(c.align), c.align === 'right' && 'tabular', c.className)}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-ink-soft">
      <span>
        {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
      </span>
      <div className="flex gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

// ───────────── Overlays ─────────────

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}

/** Centred dialog. Focus is trapped inside and Escape closes it (Radix Dialog). */
export function Modal({ open, onClose, title, description, children, footer, size = 'md' }: OverlayProps & { size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/50 data-[state=open]:animate-in data-[state=open]:fade-in" />
        <Dialog.Content
          aria-describedby={description ? undefined : undefined}
          className={cn('fixed left-1/2 top-1/2 z-50 flex max-h-[92dvh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-card bg-surface shadow-pop', width)}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-bold text-ink">{title}</Dialog.Title>
              {description ? <Dialog.Description className="mt-0.5 text-sm text-ink-soft">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="-mr-2 -mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-ink-faint hover:bg-sunken hover:text-ink">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-sunken/50 px-5 py-3">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Panel that slides in from the right, for details alongside a list. */
export function Drawer({ open, onClose, title, description, children, footer, wide }: OverlayProps & { wide?: boolean }) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content className={cn('fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-surface shadow-pop', wide ? 'max-w-2xl' : 'max-w-md')}>
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-bold text-ink">{title}</Dialog.Title>
              {description ? <Dialog.Description className="mt-0.5 text-sm text-ink-soft">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="-mr-2 -mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-ink-faint hover:bg-sunken hover:text-ink">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-sunken/50 px-5 py-3">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Asks before a consequential action. With `requireReason`, the person must type why;
 * the reason is passed to `onConfirm` and ends up in the audit log.
 */
export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = 'Confirm', danger, requireReason, reasonLabel = 'Reason', pending, error }: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  danger?: boolean;
  requireReason?: boolean;
  reasonLabel?: string;
  pending?: boolean;
  error?: string | null;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const valid = !requireReason || reason.trim().length >= 3;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={pending} disabled={!valid} onClick={() => onConfirm(reason.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {requireReason ? (
        <Field label={reasonLabel} hint="At least 3 characters. Saved in the audit log.">
          {(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus maxLength={300} />}
        </Field>
      ) : null}
      {error ? <Notice tone="bad" className="mt-3">{error}</Notice> : null}
    </Modal>
  );
}

// ───────────── Notifications (toasts) ─────────────

interface Toast {
  id: number;
  tone: 'ok' | 'bad' | 'info' | 'warn';
  message: string;
}
const ToastContext = createContext<{ notify: (message: string, tone?: Toast['tone']) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const notify = useCallback(
    (message: string, tone: Toast['tone'] = 'ok') => {
      const id = Date.now() + Math.random();
      setToasts((list) => [...list.slice(-3), { id, tone, message }]);
      // Errors stay longer: they usually need reading.
      setTimeout(() => dismiss(id), tone === 'bad' ? 8000 : 4000);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ notify }), [notify]);
  const icon = { ok: CheckCircle2, bad: XCircle, info: Info, warn: AlertTriangle };
  const colour = { ok: 'text-ok', bad: 'text-bad', info: 'text-info', warn: 'text-warn' };
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2">
        {toasts.map((t) => {
          const Icon = icon[t.tone];
          return (
            <div key={t.id} role={t.tone === 'bad' ? 'alert' : 'status'} className="pointer-events-auto flex items-start gap-3 rounded-card border border-line bg-surface px-4 py-3 text-sm text-ink shadow-pop">
              <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', colour[t.tone])} aria-hidden />
              <p className="min-w-0 flex-1">{t.message}</p>
              <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="-mr-1 flex h-7 w-7 items-center justify-center rounded text-ink-faint hover:bg-sunken">
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx.notify;
}
