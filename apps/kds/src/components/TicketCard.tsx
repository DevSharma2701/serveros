import clsx from 'clsx';
import { AlertTriangle, Check, CheckCheck, Clock, Flame, Play, Undo2 } from 'lucide-react';
import { formatAge, formatClock, isAllergyNote, ORDER_TYPE_LABEL, urgency, type Urgency } from '../lib/format';
import type { BumpStatus, Ticket, TicketItem } from '../lib/types';

interface Props {
  ticket: Ticket;
  now: number;
  warnMinutes: number;
  overdueMinutes: number;
  /** The user holds kitchen.update. Without it the card is read-only: no buttons at all. */
  canUpdate: boolean;
  /** Buttons are shown but disabled (offline, or a change for this ticket is in flight). */
  disabled: boolean;
  disabledReason?: string;
  busy: boolean;
  isNew: boolean;
  onStatus(status: BumpStatus): void;
  onItem(item: TicketItem): void;
}

const STATUS_LABEL = { PENDING: 'Waiting', PREPARING: 'Preparing', READY: 'Ready', CANCELLED: 'Cancelled' } as const;

/** The single next step for a ticket. A ready ticket can only be recalled to the line. */
const NEXT_ACTION = {
  PENDING: { label: 'Start', to: 'PREPARING', Icon: Play, tone: 'bg-brand text-white hover:bg-brand-strong' },
  PREPARING: { label: 'Ready', to: 'READY', Icon: CheckCheck, tone: 'bg-kds-ok text-kds-bg hover:brightness-110' },
  READY: { label: 'Recall', to: 'PREPARING', Icon: Undo2, tone: 'bg-kds-raised text-kds-ink border-2 border-kds-line hover:bg-kds-line' },
  CANCELLED: null,
} as const;

const URGENCY_STYLE: Record<Urgency, string> = {
  ok: 'border-kds-line',
  late: 'border-kds-warn',
  overdue: 'border-kds-bad',
};

function Note({ text, label }: { text: string; label: string }) {
  const allergy = isAllergyNote(text);
  return (
    <p className={clsx('flex items-start gap-2 rounded-control px-3 py-2 text-lg font-semibold', allergy ? 'bg-kds-bad text-kds-bg' : 'bg-kds-warn/15 text-kds-warn')}>
      {allergy && <AlertTriangle aria-hidden className="mt-0.5 size-6 shrink-0" />}
      <span>
        <span className="uppercase tracking-wide">{allergy ? 'Allergy' : label}: </span>
        {text}
      </span>
    </p>
  );
}

