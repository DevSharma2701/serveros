import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Minus, Plus, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, cn, ConfirmDialog, Drawer, EmptyState, ErrorState, Field, Input, Modal, Notice, SearchInput, Segmented, SkeletonRows, StatusBadge, Textarea, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, money, parseAmount, percent } from '@/lib/format';
import type { Catalog, CatalogProduct, Customer, FloorArea, OrderSummary, Paged } from '@/lib/types';
import type { QueuedOrder } from '@/offline/queue';
import { useSyncQueue } from '@/offline/useSyncQueue';
import { modifierProblem, type CartDiscount, type CartLine, type CartState } from './cart';

// ───────────── Product options (variant, add-ons, notes) ─────────────

export function ProductOptionsDialog({ product, catalog, onClose, onAdd }: { product: CatalogProduct | null; catalog: Catalog; onClose: () => void; onAdd: (line: Omit<CartLine, 'lineId' | 'discount'>) => void }) {
  const [variantId, setVariantId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!product) return;
    setVariantId((product.variants.find((v) => v.isDefault) ?? product.variants[0])!.id);
    setSelected([]);
    setQuantity(1);
    setNotes('');
  }, [product]);
  if (!product) return null;

  const groups = product.modifierGroupIds.map((id) => catalog.modifierGroups.find((g) => g.id === id)).filter((g) => !!g);
  const variant = product.variants.find((v) => v.id === variantId) ?? product.variants[0]!;
  const options = groups.flatMap((g) => g.options.filter((o) => selected.includes(o.id)).map((o) => ({ id: o.id, name: o.name, groupName: g.name, priceMinor: o.priceMinor })));
  const problem = modifierProblem(catalog, product, selected);
  const unit = variant.priceMinor + options.reduce((a, o) => a + o.priceMinor, 0);

  const toggle = (groupId: string, optionId: string) => {
    const group = groups.find((g) => g.id === groupId)!;
    setSelected((current) => {
      if (current.includes(optionId)) return current.filter((id) => id !== optionId);
      // A single-choice group behaves like radio buttons.
      if (group.maxSelect === 1) return [...current.filter((id) => !group.options.some((o) => o.id === id)), optionId];
      return [...current, optionId];
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={product.name}
      description={product.description || undefined}
      footer={
        <>
          <div className="mr-auto flex items-center gap-2">
            <Button size="icon" aria-label="Decrease quantity" onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
              <Minus className="h-4 w-4" />
            </Button>
            <span aria-live="polite" className="tabular w-8 text-center text-lg font-bold">
              {quantity}
            </span>
            <Button size="icon" aria-label="Increase quantity" onClick={() => setQuantity((q) => Math.min(99, q + 1))}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <Button
            variant="primary"
            size="lg"
            disabled={!!problem}
            onClick={() => {
              onAdd({ productId: product.id, variantId: variant.id, name: product.name, variantName: variant.name, quantity, unitPriceMinor: variant.priceMinor, modifiers: options, notes: notes.trim() });
              onClose();
            }}
          >
            Add · {money(unit * quantity, catalog.settings.currency)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {product.variants.length > 1 ? (
          <fieldset>
            <legend className="mb-2 text-sm font-semibold text-ink">Size</legend>
            <div className="grid grid-cols-2 gap-2">
              {product.variants.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="radio"
                  aria-checked={v.id === variantId}
                  onClick={() => setVariantId(v.id)}
                  className={cn('flex min-h-14 items-center justify-between rounded-control border px-4 text-left text-sm font-semibold', v.id === variantId ? 'border-brand bg-brand-soft text-brand-strong' : 'border-line-strong hover:bg-sunken')}
                >
                  <span>{v.name}</span>
                  <span className="tabular">{money(v.priceMinor, catalog.settings.currency)}</span>
                </button>
              ))}
            </div>
          </fieldset>
        ) : null}
        {groups.map((g) => (
          <fieldset key={g.id}>
            <legend className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
              {g.name}
              <Badge tone={g.minSelect > 0 ? 'brand' : 'neutral'}>{g.minSelect > 0 ? 'Required' : 'Optional'}</Badge>
              {g.maxSelect > 1 ? <span className="font-normal text-ink-faint">up to {g.maxSelect}</span> : null}
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {g.options.map((o) => {
                const on = selected.includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    role={g.maxSelect === 1 ? 'radio' : 'checkbox'}
                    aria-checked={on}
                    onClick={() => toggle(g.id, o.id)}
                    className={cn('flex min-h-12 items-center justify-between rounded-control border px-3 text-left text-sm', on ? 'border-brand bg-brand-soft font-semibold text-brand-strong' : 'border-line-strong hover:bg-sunken')}
                  >
                    <span>{o.name}</span>
                    {o.priceMinor > 0 ? <span className="tabular">+{money(o.priceMinor, catalog.settings.currency)}</span> : null}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
        <Field label="Preparation note (optional)" hint="Shown to the kitchen, e.g. “no onion”.">
          {(p) => <Input {...p} value={notes} maxLength={200} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
        {problem ? <Notice tone="warn">{problem}</Notice> : null}
      </div>
    </Modal>
  );
}

// ───────────── Discount ─────────────

export function DiscountDialog({ open, onClose, title, baseMinor, current, onApply, allowCoupon, coupon, onCoupon }: {
  open: boolean;
  onClose: () => void;
  title: string;
  baseMinor: number;
  current: CartDiscount | null;
  onApply: (discount: CartDiscount | null) => void;
  allowCoupon?: boolean;
  coupon?: string | null;
  onCoupon?: (code: string | null) => void;
}) {
  const { me, can } = useAuth();
  const [mode, setMode] = useState<'PERCENT' | 'FLAT' | 'COUPON'>('PERCENT');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!open) return;
    setMode(coupon ? 'COUPON' : (current?.type ?? 'PERCENT'));
    setValue(coupon ?? (current ? String(current.value / 100) : ''));
    setReason(current?.reason ?? '');
  }, [open, current, coupon]);

  const threshold = me?.restaurant?.discountApprovalThresholdBps ?? 0;
  const parsed = mode === 'PERCENT' ? Math.round(Number(value) * 100) : (parseAmount(value) ?? NaN);
  const discountMinor = mode === 'PERCENT' ? Math.round((baseMinor * parsed) / 10_000) : parsed;
  const shareBps = baseMinor > 0 ? (discountMinor * 10_000) / baseMinor : 0;
  const valid = mode === 'COUPON' ? value.trim().length >= 3 : Number.isFinite(parsed) && parsed > 0 && (mode === 'FLAT' || parsed <= 10_000) && reason.trim().length >= 3;
  const needsManager = mode !== 'COUPON' && valid && shareBps > threshold && !can('discount.approve_high');
  const manual = can('discount.apply');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          {current || coupon ? (
            <Button
              className="mr-auto"
              variant="ghost"
              onClick={() => {
                onApply(null);
                onCoupon?.(null);
                onClose();
              }}
            >
              Remove discount
            </Button>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid || needsManager}
            onClick={() => {
              if (mode === 'COUPON') onCoupon?.(value.trim().toUpperCase());
              else onApply({ type: mode, value: parsed, reason: reason.trim() });
              onClose();
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented
          label="Discount type"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setValue('');
          }}
          options={[
            { value: 'PERCENT', label: 'Percent', disabled: !manual },
            { value: 'FLAT', label: 'Amount', disabled: !manual },
            ...(allowCoupon ? [{ value: 'COUPON' as const, label: 'Coupon' }] : []),
          ]}
        />
        {mode === 'COUPON' ? (
          <Field label="Coupon code" hint="Checked by the server when the order is sent.">
            {(p) => <Input {...p} value={value} autoFocus className="uppercase" maxLength={20} onChange={(e) => setValue(e.target.value)} />}
          </Field>
        ) : (
          <>
            <Field label={mode === 'PERCENT' ? 'Percent off' : 'Amount off'} hint={valid ? `Takes ${money(Math.min(discountMinor, baseMinor))} off ${money(baseMinor)}` : undefined}>
              {(p) => <Input {...p} inputMode="decimal" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />}
            </Field>
            <Field label="Reason" hint="Required. Saved with the order.">
              {(p) => <Textarea {...p} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
            </Field>
          </>
        )}
        {!manual && mode !== 'COUPON' ? <Notice tone="warn">Your role cannot give manual discounts.</Notice> : null}
        {needsManager ? <Notice tone="warn">Discounts above {percent(threshold)} need a manager to apply them.</Notice> : null}
      </div>
    </Modal>
  );
}

// ───────────── Customer ─────────────

export function CustomerDialog({ open, onClose, onSelect }: { open: boolean; onClose: () => void; onSelect: (customer: CartState['customer']) => void }) {
  const { can } = useAuth();
  const notify = useToast();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  useEffect(() => {
    if (open) {
      setQ('');
      setCreating(false);
      setName('');
      setPhone('');
    }
  }, [open]);

  const search = useQuery({ queryKey: ['customers', 'pos', q], queryFn: () => api<Paged<Customer>>('/customers', { query: { q, pageSize: 20 } }), enabled: open && !creating });
  const create = useMutation({
    mutationFn: () => api<Customer>('/customers', { method: 'POST', body: { name: name.trim(), phone: phone.trim() } }),
    onSuccess: (c) => {
      onSelect({ id: c.id, name: c.name, loyaltyPoints: c.loyaltyPoints });
      onClose();
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });

  return (
    <Modal open={open} onClose={onClose} title={creating ? 'New customer' : 'Customer'} size="md">
      {creating ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Name">{(p) => <Input {...p} value={name} autoFocus maxLength={120} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Phone (optional)">{(p) => <Input {...p} value={phone} inputMode="tel" maxLength={20} onChange={(e) => setPhone(e.target.value)} />}</Field>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setCreating(false)}>Back</Button>
            <Button type="submit" variant="primary" disabled={name.trim().length === 0} loading={create.isPending}>
              Save and select
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <SearchInput className="flex-1" placeholder="Search by name or phone" value={q} autoFocus onChange={(e) => setQ(e.target.value)} onClear={() => setQ('')} />
            {can('customer.manage') ? (
              <Button
                onClick={() => {
                  setCreating(true);
                  if (/^[\d\s+-]{4,}$/.test(q)) setPhone(q);
                  else setName(q);
                }}
              >
                <UserPlus className="h-4 w-4" aria-hidden /> New
              </Button>
            ) : null}
          </div>
          {search.isPending ? (
            <SkeletonRows rows={4} />
          ) : search.isError ? (
            <ErrorState message={errorMessage(search.error)} onRetry={() => void search.refetch()} />
          ) : search.data.items.length === 0 ? (
            <EmptyState title="No customers found" description={can('customer.manage') ? 'Use “New” to add this customer.' : undefined} />
          ) : (
            <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-control border border-line">
              {search.data.items.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="flex min-h-14 w-full items-center justify-between gap-3 px-4 text-left hover:bg-sunken"
                    onClick={() => {
                      onSelect({ id: c.id, name: c.name, loyaltyPoints: c.loyaltyPoints });
                      onClose();
                    }}
                  >
                    <span>
                      <span className="block font-medium text-ink">{c.name}</span>
                      <span className="block text-sm text-ink-faint">{c.phone ?? 'No phone'}</span>
                    </span>
                    {c.loyaltyPoints > 0 ? <Badge tone="brand">{c.loyaltyPoints} pts</Badge> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

// ───────────── Table picker ─────────────

export function TablePickerDialog({ open, onClose, onSelect }: { open: boolean; onClose: () => void; onSelect: (table: { id: string; name: string }) => void }) {
  const floor = useQuery({ queryKey: ['floor'], queryFn: () => api<FloorArea[]>('/floor'), enabled: open });
  return (
    <Modal open={open} onClose={onClose} title="Choose a table" size="lg">
      {floor.isPending ? (
        <SkeletonRows rows={4} />
      ) : floor.isError ? (
        <ErrorState message={errorMessage(floor.error)} onRetry={() => void floor.refetch()} />
      ) : (
        <div className="flex flex-col gap-5">
          {floor.data.filter((a) => a.isActive).map((area) => (
            <section key={area.id}>
              <h3 className="mb-2 text-sm font-semibold text-ink-soft">{area.name}</h3>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                {area.tables.filter((t) => t.isActive).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    disabled={t.status === 'OCCUPIED'}
                    onClick={() => {
                      onSelect({ id: t.id, name: t.name });
                      onClose();
                    }}
                    className={cn(
                      'flex min-h-16 flex-col items-center justify-center rounded-control border text-sm font-bold',
                      t.status === 'AVAILABLE' ? 'border-ok/40 bg-ok-soft text-ok hover:brightness-95' : t.status === 'RESERVED' ? 'border-info/40 bg-info-soft text-info' : 'border-line bg-sunken text-ink-faint',
                    )}
                  >
                    {t.name}
                    <span className="text-[0.6875rem] font-medium capitalize">{t.status === 'AVAILABLE' ? `${t.capacity} seats` : t.status.toLowerCase()}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
          <p className="text-xs text-ink-faint">Occupied tables already have an open order. Open it from the Tables screen to add items.</p>
        </div>
      )}
    </Modal>
  );
}

// ───────────── Held orders ─────────────

export function HeldOrdersDrawer({ open, onClose, onResume }: { open: boolean; onClose: () => void; onResume: (orderId: string) => void }) {
  const queryClient = useQueryClient();
  const notify = useToast();
  const [discard, setDiscard] = useState<OrderSummary | null>(null);
  const held = useQuery({ queryKey: ['orders', 'drafts'], queryFn: () => api<Paged<OrderSummary>>('/orders', { query: { status: 'DRAFT', pageSize: 50 } }), enabled: open });
  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api(`/orders/${id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      setDiscard(null);
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['floor'] });
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });
  return (
    <Drawer open={open} onClose={onClose} title="Held orders and drafts" description="Orders saved for later. They have not been sent to the kitchen.">
      {held.isPending ? (
        <SkeletonRows />
      ) : held.isError ? (
        <ErrorState message={errorMessage(held.error)} onRetry={() => void held.refetch()} />
      ) : held.data.items.length === 0 ? (
        <EmptyState title="No held orders" description="Use Hold to park an order while you serve someone else." />
      ) : (
        <ul className="flex flex-col gap-2">
          {held.data.items.map((o) => (
            <li key={o.id} className="rounded-card border border-line p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-ink">
                    {o.orderNumber} {o.tableLabel ? `· ${o.tableLabel}` : ''}
                  </p>
                  <p className="text-sm text-ink-soft">
                    {o._count.items} item(s) · {money(o.totalMinor)} · {dateTime(o.createdAt)}
                  </p>
                  {o.notes ? <p className="mt-1 text-sm text-ink-faint">{o.notes}</p> : null}
                </div>
                <Badge tone={o.isHeld ? 'warn' : 'neutral'}>{o.isHeld ? 'Held' : 'Draft'}</Badge>
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="primary"
                  className="flex-1"
                  onClick={() => {
                    onResume(o.id);
                    onClose();
                  }}
                >
                  Resume
                </Button>
                <Button onClick={() => setDiscard(o)}>Discard</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!discard}
        onClose={() => setDiscard(null)}
        title={`Discard ${discard?.orderNumber ?? ''}?`}
        confirmLabel="Discard order"
        danger
        requireReason
        pending={cancel.isPending}
        onConfirm={(reason) => discard && cancel.mutate({ id: discard.id, reason })}
      />
    </Drawer>
  );
}

// ───────────── Offline capture ─────────────

export function OfflineCaptureDialog({ open, onClose, totalMinor, currency, onConfirm }: { open: boolean; onClose: () => void; totalMinor: number; currency: string; onConfirm: (cashTenderedMinor: number | null) => void }) {
  const [mode, setMode] = useState<'CASH' | 'UNPAID'>('CASH');
  const [tendered, setTendered] = useState('');
  useEffect(() => {
    if (open) {
      setMode('CASH');
      setTendered('');
    }
  }, [open]);
  const tenderedMinor = tendered ? parseAmount(tendered) : totalMinor;
  const valid = mode === 'UNPAID' || (tenderedMinor != null && tenderedMinor >= totalMinor);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save order offline"
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Back</Button>
          <Button variant="primary" size="lg" disabled={!valid} onClick={() => onConfirm(mode === 'CASH' ? tenderedMinor : null)}>
            Save on this device
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Notice tone="bad" title="You are offline">
          This order will be stored on this device and sent to the server when the connection returns. Until then it is not confirmed, has no order number and no invoice, and the kitchen display will not show it — tell the kitchen directly.
        </Notice>
        <div className="rounded-card bg-sunken px-4 py-3">
          <p className="text-sm text-ink-soft">Estimated total (from the saved menu)</p>
          <p className="tabular text-3xl font-bold text-ink">{money(totalMinor, currency)}</p>
        </div>
        <Segmented label="Payment" value={mode} onChange={setMode} options={[{ value: 'CASH', label: 'Cash collected now' }, { value: 'UNPAID', label: 'Not paid yet' }]} />
        {mode === 'CASH' ? (
          <Field label="Cash received" hint={tenderedMinor != null && tenderedMinor >= totalMinor ? `Change ${money(tenderedMinor - totalMinor, currency)}` : 'Leave empty for exact cash'} error={tenderedMinor == null || tenderedMinor < totalMinor ? 'Less than the total' : undefined}>
            {(p) => <Input {...p} inputMode="decimal" className="tabular h-12 text-lg" value={tendered} onChange={(e) => setTendered(e.target.value)} />}
          </Field>
        ) : null}
        <p className="text-xs text-ink-faint">Card, UPI, loyalty points and discounts need the server and are not available offline. Cash noted here is recorded as a payment only after the order has synchronised.</p>
      </div>
    </Modal>
  );
}

// ───────────── Sync centre ─────────────

const OP_LABEL: Record<QueuedOrder['status'], { label: string; tone: 'warn' | 'info' | 'ok' | 'bad' | 'neutral' }> = {
  queued: { label: 'Waiting to send', tone: 'warn' },
  syncing: { label: 'Sending', tone: 'info' },
  synced: { label: 'Synchronised', tone: 'ok' },
  conflict: { label: 'Needs attention', tone: 'bad' },
  discarded: { label: 'Discarded', tone: 'neutral' },
};

function conflictHelp(op: QueuedOrder): string {
  const details = (op.lastError?.details ?? {}) as { actualTotalMinor?: number; name?: string; ingredient?: string };
  switch (op.lastError?.code) {
    case 'PRICE_CONFLICT':
      return `The total is now ${money(details.actualTotalMinor ?? 0)} instead of ${money(op.expectedTotalMinor)} (prices or taxes changed while you were offline).`;
    case 'ITEM_UNAVAILABLE':
      return `${details.name ?? 'An item'} is no longer available.`;
    case 'INSUFFICIENT_STOCK':
      return `Not enough ${details.ingredient ?? 'stock'} to make this order.`;
    case 'NO_OPEN_SHIFT':
      return 'The order was created, but the cash could not be recorded because you have no open cash shift.';
    case 'INSUFFICIENT_TENDER':
      return 'The order was created, but the cash collected is less than the bill.';
    default:
      return op.lastError?.message ?? 'The server refused this order.';
  }
}

export function SyncCenterDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queue = useSyncQueue();
  const [discard, setDiscard] = useState<QueuedOrder | null>(null);
  const run = (action: Promise<unknown>) => void action.then(() => queue.syncNow());
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Offline orders"
      description="Orders captured on this device while offline. Nothing is removed until it is confirmed by the server or you discard it."
      wide
      footer={
        <Button variant="primary" loading={queue.syncing} disabled={queue.counts.queued === 0} onClick={() => void queue.syncNow()}>
          Send now ({queue.counts.queued})
        </Button>
      }
    >
      {queue.ops.length === 0 ? (
        <EmptyState title="Nothing captured offline" description="Orders taken while the connection is down will be listed here." />
      ) : (
        <ul className="flex flex-col gap-3">
          {queue.ops.map((op) => {
            const code = op.lastError?.code;
            const details = (op.lastError?.details ?? {}) as { productId?: string };
            return (
              <li key={op.opId} className="rounded-card border border-line p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-ink">
                      {op.localRef}
                      {op.orderNumber ? ` → order ${op.orderNumber}` : ''}
                    </p>
                    <p className="text-sm text-ink-soft">
                      {dateTime(op.createdAt)} · {op.userName} · {money(op.serverTotalMinor ?? op.expectedTotalMinor)}
                      {op.cashTenderedMinor != null ? (op.paymentRecorded ? ' · cash recorded' : ' · cash collected, not yet recorded') : ' · unpaid'}
                    </p>
                  </div>
                  <Badge tone={OP_LABEL[op.status].tone}>{OP_LABEL[op.status].label}</Badge>
                </div>
                <p className="mt-2 text-sm text-ink-soft">{op.summary.lines.map((l) => `${l.quantity} × ${l.name}`).join(', ')}</p>
                {op.status === 'queued' && op.lastError ? <p className="mt-2 text-sm text-ink-faint">Last attempt: {op.lastError.message} It will be retried automatically.</p> : null}
                {op.status === 'discarded' ? <p className="mt-2 text-sm text-ink-faint">Discarded: {op.discardReason}</p> : null}
                {op.status === 'conflict' ? (
                  <div className="mt-3 flex flex-col gap-3">
                    <Notice tone="bad">{conflictHelp(op)}</Notice>
                    <div className="flex flex-wrap gap-2">
                      {code === 'PRICE_CONFLICT' ? (
                        <Button variant="primary" onClick={() => run(queue.acceptTotal(op.opId))}>
                          Accept new total
                        </Button>
                      ) : null}
                      {code === 'ITEM_UNAVAILABLE' && details.productId && op.payload.items.length > 1 ? (
                        <Button variant="primary" onClick={() => run(queue.removeProduct(op.opId, details.productId!))}>
                          Remove item and send
                        </Button>
                      ) : null}
                      {op.orderId && op.cashTenderedMinor != null ? <Button onClick={() => run(queue.dropPayment(op.opId))}>Settle later from Orders</Button> : null}
                      <Button onClick={() => run(queue.retry(op.opId))}>Try again</Button>
                      {!op.orderId ? (
                        <Button variant="ghost" onClick={() => setDiscard(op)}>
                          Discard
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {op.status === 'synced' ? <StatusBadge status="CONFIRMED" className="mt-2" /> : null}
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={!!discard}
        onClose={() => setDiscard(null)}
        title={`Discard ${discard?.localRef ?? ''}?`}
        description={discard?.cashTenderedMinor != null ? 'Cash was collected for this order. Make sure it is returned or accounted for.' : 'The order will not be sent to the server.'}
        confirmLabel="Discard"
        danger
        requireReason
        onConfirm={(reason) => {
          if (discard) void queue.discard(discard.opId, reason);
          setDiscard(null);
        }}
      />
    </Drawer>
  );
}
