/** Taking payment for an order and showing its receipt. Used by the POS and the Orders screen. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PaymentMethod } from '@serveos/shared';
import { Banknote, CheckCircle2, CreditCard, Gift, Plus, Printer, QrCode, Share2, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage, newKey } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { amount, money, parseAmount } from '@/lib/format';
import type { Order, Payment, Receipt } from '@/lib/types';
import { Badge, Button, cn, ErrorState, Field, Input, Modal, Notice, Spinner, useToast } from './ui';

// ───────────── Receipt ─────────────

export function ReceiptDialog({ orderId, open, onClose }: { orderId: string | null; open: boolean; onClose: () => void }) {
  const notify = useToast();
  const receipt = useQuery({ queryKey: ['order', orderId, 'receipt'], queryFn: () => api<Receipt>(`/orders/${orderId}/receipt`), enabled: open && !!orderId });

  const share = async () => {
    if (!receipt.data) return;
    try {
      if (navigator.share) await navigator.share({ title: 'Receipt', text: receipt.data.text });
      else {
        await navigator.clipboard.writeText(receipt.data.text);
        notify('Receipt copied. Paste it into a message to share it.', 'info');
      }
    } catch {
      /* the person closed the share sheet */
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={receipt.data?.isInvoice ? `Invoice ${receipt.data.invoiceNumber}` : 'Bill preview'}
      description={receipt.data && !receipt.data.isInvoice ? 'Not yet invoiced: the invoice is issued when the bill is fully paid.' : undefined}
      footer={
        <>
          <Button onClick={() => void share()} disabled={!receipt.data}>
            <Share2 className="h-4 w-4" aria-hidden /> Share
          </Button>
          <Button variant="primary" onClick={() => window.print()} disabled={!receipt.data}>
            <Printer className="h-4 w-4" aria-hidden /> Print
          </Button>
        </>
      }
    >
      {receipt.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : receipt.isError ? (
        <ErrorState message={errorMessage(receipt.error)} onRetry={() => void receipt.refetch()} />
      ) : (
        <>
          <pre className="print-area mx-auto w-fit overflow-x-auto rounded-control border border-line bg-sunken p-4 font-mono text-xs leading-5 text-ink">{receipt.data.text}</pre>
          <p className="mt-3 text-center text-xs text-ink-faint">Prints through the browser's print dialog. Direct thermal-printer and email delivery are not set up.</p>
        </>
      )}
    </Modal>
  );
}

// ───────────── Checkout ─────────────

interface TenderDraft {
  id: number;
  method: PaymentMethod;
  amountText: string;
  tenderedText: string;
  reference: string;
  gateway: boolean;
}

const METHODS: Array<{ method: PaymentMethod; label: string; icon: typeof Banknote }> = [
  { method: 'CASH', label: 'Cash', icon: Banknote },
  { method: 'UPI', label: 'UPI', icon: QrCode },
  { method: 'CARD', label: 'Card', icon: CreditCard },
  { method: 'LOYALTY', label: 'Points', icon: Gift },
];

/** Round figures a guest is likely to hand over for a bill of `due`. */
function quickCash(dueMinor: number): number[] {
  const notes = [10_000, 20_000, 50_000, 100_000, 200_000];
  const options = new Set<number>([dueMinor]);
  for (const note of notes) options.add(Math.ceil(dueMinor / note) * note);
  return [...options].filter((v) => v >= dueMinor).sort((a, b) => a - b).slice(0, 4);
}

