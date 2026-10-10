import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, cn, DataTable, EmptyState, ErrorState, Field, Input, Modal, Notice, PageHeader, Select, SkeletonRows, StatusBadge, Textarea, useToast, type Column } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth, useOutlet } from '@/lib/auth';
import { dateTime, money, parseAmount, titleCase } from '@/lib/format';
import type { ShiftSummary } from '@/lib/types';

interface Register {
  id: string;
  name: string;
  isActive: boolean;
  shifts: Array<{ id: string; openedByName: string }>;
}
type ShiftRow = ShiftSummary['shift'];

function Line({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'bad' | 'ok' }) {
  return (
    <div className={cn('flex justify-between gap-4 py-1.5', strong && 'border-t border-line pt-2 text-base font-bold text-ink', tone === 'bad' && 'text-bad', tone === 'ok' && 'text-ok')}>
      <dt>{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}

/** Cash and payment-method reconciliation for one shift. */
function Reconciliation({ summary }: { summary: ShiftSummary }) {
  const { cash, shift, byMethod } = summary;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4">
        <h3 className="mb-2 font-semibold text-ink">Cash drawer</h3>
        <dl className="text-sm text-ink-soft">
          <Line label="Opening float" value={money(cash.openingFloatMinor)} />
          <Line label="Cash sales" value={money(cash.salesMinor)} />
          <Line label="Cash refunds" value={money(cash.refundsMinor)} />
          <Line label="Cash in" value={money(cash.cashInMinor)} />
          <Line label="Cash out" value={money(cash.cashOutMinor)} />
          <Line label="Petty cash" value={money(cash.pettyCashMinor)} />
          <Line label="Expected in drawer" value={money(cash.expectedCashMinor)} strong />
          {shift.status === 'CLOSED' ? (
            <>
              <Line label="Counted" value={money(shift.countedCashMinor)} />
              <Line label="Variance" value={money(shift.varianceMinor)} tone={(shift.varianceMinor ?? 0) === 0 ? 'ok' : 'bad'} />
            </>
          ) : null}
        </dl>
        <p className="mt-2 text-xs text-ink-faint">Only cash counts towards the drawer. Card, UPI and other digital payments are listed separately and never added to expected cash.</p>
      </Card>
      <Card className="p-4">
        <h3 className="mb-2 font-semibold text-ink">Collected by method</h3>
        {byMethod.length === 0 ? (
          <p className="text-sm text-ink-faint">No payments in this shift yet.</p>
        ) : (
          <dl className="text-sm text-ink-soft">
            {byMethod.map((m) => (
              <Line key={m.method} label={`${titleCase(m.method)} (${m.count})${m.refundedMinor ? ` · refunded ${money(m.refundedMinor)}` : ''}`} value={money(m.netMinor)} />
            ))}
          </dl>
        )}
      </Card>
    </div>
  );
}

function ShiftDetailDialog({ shiftId, onClose }: { shiftId: string | null; onClose: () => void }) {
  const outlet = useOutlet();
  const detail = useQuery({ queryKey: ['shift', shiftId], queryFn: () => api<ShiftSummary>(`/shifts/${shiftId}`), enabled: !!shiftId });
  const { me, can } = useAuth();
  const notify = useToast();
  const queryClient = useQueryClient();
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  // A manager can close a cashier's open shift, which is how a large variance gets approved.
  const close = useMutation({
    mutationFn: () => api(`/shifts/${shiftId}/close`, { method: 'POST', body: { countedCashMinor: parseAmount(counted), note: note.trim() } }),
    onSuccess: () => {
      notify('Shift closed');
      setCounted('');
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['shift'] });
    },
  });
  const managerClose = detail.data?.shift.status === 'OPEN' && detail.data.shift.openedById !== me?.user.id && can('shift.manage');
  return (
    <Modal open={!!shiftId} onClose={onClose} size="xl" title="Shift summary" description={detail.data ? `${detail.data.shift.register.name} · ${detail.data.shift.openedByName} · opened ${dateTime(detail.data.shift.openedAt, outlet.timezone)}` : undefined}>
      {detail.isPending ? (
        <SkeletonRows />
      ) : detail.isError ? (
        <ErrorState message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <Reconciliation summary={detail.data} />
          {managerClose ? (
            <Card className="flex flex-wrap items-end gap-3 p-4">
              <Field label="Counted cash" className="w-40">{(p) => <Input {...p} inputMode="decimal" className="tabular" value={counted} onChange={(e) => setCounted(e.target.value)} />}</Field>
              <Field label="Note" className="min-w-48 flex-1">{(p) => <Input {...p} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />}</Field>
              <Button variant="dark" disabled={parseAmount(counted) == null} loading={close.isPending} onClick={() => close.mutate()}>
                Close this shift as manager
              </Button>
              {close.isError ? <Notice tone="bad" className="w-full">{errorMessage(close.error)}</Notice> : null}
            </Card>
          ) : null}
          {detail.data.shift.closeNote ? <Notice tone="info" title="Closing note">{detail.data.shift.closeNote}</Notice> : null}
          <Movements summary={detail.data} />
        </div>
      )}
    </Modal>
  );
}

