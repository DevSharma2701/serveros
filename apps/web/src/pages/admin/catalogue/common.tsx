/** Small building blocks shared by the catalogue and stock back-office pages. */
import type { UseQueryResult } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { Badge, ErrorState, SkeletonRows, cn } from '@/components/ui';
import { errorMessage } from '@/lib/api';

export interface TabItem {
  /** Absolute path, e.g. "/menu/products". */
  to: string;
  label: string;
}

/** Sub-page tabs. Each tab is a real link, so the browser back button and deep links work. */
export function TabNav({ tabs, label }: { tabs: TabItem[]; label: string }) {
  return (
    <nav aria-label={label} className="-mx-1 mb-5 flex gap-1 overflow-x-auto border-b border-line px-1">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          className={({ isActive }) =>
            cn(
              '-mb-px flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 px-3 text-sm font-semibold transition-colors',
              isActive ? 'border-brand text-brand-strong' : 'border-transparent text-ink-soft hover:text-ink',
            )
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Renders the loading and error states of a query, and the children once data is there. */
export function Loadable<T>({ query, rows = 6, children }: { query: UseQueryResult<T>; rows?: number; children: (data: T) => ReactNode }) {
  if (query.isPending) return <SkeletonRows rows={rows} />;
  if (query.isError) return <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />;
  return <>{children(query.data)}</>;
}

export function ActiveBadge({ active, labels = ['Active', 'Inactive'] }: { active: boolean; labels?: [string, string] }) {
  return <Badge tone={active ? 'ok' : 'neutral'}>{active ? labels[0] : labels[1]}</Badge>;
}

/** Filters and actions above a table. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2 border-b border-line p-3', className)}>{children}</div>;
}

/** Heading for a block of fields inside a long form. */
export function FormSection({ title, description, children, action }: { title: string; description?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-ink">{title}</h3>
          {description ? <p className="text-sm text-ink-soft">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Square icon button with an accessible name (used for row actions: move up, remove...). */
export function IconButton({ label, onClick, disabled, children, className }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn('flex h-11 w-9 shrink-0 items-center justify-center rounded-control text-ink-soft hover:bg-sunken hover:text-ink disabled:pointer-events-none disabled:opacity-30', className)}
    >
      {children}
    </button>
  );
}

/** Move up / move down / remove controls for one row of an editable list. */
export function RowControls({ index, count, name, onMove, onRemove }: { index: number; count: number; name: string; onMove?: (from: number, to: number) => void; onRemove: () => void }) {
  return (
    <div className="flex items-center">
      {onMove ? (
        <>
          <IconButton label={`Move ${name} up`} disabled={index === 0} onClick={() => onMove(index, index - 1)}>
            <ArrowUp className="h-4 w-4" aria-hidden />
          </IconButton>
          <IconButton label={`Move ${name} down`} disabled={index === count - 1} onClick={() => onMove(index, index + 1)}>
            <ArrowDown className="h-4 w-4" aria-hidden />
          </IconButton>
        </>
      ) : null}
      <IconButton label={`Remove ${name}`} onClick={onRemove} className="hover:text-bad">
        <Trash2 className="h-4 w-4" aria-hidden />
      </IconButton>
    </div>
  );
}

/** A small inline error line for list-level problems ("add at least one variant"). */
export function InlineError({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="text-sm text-bad">
      {message}
    </p>
  ) : null;
}

/** Two-line table cell: a strong first line and a faint second one. */
export function TwoLine({ primary, secondary }: { primary: ReactNode; secondary?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="font-medium text-ink">{primary}</p>
      {secondary ? <p className="text-xs text-ink-faint">{secondary}</p> : null}
    </div>
  );
}
