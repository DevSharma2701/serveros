import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ORDER_TYPES, type OrderType } from '@serveos/shared';
import { CloudOff, Printer, QrCode, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { CheckoutDialog, ReceiptDialog } from '@/components/checkout';
import { Badge, Button, Card, cn, ConfirmDialog, DataTable, Drawer, ErrorState, Field, Input, Modal, Notice, PageHeader, Pagination, SearchInput, Segmented, Select, SkeletonRows, StatusBadge, Textarea, useToast, type Column } from '@/components/ui';
import { api, errorMessage, newKey } from '@/lib/api';
import { useAuth, useOutlet } from '@/lib/auth';
import { dateTime, money, parseAmount, titleCase, todayIn } from '@/lib/format';
import type { Order, OrderItem, OrderSummary, Paged, Payment } from '@/lib/types';
import { DiscountDialog } from './pos/dialogs';

const VIEWS = {
  open: { label: 'Open', status: 'PLACED,CONFIRMED,PREPARING,READY' },
  drafts: { label: 'Drafts', status: 'DRAFT' },
  completed: { label: 'Completed', status: 'COMPLETED,REFUNDED' },
  cancelled: { label: 'Cancelled', status: 'CANCELLED' },
  all: { label: 'All', status: '' },
} as const;
type View = keyof typeof VIEWS;

function RefundDialog({ payment, currency, onClose, onDone }: { payment: Payment | null; currency: string; onClose: () => void; onDone: () => void }) {
  const notify = useToast();
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('');
  const [key] = useState(() => newKey('refund'));
  const refundable = payment ? payment.amountMinor - payment.refundedMinor : 0;
  const amountMinor = amountText ? parseAmount(amountText) : refundable;
  const valid = amountMinor != null && amountMinor > 0 && amountMinor <= refundable && reason.trim().length >= 3;
  const refund = useMutation({
    mutationFn: () => api(`/payments/${payment!.id}/refunds`, { method: 'POST', body: { amountMinor, reason: reason.trim() }, idempotencyKey: key }),
    onSuccess: () => {
      notify('Refund recorded');
      onDone();
      onClose();
    },
  });
  if (!payment) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Refund ${titleCase(payment.method)} payment`}
      description={`Up to ${money(refundable, currency)} can be refunded.`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!valid} loading={refund.isPending} onClick={() => refund.mutate()}>
            Refund {amountMinor ? money(amountMinor, currency) : ''}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Amount" hint="Leave empty to refund everything that remains." error={amountMinor == null || amountMinor > refundable ? 'Enter an amount up to the refundable balance' : undefined}>
          {(p) => <Input {...p} inputMode="decimal" className="tabular" value={amountText} onChange={(e) => setAmountText(e.target.value)} />}
        </Field>
        <Field label="Reason" hint="Required. Printed on the credit note and saved in the audit log.">
          {(p) => <Textarea {...p} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        {payment.method === 'CASH' ? <Notice tone="info">Cash refunds come out of your open cash shift.</Notice> : payment.verification === 'MANUAL' ? <Notice tone="info">Return the money on the card machine or UPI app yourself; this only records it.</Notice> : null}
        {refund.isError ? <Notice tone="bad">{errorMessage(refund.error)}</Notice> : null}
      </div>
    </Modal>
  );
}

function OrderDrawer({ orderId, onClose }: { orderId: string | null; onClose: () => void }) {
  const outlet = useOutlet();
  const { can } = useAuth();
  const notify = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<null | 'pay' | 'receipt' | 'cancel' | 'discount'>(null);
  const [voiding, setVoiding] = useState<OrderItem | null>(null);
  const [refunding, setRefunding] = useState<Payment | null>(null);

  const query = useQuery({ queryKey: ['order', orderId], queryFn: () => api<Order>(`/orders/${orderId}`), enabled: !!orderId });
  const order = query.data;
  const refresh = () => {
    for (const key of ['order', 'orders', 'floor', 'shift']) void queryClient.invalidateQueries({ queryKey: [key] });
  };
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: object; done: string }) => api(`/orders/${orderId}${path}`, { method: 'POST', body: body ?? {} }),
    onSuccess: (_, v) => {
      notify(v.done);
      setDialog(null);
      setVoiding(null);
      refresh();
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });

  const active = order ? ['DRAFT', 'PLACED', 'CONFIRMED', 'PREPARING', 'READY'].includes(order.status) : false;
  const placed = active && order?.status !== 'DRAFT';
  const cancelPermission = order?.status === 'DRAFT' ? can('order.create') : can('order.cancel');
  // A guest (QR) order that was paid but could not be released to the kitchen automatically.
  const guestHeld = !!order && order.source === 'QR' && order.status === 'PLACED' && order.dueMinor === 0 && order.paidMinor > 0;

  return (
    <Drawer
      open={!!orderId}
      onClose={onClose}
      wide
      title={order ? `Order ${order.orderNumber}` : 'Order'}
      description={order ? `${titleCase(order.type)}${order.tableLabel ? ` · Table ${order.tableLabel}` : ''} · ${dateTime(order.createdAt, outlet.timezone)}` : undefined}
      footer={
        order ? (
          <>
            <Button onClick={() => setDialog('receipt')}>
              <Printer className="h-4 w-4" aria-hidden /> Receipt
            </Button>
            {active && can('order.update') ? <Button onClick={() => navigate(`/pos?order=${order.id}`)}>{order.status === 'DRAFT' ? 'Resume in POS' : 'Add items'}</Button> : null}
            {placed && can('order.update') ? <Button onClick={() => setDialog('discount')}>Discount</Button> : null}
            {active && cancelPermission ? (
              <Button variant="ghost" className="text-bad" onClick={() => setDialog('cancel')}>
                Cancel order
              </Button>
            ) : null}
            {placed && order.dueMinor > 0 && can('payment.record') ? (
              <Button variant="primary" onClick={() => setDialog('pay')}>
                Take payment · {money(order.dueMinor, order.currency)}
              </Button>
            ) : null}
            {guestHeld && can('order.create') ? (
              <Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ path: '/accept', done: 'Sent to the kitchen' })}>
                Send to kitchen
              </Button>
            ) : null}
            {placed && !guestHeld && order.status !== 'PLACED' && order.dueMinor === 0 && can('order.complete') ? (
              <Button variant="success" loading={act.isPending} onClick={() => act.mutate({ path: '/complete', done: 'Order completed' })}>
                Complete order
              </Button>
            ) : null}
          </>
        ) : null
      }
    >
      {query.isPending ? (
        <SkeletonRows rows={8} />
      ) : query.isError || !order ? (
        <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={order.status} />
            <StatusBadge status={order.paymentStatus} />
            {order.isHeld ? <Badge tone="warn">Held</Badge> : null}
            {order.source === 'POS_OFFLINE' ? (
              <Badge tone="info">
                <CloudOff className="h-3 w-3" aria-hidden /> Captured offline
              </Badge>
            ) : null}
            {order.source === 'QR' ? (
              <Badge tone="brand">
                <QrCode className="h-3 w-3" aria-hidden /> Ordered by guest{order.guestName ? `: ${order.guestName}` : ''}
              </Badge>
            ) : null}
            {order.invoice ? <Badge>Invoice {order.invoice.invoiceNumber}</Badge> : null}
          </div>
          {guestHeld ? (
            <Notice tone="warn" title="Paid by the guest, but not yet in the kitchen">
              {order.events.filter((e) => e.type === 'ATTENTION').at(-1)?.message ?? 'This order could not be sent to the kitchen automatically.'} Fix the cause and send it, or refund the payment and cancel the order.
            </Notice>
          ) : order.source === 'QR' && order.status === 'PLACED' ? (
            <Notice tone="info">Waiting for the guest to pay. It goes to the kitchen automatically once paid, and is cancelled if left unpaid for 15 minutes.</Notice>
          ) : null}
          {order.customer ? <p className="text-sm text-ink-soft">Customer: <span className="font-medium text-ink">{order.customer.name}</span></p> : null}
          {order.type === 'DELIVERY' ? <p className="text-sm text-ink-soft">Deliver to {order.deliveryName} · {order.deliveryPhone} · {order.deliveryAddress}</p> : null}
          {order.notes ? <Notice tone="warn" title="Order note">{order.notes}</Notice> : null}
          {order.status === 'CANCELLED' ? <Notice tone="bad" title="Cancelled">{order.cancelReason}</Notice> : null}

          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink">Items</h3>
            <ul className="divide-y divide-line rounded-card border border-line">
              {order.items.map((i) => (
                <li key={i.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className={cn('min-w-0', i.status === 'VOIDED' && 'text-ink-faint line-through')}>
                    <p className="font-medium">
                      {i.quantity} × {i.productName}
                      {i.variantName !== 'Regular' ? ` (${i.variantName})` : ''}
                    </p>
                    {i.modifiers.length ? <p className="text-sm text-ink-soft">{i.modifiers.map((m) => m.optionName).join(', ')}</p> : null}
                    {i.notes ? <p className="text-sm italic text-ink-faint">“{i.notes}”</p> : null}
                    {i.status === 'VOIDED' ? <p className="text-sm no-underline">Voided: {i.voidReason}</p> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="tabular font-semibold">{money(i.lineSubtotalMinor, order.currency)}</span>
                    {placed && i.status === 'ACTIVE' && can(i.sentToKitchenAt ? 'order.void_item' : 'order.update') ? (
                      <Button size="sm" variant="ghost" onClick={() => setVoiding(i)}>
                        Void
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            <dl className="tabular mt-3 space-y-1 text-sm text-ink-soft">
              <Row label="Subtotal" value={money(order.subtotalMinor, order.currency)} />
              {order.itemDiscountMinor + order.orderDiscountMinor > 0 ? <Row label={`Discount${order.discountReason ? ` (${order.discountReason})` : ''}`} value={`−${money(order.itemDiscountMinor + order.orderDiscountMinor, order.currency)}`} /> : null}
              {order.serviceChargeMinor > 0 ? <Row label="Service charge" value={money(order.serviceChargeMinor, order.currency)} /> : null}
              {order.deliveryChargeMinor > 0 ? <Row label="Delivery charge" value={money(order.deliveryChargeMinor, order.currency)} /> : null}
              {order.taxLines.map((t) => (
                <Row key={t.id} label={t.name} value={money(t.amountMinor, order.currency)} />
              ))}
              {order.roundOffMinor !== 0 ? <Row label="Round off" value={money(order.roundOffMinor, order.currency)} /> : null}
              <div className="flex justify-between border-t border-line pt-2 text-base font-bold text-ink">
                <dt>Total</dt>
                <dd>{money(order.totalMinor, order.currency)}</dd>
              </div>
              {order.paidMinor > 0 ? <Row label="Paid" value={money(order.paidMinor, order.currency)} /> : null}
              {order.refundedMinor > 0 ? <Row label="Refunded" value={`−${money(order.refundedMinor, order.currency)}`} /> : null}
              {order.dueMinor > 0 && order.status !== 'CANCELLED' ? <Row label="Due" value={money(order.dueMinor, order.currency)} strong /> : null}
            </dl>
          </section>

          {order.payments.length > 0 ? (
            <section>
              <h3 className="mb-2 text-sm font-semibold text-ink">Payments</h3>
              <ul className="divide-y divide-line rounded-card border border-line">
                {order.payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                    <div>
                      <p className="font-medium text-ink">
                        {titleCase(p.method)} · {money(p.amountMinor, order.currency)} <StatusBadge status={p.state} className="ml-1" />
                      </p>
                      <p className="text-ink-faint">
                        {dateTime(p.createdAt, outlet.timezone)}
                        {p.reference ? ` · ref ${p.reference}` : ''}
                        {p.verification === 'MANUAL' ? ' · recorded manually' : p.verification === 'GATEWAY' ? ' · gateway' : ''}
                        {p.refundedMinor > 0 ? ` · refunded ${money(p.refundedMinor, order.currency)}` : ''}
                        {p.failureReason ? ` · ${p.failureReason}` : ''}
                      </p>
                    </div>
                    {p.state === 'SUCCEEDED' && p.refundedMinor < p.amountMinor && can('payment.refund') ? (
                      <Button size="sm" onClick={() => setRefunding(p)}>
                        <RotateCcw className="h-4 w-4" aria-hidden /> Refund
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {order.refunds.map((r) => (
                <p key={r.id} className="mt-2 text-sm text-ink-soft">
                  Credit note {r.creditNoteNumber}: {money(r.amountMinor, order.currency)} — {r.reason}
                </p>
              ))}
            </section>
          ) : null}

          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink">History</h3>
            <ol className="space-y-2 border-l-2 border-line pl-4">
              {order.events.map((e) => (
                <li key={e.id} className="text-sm">
                  <p className="text-ink">{e.message || titleCase(e.type)}</p>
                  <p className="text-ink-faint">
                    {dateTime(e.createdAt, outlet.timezone)}
                    {e.actorName ? ` · ${e.actorName}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}

      <CheckoutDialog orderId={orderId} open={dialog === 'pay'} onClose={() => setDialog(null)} />
      <ReceiptDialog orderId={orderId} open={dialog === 'receipt'} onClose={() => setDialog(null)} />
      <ConfirmDialog open={dialog === 'cancel'} onClose={() => setDialog(null)} title="Cancel this order?" description="The order stays on record as cancelled. Paid orders must be refunded first." confirmLabel="Cancel order" danger requireReason pending={act.isPending} onConfirm={(reason) => act.mutate({ path: '/cancel', body: { reason }, done: 'Order cancelled' })} />
      <ConfirmDialog open={!!voiding} onClose={() => setVoiding(null)} title={`Void ${voiding?.productName ?? 'item'}?`} description="The item stays on the order, marked as voided, and the bill is recalculated." confirmLabel="Void item" danger requireReason pending={act.isPending} onConfirm={(reason) => voiding && act.mutate({ path: `/items/${voiding.id}/void`, body: { reason }, done: 'Item voided' })} />
      {order ? (
        <DiscountDialog
          open={dialog === 'discount'}
          onClose={() => setDialog(null)}
          title="Order discount"
          baseMinor={order.subtotalMinor - order.itemDiscountMinor}
          current={order.orderDiscountType && !order.discountCode ? { type: order.orderDiscountType, value: order.orderDiscountValue, reason: order.discountReason } : null}
          coupon={order.discountCode}
          allowCoupon
          onApply={(d) => act.mutate({ path: '/discount', body: { orderDiscount: d }, done: d ? 'Discount applied' : 'Discount removed' })}
          onCoupon={(code) => code && act.mutate({ path: '/discount', body: { couponCode: code }, done: 'Coupon applied' })}
        />
      ) : null}
      <RefundDialog key={refunding?.id} payment={refunding} currency={order?.currency ?? 'INR'} onClose={() => setRefunding(null)} onDone={refresh} />
    </Drawer>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-4', strong && 'font-semibold text-warn')}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function OrdersPage() {
  const outlet = useOutlet();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>('open');
  const [type, setType] = useState<OrderType | ''>('');
  const [q, setQ] = useState(() => params.get('q') ?? '');
  const [day, setDay] = useState('');
  const [page, setPage] = useState(1);
  const selected = params.get('id');

  const list = useQuery({
    queryKey: ['orders', view, type, q, day, page],
    queryFn: () => api<Paged<OrderSummary>>('/orders', { query: { status: VIEWS[view].status, type, q, from: day, to: day, page, pageSize: 25 } }),
    placeholderData: (previous) => previous,
  });

  const columns: Array<Column<OrderSummary>> = [
    {
      key: 'number',
      header: 'Order',
      cell: (o) => (
        <span className="flex items-center gap-2 font-semibold">
          {o.orderNumber}
          {o.source === 'QR' ? <Badge tone="brand">QR</Badge> : null}
        </span>
      ),
    },
    { key: 'type', header: 'Type', cell: (o) => `${titleCase(o.type)}${o.tableLabel ? ` · ${o.tableLabel}` : ''}` },
    { key: 'customer', header: 'Customer', cell: (o) => o.customer?.name ?? <span className="text-ink-faint">—</span>, className: 'hidden md:table-cell' },
    { key: 'time', header: 'Created', cell: (o) => dateTime(o.createdAt, outlet.timezone), className: 'hidden sm:table-cell' },
    { key: 'status', header: 'Status', cell: (o) => <StatusBadge status={o.status} /> },
    { key: 'payment', header: 'Payment', cell: (o) => <StatusBadge status={o.paymentStatus} />, className: 'hidden sm:table-cell' },
    { key: 'total', header: 'Total', align: 'right', cell: (o) => money(o.totalMinor) },
  ];

  return (
    <>
      <PageHeader title="Orders" description="Every order for this outlet. Open one to take payment, complete, cancel or refund it." />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
          <Segmented
            label="Show"
            value={view}
            onChange={(v) => {
              setView(v);
              setPage(1);
            }}
            options={(Object.keys(VIEWS) as View[]).map((v) => ({ value: v, label: VIEWS[v].label }))}
          />
          <SearchInput
            className="min-w-48 flex-1"
            placeholder="Order number, table or customer"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            onClear={() => setQ('')}
          />
          <Select aria-label="Order type" className="w-auto" value={type} onChange={(e) => (setType(e.target.value as OrderType | ''), setPage(1))}>
            <option value="">All types</option>
            {ORDER_TYPES.map((t) => (
              <option key={t} value={t}>
                {titleCase(t)}
              </option>
            ))}
          </Select>
          <Input aria-label="Date" type="date" className="w-auto" value={day} max={todayIn(outlet.timezone)} onChange={(e) => (setDay(e.target.value), setPage(1))} />
        </div>
        {list.isPending ? (
          <SkeletonRows rows={8} />
        ) : list.isError ? (
          <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
        ) : (
          <>
            <DataTable columns={columns} rows={list.data.items} rowKey={(o) => o.id} onRowClick={(o) => setParams({ id: o.id })} />
            <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <OrderDrawer orderId={selected} onClose={() => setParams({})} />
    </>
  );
}