function Movements({ summary }: { summary: ShiftSummary }) {
  const outlet = useOutlet();
  const columns: Array<Column<ShiftSummary['movements'][number]>> = [
    { key: 'time', header: 'Time', cell: (m) => dateTime(m.createdAt, outlet.timezone) },
    { key: 'type', header: 'Type', cell: (m) => titleCase(m.type) },
    { key: 'reason', header: 'Reason', cell: (m) => m.reason || <span className="text-ink-faint">—</span> },
    { key: 'amount', header: 'Amount', align: 'right', cell: (m) => <span className={m.amountMinor < 0 ? 'text-bad' : ''}>{money(m.amountMinor)}</span> },
  ];
  return (
    <Card>
      <h3 className="border-b border-line px-4 py-3 font-semibold text-ink">Cash movements</h3>
      <DataTable columns={columns} rows={summary.movements} rowKey={(m) => m.id} empty={<EmptyState title="No cash movements yet" />} />
    </Card>
  );
}

export function ShiftPage() {
  const outlet = useOutlet();
  const { can } = useAuth();
  const notify = useToast();
  const queryClient = useQueryClient();
  const [registerId, setRegisterId] = useState('');
  const [float, setFloat] = useState('');
  const [movement, setMovement] = useState<null | 'CASH_IN' | 'CASH_OUT' | 'PETTY_CASH'>(null);
  const [movementAmount, setMovementAmount] = useState('');
  const [movementReason, setMovementReason] = useState('');
  const [closing, setClosing] = useState(false);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);

  const current = useQuery({ queryKey: ['shift', 'current'], queryFn: () => api<ShiftSummary | null>('/shifts/current') });
  const registers = useQuery({ queryKey: ['shift', 'registers'], queryFn: () => api<Register[]>('/registers') });
  const history = useQuery({ queryKey: ['shift', 'list'], queryFn: () => api<Array<ShiftRow & { register: { name: string } }>>('/shifts') });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['shift'] });
  const summary = current.data && 'shift' in current.data ? current.data : null;

  const openShift = useMutation({
    mutationFn: () => api('/shifts/open', { method: 'POST', body: { registerId, openingFloatMinor: parseAmount(float || '0') } }),
    onSuccess: () => {
      notify('Shift opened');
      setFloat('');
      refresh();
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });
  const addMovement = useMutation({
    mutationFn: () => api(`/shifts/${summary!.shift.id}/movements`, { method: 'POST', body: { type: movement, amountMinor: parseAmount(movementAmount), reason: movementReason.trim() } }),
    onSuccess: () => {
      notify('Cash movement recorded');
      setMovement(null);
      setMovementAmount('');
      setMovementReason('');
      refresh();
    },
  });
  const closeShift = useMutation({
    mutationFn: () => api(`/shifts/${summary!.shift.id}/close`, { method: 'POST', body: { countedCashMinor: parseAmount(counted), note: note.trim() } }),
    onSuccess: () => {
      notify('Shift closed');
      setClosing(false);
      setCounted('');
      setNote('');
      refresh();
    },
  });

  const countedMinor = parseAmount(counted);
  const variance = summary && countedMinor != null ? countedMinor - summary.cash.expectedCashMinor : null;
  const needsApproval = closeShift.error instanceof ApiError && closeShift.error.code === 'VARIANCE_NEEDS_APPROVAL';
  const columns: Array<Column<ShiftRow & { register: { name: string } }>> = [
    { key: 'opened', header: 'Opened', cell: (s) => dateTime(s.openedAt, outlet.timezone) },
    { key: 'register', header: 'Register', cell: (s) => s.register.name },
    { key: 'by', header: 'Cashier', cell: (s) => s.openedByName },
    { key: 'status', header: 'Status', cell: (s) => <StatusBadge status={s.status} /> },
    { key: 'expected', header: 'Expected', align: 'right', cell: (s) => (s.expectedCashMinor == null ? '—' : money(s.expectedCashMinor)), className: 'hidden sm:table-cell' },
    { key: 'variance', header: 'Variance', align: 'right', cell: (s) => (s.varianceMinor == null ? '—' : <span className={s.varianceMinor === 0 ? 'text-ok' : 'text-bad'}>{money(s.varianceMinor)}</span>) },
  ];

  return (
    <>
      <PageHeader title="Cash shift" description="Open a shift before taking cash. Close it by counting the drawer; the difference from the expected amount is recorded." />
      {current.isPending ? (
        <Card>
          <SkeletonRows rows={4} />
        </Card>
      ) : current.isError ? (
        <Card>
          <ErrorState message={errorMessage(current.error)} onRetry={() => void current.refetch()} />
        </Card>
      ) : summary ? (
        <div className="flex flex-col gap-4">
          <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="text-lg font-bold text-ink">
                {summary.shift.register.name} <Badge tone="ok">Open</Badge>
              </p>
              <p className="text-sm text-ink-soft">
                Opened by {summary.shift.openedByName} · {dateTime(summary.shift.openedAt, outlet.timezone)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setMovement('CASH_IN')}>Cash in</Button>
              <Button onClick={() => setMovement('CASH_OUT')}>Cash out</Button>
              <Button onClick={() => setMovement('PETTY_CASH')}>Petty cash</Button>
              <Button variant="dark" onClick={() => setClosing(true)}>
                Close shift
              </Button>
            </div>
          </Card>
          <Reconciliation summary={summary} />
          <Movements summary={summary} />
        </div>
      ) : (
        <Card className="max-w-lg p-5">
          <h2 className="text-lg font-bold text-ink">Open a shift</h2>
          <p className="mt-1 text-sm text-ink-soft">Count the cash already in the drawer and enter it as the opening float.</p>
          <form
            className="mt-4 flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              openShift.mutate();
            }}
          >
            <Field label="Register">
              {(p) => (
                <Select {...p} value={registerId} onChange={(e) => setRegisterId(e.target.value)}>
                  <option value="">Choose…</option>
                  {registers.data?.filter((r) => r.isActive).map((r) => (
                    <option key={r.id} value={r.id} disabled={r.shifts.length > 0}>
                      {r.name}
                      {r.shifts[0] ? ` — in use by ${r.shifts[0].openedByName}` : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Opening float" error={float && parseAmount(float) == null ? 'Enter a valid amount' : undefined}>
              {(p) => <Input {...p} inputMode="decimal" className="tabular" placeholder="0.00" value={float} onChange={(e) => setFloat(e.target.value)} />}
            </Field>
            <Button type="submit" variant="primary" size="lg" disabled={!registerId || (float !== '' && parseAmount(float) == null)} loading={openShift.isPending}>
              Open shift
            </Button>
          </form>
        </Card>
      )}

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-ink-faint">{can('shift.view_all') ? 'Shifts in this outlet' : 'Your shifts'}</h2>
      <Card>
        {history.isPending ? (
          <SkeletonRows rows={3} />
        ) : history.isError ? (
          <ErrorState message={errorMessage(history.error)} onRetry={() => void history.refetch()} />
        ) : (
          <DataTable columns={columns} rows={history.data} rowKey={(s) => s.id} onRowClick={(s) => setViewing(s.id)} empty={<EmptyState title="No shifts yet" />} />
        )}
      </Card>

      <Modal
        open={!!movement}
        onClose={() => setMovement(null)}
        size="sm"
        title={movement === 'CASH_IN' ? 'Add cash to the drawer' : movement === 'CASH_OUT' ? 'Take cash out of the drawer' : 'Petty cash expense'}
        footer={
          <>
            <Button onClick={() => setMovement(null)}>Cancel</Button>
            <Button variant="primary" disabled={!parseAmount(movementAmount) || movementReason.trim().length < 3} loading={addMovement.isPending} onClick={() => addMovement.mutate()}>
              Record
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Amount">{(p) => <Input {...p} inputMode="decimal" className="tabular" autoFocus value={movementAmount} onChange={(e) => setMovementAmount(e.target.value)} />}</Field>
          <Field label="Reason" hint="Required, for the audit trail.">{(p) => <Textarea {...p} value={movementReason} maxLength={300} onChange={(e) => setMovementReason(e.target.value)} />}</Field>
          {addMovement.isError ? <Notice tone="bad">{errorMessage(addMovement.error)}</Notice> : null}
        </div>
      </Modal>

      <Modal
        open={closing}
        onClose={() => setClosing(false)}
        size="sm"
        title="Close shift"
        description="Count the cash in the drawer. A closed shift cannot be changed."
        footer={
          <>
            <Button onClick={() => setClosing(false)}>Cancel</Button>
            <Button variant="dark" disabled={countedMinor == null} loading={closeShift.isPending} onClick={() => closeShift.mutate()}>
              Close shift
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Counted cash" hint={summary ? `Expected ${money(summary.cash.expectedCashMinor)}${variance != null ? ` · variance ${money(variance)}` : ''}` : undefined}>
            {(p) => <Input {...p} inputMode="decimal" className="tabular h-12 text-lg" autoFocus value={counted} onChange={(e) => setCounted(e.target.value)} />}
          </Field>
          <Field label="Note (optional)">{(p) => <Textarea {...p} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />}</Field>
          {needsApproval ? (
            <Notice tone="warn" title="A manager must close this shift">
              The difference is larger than your restaurant allows a cashier to close alone. Recount, or ask a manager to sign in and close it.
            </Notice>
          ) : closeShift.isError ? (
            <Notice tone="bad">{errorMessage(closeShift.error)}</Notice>
          ) : null}
        </div>
      </Modal>
      <ShiftDetailDialog shiftId={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
