import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Clock, Users } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CheckoutDialog } from '@/components/checkout';
import { Badge, Button, Card, cn, EmptyState, ErrorState, Field, Input, Modal, Notice, PageHeader, Select, SkeletonRows, StatusBadge, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth, useOutlet } from '@/lib/auth';
import { dateTime, minutesSince, money, timeOnly } from '@/lib/format';
import type { FloorArea, FloorTable, Order } from '@/lib/types';

interface Reservation {
  id: string;
  guestName: string;
  guestPhone: string;
  partySize: number;
  startsAt: string;
  endsAt: string;
  status: string;
  table: { id: string; name: string };
}

const TABLE_STYLE: Record<FloorTable['status'], string> = {
  AVAILABLE: 'border-ok/40 bg-ok-soft hover:brightness-95',
  OCCUPIED: 'border-brand/50 bg-brand-soft hover:brightness-95',
  RESERVED: 'border-info/40 bg-info-soft hover:brightness-95',
};

/** Actions for a table that has an open order: add items, pay, move, join, merge, split. */
function TableOrderDialog({ table, tables, onClose }: { table: FloorTable | null; tables: FloorTable[]; onClose: () => void }) {
  const { can } = useAuth();
  const notify = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'menu' | 'transfer' | 'join' | 'merge' | 'split'>('menu');
  const [paying, setPaying] = useState(false);
  const [split, setSplit] = useState<Record<string, number>>({});
  const orderId = table?.order?.id ?? null;
  const order = useQuery({ queryKey: ['order', orderId], queryFn: () => api<Order>(`/orders/${orderId}`), enabled: !!orderId });

  const close = () => {
    setMode('menu');
    setSplit({});
    onClose();
  };
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: object; done: string }) => api(`/orders/${orderId}${path}`, { method: 'POST', body }),
    onSuccess: (_, v) => {
      notify(v.done);
      for (const key of ['floor', 'orders', 'order']) void queryClient.invalidateQueries({ queryKey: [key] });
      close();
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });
  if (!table?.order) return null;

  const free = tables.filter((t) => t.status !== 'OCCUPIED' && t.isActive);
  const others = tables.filter((t) => t.status === 'OCCUPIED' && t.order && t.order.id !== orderId);
  const items = order.data?.items.filter((i) => i.status === 'ACTIVE') ?? [];
  const moving = Object.entries(split).filter(([, qty]) => qty > 0);
  const pickTable = (list: FloorTable[], onPick: (t: FloorTable) => void, empty: string) =>
    list.length === 0 ? (
      <EmptyState title={empty} />
    ) : (
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {list.map((t) => (
          <Button key={t.id} size="lg" disabled={act.isPending} onClick={() => onPick(t)}>
            {t.name}
          </Button>
        ))}
      </div>
    );

  return (
    <>
      <Modal
        open={!paying}
        onClose={close}
        title={`Table ${table.name} · ${table.order.orderNumber}`}
        description={`${table.order.itemCount} item(s) · ${money(table.order.totalMinor)} · open ${minutesSince(table.order.createdAt)} min`}
        footer={mode !== 'menu' ? <Button onClick={() => setMode('menu')}>Back</Button> : undefined}
      >
        {mode === 'menu' ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {can('order.update') ? (
              <Button size="lg" variant="primary" onClick={() => navigate(`/pos?order=${orderId}`)}>
                Add items
              </Button>
            ) : null}
            {can('payment.record') && table.order.status !== 'DRAFT' ? (
              <Button size="lg" variant="dark" onClick={() => setPaying(true)}>
                Take payment
              </Button>
            ) : null}
            <Button size="lg" onClick={() => navigate(`/orders?id=${orderId}`)}>
              View order
            </Button>
            {can('table.transfer') ? (
              <>
                <Button size="lg" onClick={() => setMode('transfer')}>
                  Move to another table
                </Button>
                <Button size="lg" onClick={() => setMode('join')}>
                  Join a free table
                </Button>
                <Button size="lg" onClick={() => setMode('merge')}>
                  Merge another order in
                </Button>
                <Button size="lg" onClick={() => setMode('split')}>
                  Split the bill
                </Button>
              </>
            ) : null}
          </div>
        ) : mode === 'transfer' ? (
          pickTable(free, (t) => act.mutate({ path: '/transfer-table', body: { tableId: t.id }, done: `Moved to ${t.name}` }), 'No free tables')
        ) : mode === 'join' ? (
          pickTable(free, (t) => act.mutate({ path: '/attach-table', body: { tableId: t.id }, done: `${t.name} joined to this order` }), 'No free tables')
        ) : mode === 'merge' ? (
          <div className="flex flex-col gap-3">
            <Notice tone="info">Everything on the table you choose moves onto this bill, and that table is freed. Orders with payments cannot be merged.</Notice>
            {pickTable(others, (t) => act.mutate({ path: '/merge', body: { sourceOrderId: t.order!.id }, done: `Merged ${t.name} into ${table.name}` }), 'No other occupied tables')}
          </div>
        ) : order.isPending ? (
          <SkeletonRows rows={3} />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-soft">Choose what moves to a separate bill. Each bill is then paid on its own.</p>
            <ul className="divide-y divide-line rounded-card border border-line">
              {items.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 px-4 py-2">
                  <span className="text-sm">
                    {i.productName} <span className="text-ink-faint">({i.quantity} on bill)</span>
                  </span>
                  <Select aria-label={`Quantity of ${i.productName} to move`} className="w-24" value={split[i.id] ?? 0} onChange={(e) => setSplit((s) => ({ ...s, [i.id]: Number(e.target.value) }))}>
                    {Array.from({ length: i.quantity + 1 }, (_, n) => (
                      <option key={n} value={n}>
                        {n === 0 ? 'Keep' : `Move ${n}`}
                      </option>
                    ))}
                  </Select>
                </li>
              ))}
            </ul>
            <Button variant="primary" size="lg" disabled={moving.length === 0} loading={act.isPending} onClick={() => act.mutate({ path: '/split', body: { items: moving.map(([itemId, quantity]) => ({ itemId, quantity })) }, done: 'Bill split. The new bill is in Orders.' })}>
              Split bill
            </Button>
          </div>
        )}
      </Modal>
      <CheckoutDialog
        orderId={orderId}
        open={paying}
        onClose={() => {
          setPaying(false);
          close();
        }}
      />
    </>
  );
}