export function CheckoutDialog({ orderId, open, onClose, onPaid }: { orderId: string | null; open: boolean; onClose: () => void; onPaid?: (order: Order) => void }) {
  const { me, can } = useAuth();
  const notify = useToast();
  const queryClient = useQueryClient();
  const [tenders, setTenders] = useState<TenderDraft[]>([]);
  const [attemptKey, setAttemptKey] = useState(() => newKey('pay'));
  const [error, setError] = useState<string | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);

  const order = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => api<Order>(`/orders/${orderId}`),
    enabled: open && !!orderId,
    // While a gateway payment is pending, keep checking for the provider's confirmation.
    refetchInterval: (q) => (q.state.data?.payments.some((p) => p.state === 'PENDING') ? 2500 : false),
  });
  const data = order.data;
  const pending = data?.payments.filter((p) => p.state === 'PENDING') ?? [];
  const pendingMinor = pending.reduce((a, p) => a + p.amountMinor, 0);
  const dueMinor = Math.max(0, (data?.dueMinor ?? 0) - pendingMinor);
  const settled = !!data && data.dueMinor === 0 && data.paidMinor > 0;
  const lastCash = data?.payments.filter((p) => p.method === 'CASH' && p.state === 'SUCCEEDED').at(-1);

  // Start each time with one cash tender for the full amount: the most common case is one tap.
  useEffect(() => {
    if (open && data && tenders.length === 0 && dueMinor > 0) setTenders([{ id: 1, method: 'CASH', amountText: amount(dueMinor).replace(/,/g, ''), tenderedText: '', reference: '', gateway: false }]);
  }, [open, data, dueMinor, tenders.length]);
  useEffect(() => {
    if (!open) {
      setTenders([]);
      setError(null);
      setAttemptKey(newKey('pay'));
    }
  }, [open]);

  const parsed = useMemo(() => tenders.map((t) => ({ ...t, amountMinor: parseAmount(t.amountText), tenderedMinor: t.tenderedText ? parseAmount(t.tenderedText) : null })), [tenders]);
  const enteredMinor = parsed.reduce((a, t) => a + (t.amountMinor ?? 0), 0);
  const remainingMinor = dueMinor - enteredMinor;
  const invalid = parsed.some((t) => !t.amountMinor || (t.method === 'CASH' && t.tenderedText !== '' && (t.tenderedMinor == null || t.tenderedMinor < (t.amountMinor ?? 0))));
  const mustPayInFull = !me?.restaurant?.allowPartialPayment;
  const canSubmit = !invalid && parsed.length > 0 && remainingMinor >= 0 && (!mustPayInFull || remainingMinor === 0);

  const refresh = () => {
    for (const key of ['order', 'orders', 'floor', 'shift']) void queryClient.invalidateQueries({ queryKey: [key] });
  };
  const update = (id: number, change: Partial<TenderDraft>) => setTenders((list) => list.map((t) => (t.id === id ? { ...t, ...change } : t)));

  const pay = useMutation({
    mutationFn: () =>
      api<{ payments: Payment[] }>(`/orders/${orderId}/payments`, {
        method: 'POST',
        idempotencyKey: attemptKey, // the same key is reused if this exact attempt is retried after a timeout
        body: {
          tenders: parsed.map((t) => ({
            method: t.method,
            amountMinor: t.amountMinor,
            ...(t.method === 'CASH' && t.tenderedMinor != null ? { tenderedMinor: t.tenderedMinor } : {}),
            mode: t.gateway ? 'GATEWAY' : 'MANUAL',
            reference: t.reference,
          })),
        },
      }),
    onSuccess: async () => {
      setError(null);
      setTenders([]);
      setAttemptKey(newKey('pay'));
      refresh();
      const fresh = (await order.refetch()).data;
      if (fresh && fresh.dueMinor === 0) onPaid?.(fresh);
    },
    onError: (err) => {
      setError(errorMessage(err));
      refresh();
    },
  });
  const gatewayAction = useMutation({
    mutationFn: ({ payment, action }: { payment: Payment; action: 'success' | 'failure' | 'cancel' }) =>
      action === 'cancel' ? api(`/payments/${payment.id}/cancel`, { method: 'POST' }) : api(`/payments/${payment.id}/dev-simulate`, { method: 'POST', body: { outcome: action } }),
    onSettled: async () => {
      refresh();
      const fresh = (await order.refetch()).data;
      if (fresh && fresh.dueMinor === 0 && fresh.paidMinor > 0) onPaid?.(fresh);
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const complete = useMutation({
    mutationFn: () => api<Order>(`/orders/${orderId}/complete`, { method: 'POST' }),
    onSuccess: () => {
      notify('Order completed');
      refresh();
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const methods = METHODS.filter((m) => m.method !== 'LOYALTY' || (me?.restaurant?.loyaltyEnabled && data?.customer));
  const pointValue = me?.restaurant?.loyaltyPointValueMinor ?? 100;

  return (
    <>
      <Modal open={open && !showReceipt} onClose={onClose} title={data ? `Payment · ${data.orderNumber}` : 'Payment'} description={data?.tableLabel ? `Table ${data.tableLabel}` : undefined} size="lg">
        {order.isPending ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : order.isError || !data ? (
          <ErrorState message={errorMessage(order.error)} onRetry={() => void order.refetch()} />
        ) : settled ? (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <CheckCircle2 className="h-14 w-14 text-ok" aria-hidden />
            <div>
              <p className="text-xl font-bold text-ink">Paid {money(data.paidMinor - data.refundedMinor, data.currency)}</p>
              {lastCash && lastCash.changeMinor > 0 ? <p className="mt-1 text-lg font-semibold text-brand">Change to return: {money(lastCash.changeMinor, data.currency)}</p> : null}
              {data.invoice ? <p className="mt-1 text-sm text-ink-soft">Invoice {data.invoice.invoiceNumber}</p> : null}
            </div>
            {error ? <Notice tone="bad">{error}</Notice> : null}
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="lg" onClick={() => setShowReceipt(true)}>
                <Printer className="h-5 w-5" aria-hidden /> Receipt
              </Button>
              {can('order.complete') && ['CONFIRMED', 'PREPARING', 'READY'].includes(data.status) ? (
                <Button size="lg" variant="success" loading={complete.isPending} onClick={() => complete.mutate()}>
                  Complete order
                </Button>
              ) : null}
              <Button size="lg" variant="primary" onClick={onClose}>
                Done
              </Button>
            </div>
            <p className="text-xs text-ink-faint">The order stays open for the kitchen until it is completed.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-end justify-between rounded-card bg-sunken px-4 py-3">
              <div>
                <p className="text-sm text-ink-soft">Amount due</p>
                <p className="tabular text-3xl font-bold text-ink">{money(dueMinor, data.currency)}</p>
              </div>
              <div className="text-right text-sm text-ink-soft">
                <p>Bill total {money(data.totalMinor, data.currency)}</p>
                {data.paidMinor > 0 ? <p>Already paid {money(data.paidMinor - data.refundedMinor, data.currency)}</p> : null}
              </div>
            </div>

            {pending.map((p) => (
              <Notice key={p.id} tone="warn" title={`${p.method} payment of ${money(p.amountMinor, data.currency)} is waiting for confirmation`}>
                <p>It does not count as paid until the payment provider confirms it.</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {p.provider === 'dev' ? (
                    <>
                      <Button size="sm" variant="success" disabled={gatewayAction.isPending} onClick={() => gatewayAction.mutate({ payment: p, action: 'success' })}>
                        Simulate success
                      </Button>
                      <Button size="sm" disabled={gatewayAction.isPending} onClick={() => gatewayAction.mutate({ payment: p, action: 'failure' })}>
                        Simulate failure
                      </Button>
                    </>
                  ) : null}
                  <Button size="sm" variant="ghost" disabled={gatewayAction.isPending} onClick={() => gatewayAction.mutate({ payment: p, action: 'cancel' })}>
                    Cancel this payment
                  </Button>
                </div>
              </Notice>
            ))}
            {data.payments.filter((p) => p.state === 'FAILED').slice(-1).map((p) => (
              <Notice key={p.id} tone="bad" title={`The last ${p.method} payment failed`}>
                {p.failureReason || 'Declined'}. Nothing was charged; choose how to pay again.
              </Notice>
            ))}

            {dueMinor > 0 ? (
              <>
                {parsed.map((t, index) => (
                  <div key={t.id} className="rounded-card border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {methods.map((m) => (
                        <button
                          key={m.method}
                          type="button"
                          aria-pressed={t.method === m.method}
                          onClick={() => update(t.id, { method: m.method, gateway: false, tenderedText: '' })}
                          className={cn('flex h-12 items-center gap-2 rounded-control border px-4 text-sm font-semibold', t.method === m.method ? 'border-brand bg-brand-soft text-brand-strong' : 'border-line-strong text-ink-soft hover:bg-sunken')}
                        >
                          <m.icon className="h-4 w-4" aria-hidden />
                          {m.label}
                        </button>
                      ))}
                      {parsed.length > 1 ? (
                        <Button variant="ghost" size="icon" className="ml-auto" aria-label={`Remove payment ${index + 1}`} onClick={() => setTenders((list) => list.filter((x) => x.id !== t.id))}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <Field label="Amount" error={t.amountText && !t.amountMinor ? 'Enter a valid amount' : undefined}>
                        {(p) => <Input {...p} inputMode="decimal" className="tabular h-12 text-lg" value={t.amountText} onChange={(e) => update(t.id, { amountText: e.target.value })} />}
                      </Field>
                      {t.method === 'CASH' ? (
                        <Field label="Cash received" error={t.tenderedMinor != null && t.tenderedMinor < (t.amountMinor ?? 0) ? 'Less than the amount' : undefined} hint={t.tenderedMinor != null && t.amountMinor && t.tenderedMinor >= t.amountMinor ? `Change ${money(t.tenderedMinor - t.amountMinor, data.currency)}` : 'Leave empty for exact cash'}>
                          {(p) => <Input {...p} inputMode="decimal" className="tabular h-12 text-lg" value={t.tenderedText} onChange={(e) => update(t.id, { tenderedText: e.target.value })} />}
                        </Field>
                      ) : t.method === 'LOYALTY' ? (
                        <p className="self-end pb-2 text-sm text-ink-soft">
                          {data.customer?.name} has {data.customer?.loyaltyPoints ?? 0} points (1 point = {money(pointValue, data.currency)}).
                        </p>
                      ) : (
                        <Field label="Reference (optional)" hint={t.gateway ? undefined : 'UPI reference or card slip number'}>
                          {(p) => <Input {...p} className="h-12" value={t.reference} maxLength={80} onChange={(e) => update(t.id, { reference: e.target.value })} disabled={t.gateway} />}
                        </Field>
                      )}
                    </div>
                    {t.method === 'CASH' && t.amountMinor ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {quickCash(t.amountMinor).map((v) => (
                          <Button key={v} size="sm" onClick={() => update(t.id, { tenderedText: amount(v).replace(/,/g, '') })}>
                            {v === t.amountMinor ? 'Exact' : money(v, data.currency)}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                    {(t.method === 'UPI' || t.method === 'CARD') && me?.paymentGateway === 'dev' ? (
                      <label className="mt-3 flex items-center gap-2 text-sm text-ink-soft">
                        <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={t.gateway} onChange={(e) => update(t.id, { gateway: e.target.checked })} />
                        Send through the payment gateway <Badge tone="warn">development simulator</Badge>
                      </label>
                    ) : null}
                    {(t.method === 'UPI' || t.method === 'CARD') && !t.gateway ? <p className="mt-2 text-xs text-ink-faint">Recorded as confirmed by you on the card machine / UPI app. It is not verified by a payment gateway.</p> : null}
                  </div>
                ))}

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Button
                    onClick={() => setTenders((list) => [...list, { id: Date.now(), method: 'UPI', amountText: remainingMinor > 0 ? amount(remainingMinor).replace(/,/g, '') : '', tenderedText: '', reference: '', gateway: false }])}
                    disabled={parsed.length >= 6}
                  >
                    <Plus className="h-4 w-4" aria-hidden /> Split payment
                  </Button>
                  <p className={cn('tabular text-sm font-semibold', remainingMinor === 0 ? 'text-ok' : remainingMinor < 0 ? 'text-bad' : 'text-warn')}>
                    {remainingMinor === 0 ? 'Covers the full amount' : remainingMinor < 0 ? `Over by ${money(-remainingMinor, data.currency)}` : `${money(remainingMinor, data.currency)} still to pay`}
                  </p>
                </div>
                {error ? <Notice tone="bad">{error}</Notice> : null}
                <Button variant="primary" size="lg" disabled={!canSubmit} loading={pay.isPending} onClick={() => pay.mutate()}>
                  Record payment of {money(enteredMinor, data.currency)}
                </Button>
              </>
            ) : error ? (
              <Notice tone="bad">{error}</Notice>
            ) : null}
          </div>
        )}
      </Modal>
      <ReceiptDialog orderId={orderId} open={open && showReceipt} onClose={() => setShowReceipt(false)} />
    </>
  );
}