export function TicketCard({ ticket, now, warnMinutes, overdueMinutes, canUpdate, disabled, disabledReason, busy, isNew, onStatus, onItem }: Props) {
  const isReady = ticket.status === 'READY';
  const fired = Date.parse(ticket.firedAt);
  // A ready ticket's clock stops at the moment it was bumped.
  const ageMs = (isReady && ticket.readyAt ? Date.parse(ticket.readyAt) : now) - fired;
  const level: Urgency = isReady ? 'ok' : urgency(ageMs, warnMinutes, overdueMinutes);
  const action = NEXT_ACTION[ticket.status];
  // Items are tappable only on the line: un-ticking an item of a ready ticket is what Recall is for.
  const itemsTappable = canUpdate && !isReady;

  return (
    <article
      aria-label={`Ticket ${ticket.ticketNumber}`}
      data-urgency={level}
      className={clsx('flex flex-col overflow-hidden rounded-card border-4 bg-kds-card', URGENCY_STYLE[level], isNew && 'animate-kds-flash')}
    >
      <header className={clsx('flex flex-col gap-1 px-4 py-3', level === 'overdue' ? 'bg-kds-bad/25' : level === 'late' ? 'bg-kds-warn/20' : 'bg-kds-raised')}>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-3xl font-extrabold tracking-tight">
            {ticket.ticketNumber}
            {isNew && <span className="ml-2 rounded-control bg-kds-info px-2 py-0.5 align-middle text-base font-bold text-kds-bg">NEW</span>}
          </h2>
          <p className="tabular flex items-center gap-2 font-mono text-3xl font-bold" aria-label={`${isReady ? 'Took' : 'Age'} ${formatAge(ageMs)}`}>
            <Clock aria-hidden className="size-6" />
            <span data-testid="age">{formatAge(ageMs)}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xl font-semibold">
          <span className="rounded-control bg-kds-ink px-2 text-kds-bg">{ORDER_TYPE_LABEL[ticket.orderType]}</span>
          {ticket.tableLabel && <span>Table {ticket.tableLabel}</span>}
          <span className="text-kds-faint">{ticket.station.name}</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-lg">
          <span className="text-kds-faint">Order {ticket.orderNumber}</span>
          <span className="flex items-center gap-2 font-bold">
            {/* Urgency is always written out; colour is only reinforcement. */}
            {level === 'overdue' && (
              <span className="flex items-center gap-1 rounded-control bg-kds-bad px-2 text-kds-bg">
                <Flame aria-hidden className="size-5" /> OVERDUE
              </span>
            )}
            {level === 'late' && (
              <span className="flex items-center gap-1 rounded-control bg-kds-warn px-2 text-kds-bg">
                <AlertTriangle aria-hidden className="size-5" /> LATE
              </span>
            )}
            <span>{isReady && ticket.readyAt ? `Ready ${formatClock(ticket.readyAt)}` : STATUS_LABEL[ticket.status]}</span>
          </span>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-2 p-3">
        {ticket.notes && <Note text={ticket.notes} label="Order note" />}
        <ul className="flex flex-col gap-2">
          {ticket.items.map((item) => {
            const body = (
              <>
                <span className="tabular w-12 shrink-0 text-right text-2xl font-extrabold">{item.quantity}×</span>
                <span className="min-w-0 flex-1">
                  <span className={clsx('block text-2xl font-bold leading-tight', (item.isPrepared || item.isCancelled) && 'line-through opacity-60')}>{item.name}</span>
                  {item.isCancelled && <span className="block text-lg font-bold text-kds-bad">CANCELLED - do not make</span>}
                  {item.modifiers && <span className="block text-xl text-kds-info">+ {item.modifiers}</span>}
                  {item.notes && <Note text={item.notes} label="Note" />}
                </span>
                {item.isPrepared && !item.isCancelled && (
                  <span className="flex shrink-0 items-center gap-1 text-lg font-bold text-kds-ok">
                    <Check aria-hidden className="size-6" /> Done
                  </span>
                )}
              </>
            );
            return (
              <li key={item.id}>
                {itemsTappable && !item.isCancelled ? (
                  <button
                    type="button"
                    aria-pressed={item.isPrepared}
                    disabled={disabled}
                    title={disabled ? disabledReason : item.isPrepared ? 'Mark as not prepared' : 'Mark as prepared'}
                    onClick={() => onItem(item)}
                    className="flex min-h-14 w-full items-start gap-3 rounded-control bg-kds-raised px-2 py-2 text-left hover:bg-kds-line"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex min-h-14 items-start gap-3 px-2 py-2">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {canUpdate && action && (
        <footer className="p-3 pt-0">
          <button
            type="button"
            disabled={disabled}
            aria-busy={busy}
            title={disabled ? disabledReason : undefined}
            aria-label={`${action.label} ticket ${ticket.ticketNumber}`}
            onClick={() => onStatus(action.to)}
            className={clsx('flex min-h-16 w-full items-center justify-center gap-3 rounded-control text-2xl font-extrabold', action.tone)}
          >
            <action.Icon aria-hidden className="size-7" />
            {busy ? 'Saving…' : action.label}
          </button>
        </footer>
      )}
    </article>
  );
}