function ReservationDialog({ open, onClose, tables }: { open: boolean; onClose: () => void; tables: FloorTable[] }) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ tableId: '', guestName: '', guestPhone: '', partySize: '2', startsAt: '', minutes: '90' });
  const set = (change: Partial<typeof form>) => setForm((f) => ({ ...f, ...change }));
  const start = form.startsAt ? new Date(form.startsAt) : null;
  const valid = form.tableId && form.guestName.trim() && start && !Number.isNaN(start.getTime()) && Number(form.partySize) > 0;
  const create = useMutation({
    mutationFn: () =>
      api('/reservations', {
        method: 'POST',
        body: { tableId: form.tableId, guestName: form.guestName.trim(), guestPhone: form.guestPhone.trim(), partySize: Number(form.partySize), startsAt: start!.toISOString(), endsAt: new Date(start!.getTime() + Number(form.minutes) * 60_000).toISOString() },
      }),
    onSuccess: () => {
      notify('Reservation saved');
      void queryClient.invalidateQueries({ queryKey: ['floor'] });
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      onClose();
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New reservation"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>
            Save reservation
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Guest name">{(p) => <Input {...p} value={form.guestName} maxLength={120} onChange={(e) => set({ guestName: e.target.value })} />}</Field>
        <Field label="Phone (optional)">{(p) => <Input {...p} inputMode="tel" value={form.guestPhone} maxLength={20} onChange={(e) => set({ guestPhone: e.target.value })} />}</Field>
        <Field label="Table">
          {(p) => (
            <Select {...p} value={form.tableId} onChange={(e) => set({ tableId: e.target.value })}>
              <option value="">Choose…</option>
              {tables.filter((t) => t.isActive).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.capacity} seats)
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Guests">{(p) => <Input {...p} type="number" min={1} max={100} value={form.partySize} onChange={(e) => set({ partySize: e.target.value })} />}</Field>
        <Field label="Date and time" hint="In this device's time zone.">{(p) => <Input {...p} type="datetime-local" value={form.startsAt} onChange={(e) => set({ startsAt: e.target.value })} />}</Field>
        <Field label="Duration">
          {(p) => (
            <Select {...p} value={form.minutes} onChange={(e) => set({ minutes: e.target.value })}>
              {[60, 90, 120, 180].map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </Select>
          )}
        </Field>
        {create.isError ? <Notice tone="bad" className="sm:col-span-2">{errorMessage(create.error)}</Notice> : null}
      </div>
    </Modal>
  );
}

export function FloorPage() {
  const outlet = useOutlet();
  const { can } = useAuth();
  const notify = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<FloorTable | null>(null);
  const [booking, setBooking] = useState(false);

  // Live updates arrive over the socket; the slow poll is only a safety net.
  const floor = useQuery({ queryKey: ['floor'], queryFn: () => api<FloorArea[]>('/floor'), refetchInterval: 30_000 });
  const reservations = useQuery({ queryKey: ['reservations'], queryFn: () => api<Reservation[]>('/reservations') });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api(`/reservations/${id}`, { method: 'PATCH', body: { status } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['floor'] });
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });

  const tables = floor.data?.flatMap((a) => a.tables) ?? [];
  const counts = { AVAILABLE: 0, OCCUPIED: 0, RESERVED: 0 };
  for (const t of tables) if (t.isActive) counts[t.status] += 1;
  const upcoming = reservations.data?.filter((r) => r.status === 'BOOKED' || r.status === 'SEATED') ?? [];

  const open = (table: FloorTable) => {
    // Occupied only by guests' own prepaid orders: there is no table bill to manage, so show those orders.
    if (table.status === 'OCCUPIED' && !table.order) return navigate(`/orders?q=${encodeURIComponent(table.name)}`);
    if (table.status === 'OCCUPIED') return setSelected(table);
    if (!can('order.create')) return;
    navigate(`/pos?table=${table.id}&tableName=${encodeURIComponent(table.name)}`);
  };

  return (
    <>
      <PageHeader
        title="Tables"
        description="Tap a free table to start an order, or an occupied one to manage it. Status comes from each table's open order and bookings."
        actions={
          can('reservation.manage') ? (
            <Button onClick={() => setBooking(true)}>
              <CalendarClock className="h-4 w-4" aria-hidden /> New reservation
            </Button>
          ) : null
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge tone="ok">{counts.AVAILABLE} available</Badge>
        <Badge tone="brand">{counts.OCCUPIED} occupied</Badge>
        <Badge tone="info">{counts.RESERVED} reserved</Badge>
      </div>

      {floor.isPending ? (
        <Card>
          <SkeletonRows />
        </Card>
      ) : floor.isError ? (
        <Card>
          <ErrorState message={errorMessage(floor.error)} onRetry={() => void floor.refetch()} />
        </Card>
      ) : tables.length === 0 ? (
        <Card>
          <EmptyState title="No tables yet" description="Add dining areas and tables in Outlet set-up." />
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {floor.data.filter((a) => a.isActive && a.tables.some((t) => t.isActive)).map((area) => (
            <section key={area.id} aria-label={area.name}>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-faint">{area.name}</h2>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                {area.tables.filter((t) => t.isActive).map((t) => (
                  <li key={t.id}>
                    <button type="button" onClick={() => open(t)} className={cn('flex h-full min-h-32 w-full flex-col justify-between border p-3 text-left transition-all', t.shape === 'round' ? 'rounded-[2rem]' : 'rounded-card', TABLE_STYLE[t.status])}>
                      <span className="flex items-start justify-between gap-2">
                        <span className="text-xl font-bold text-ink">{t.name}</span>
                        <StatusBadge status={t.status} />
                      </span>
                      {t.order ? (
                        <span className="text-sm text-ink">
                          <span className="tabular block font-semibold">{money(t.order.totalMinor)}</span>
                          <span className="flex items-center gap-1 text-ink-soft">
                            <Clock className="h-3.5 w-3.5" aria-hidden /> {minutesSince(t.order.createdAt)} min · {t.order.itemCount} items
                          </span>
                          <span className="mt-1 flex flex-wrap gap-1">
                            <StatusBadge status={t.order.isHeld ? 'DRAFT' : t.order.status} />
                            {t.order.paymentStatus === 'PAID' ? <Badge tone="ok">Paid</Badge> : null}
                          </span>
                          {t.order.waiterName ? <span className="block text-xs text-ink-faint">{t.order.waiterName}</span> : null}
                          {t.guestOrders > 0 ? <Badge tone="brand" className="mt-1">+{t.guestOrders} QR</Badge> : null}
                        </span>
                      ) : t.guestOrders > 0 ? (
                        <span className="text-sm text-ink">
                          <Badge tone="brand">{t.guestOrders} QR order{t.guestOrders === 1 ? '' : 's'}</Badge>
                          <span className="mt-1 block text-ink-soft">Paid by guests</span>
                        </span>
                      ) : t.reservation ? (
                        <span className="text-sm text-ink-soft">
                          {t.reservation.guestName} · {t.reservation.partySize} guests
                          <span className="block">{timeOnly(t.reservation.startsAt, outlet.timezone)}</span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-sm text-ink-soft">
                          <Users className="h-3.5 w-3.5" aria-hidden /> {t.capacity} seats
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-faint">Reservations</h2>
        <Card>
          {reservations.isPending ? (
            <SkeletonRows rows={2} />
          ) : reservations.isError ? (
            <ErrorState message={errorMessage(reservations.error)} onRetry={() => void reservations.refetch()} />
          ) : upcoming.length === 0 ? (
            <EmptyState title="No upcoming reservations" />
          ) : (
            <ul className="divide-y divide-line">
              {upcoming.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="font-medium text-ink">
                      {r.guestName} · {r.partySize} guests · Table {r.table.name}
                    </p>
                    <p className="text-sm text-ink-soft">
                      {dateTime(r.startsAt, outlet.timezone)} – {timeOnly(r.endsAt, outlet.timezone)} {r.guestPhone ? `· ${r.guestPhone}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={r.status} />
                    {can('reservation.manage') ? (
                      <>
                        {r.status === 'BOOKED' ? (
                          <Button size="sm" onClick={() => setStatus.mutate({ id: r.id, status: 'SEATED' })}>
                            Seated
                          </Button>
                        ) : (
                          <Button size="sm" onClick={() => setStatus.mutate({ id: r.id, status: 'COMPLETED' })}>
                            Finished
                          </Button>
                        )}
                        {r.status === 'BOOKED' ? (
                          <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: r.id, status: 'NO_SHOW' })}>
                            No-show
                          </Button>
                        ) : null}
                        <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: r.id, status: 'CANCELLED' })}>
                          Cancel
                        </Button>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <TableOrderDialog table={selected} tables={tables} onClose={() => setSelected(null)} />
      <ReservationDialog key={String(booking)} open={booking} onClose={() => setBooking(false)} tables={tables} />
    </>
  );
}
