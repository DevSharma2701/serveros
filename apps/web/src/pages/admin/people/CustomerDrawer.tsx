import { loyaltyAdjustSchema } from '@serveos/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Badge, Button, DataTable, Drawer, EmptyState, ErrorState, Field, Input, Modal, Notice, Segmented, SkeletonRows, StatusBadge, Textarea, useToast, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, money, titleCase } from '@/lib/format';
import type { CustomerDetail, CustomerRow, LoyaltyEntry } from './types';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

const signed = (points: number) => `${points > 0 ? '+' : points < 0 ? '−' : ''}${Math.abs(points).toLocaleString('en-IN')}`;

function AdjustPoints({ open, onClose, customer }: { open: boolean; onClose: () => void; customer: CustomerRow }) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const formId = useId();
  const [direction, setDirection] = useState<'add' | 'remove'>('add');
  const [points, setPoints] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ points?: string; reason?: string }>({});
  useEffect(() => {
    if (open) {
      setDirection('add');
      setPoints('');
      setReason('');
      setErrors({});
    }
  }, [open]);

  const adjust = useMutation({
    mutationFn: (body: { points: number; reason: string }) => api<CustomerRow>(`/customers/${customer.id}/loyalty/adjust`, { method: 'POST', body }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      notify(`${saved.name} now has ${saved.loyaltyPoints.toLocaleString('en-IN')} points`);
      onClose();
    },
  });

  const submit = () => {
    const next: typeof errors = {};
    const count = /^\d{1,7}$/.test(points.trim()) ? Number(points.trim()) : NaN;
    if (!Number.isInteger(count) || count < 1) next.points = 'Enter a whole number of points, 1 or more';
    else if (direction === 'remove' && count > customer.loyaltyPoints) next.points = `This customer only has ${customer.loyaltyPoints.toLocaleString('en-IN')} points`;
    const parsed = loyaltyAdjustSchema.safeParse({ points: direction === 'add' ? count : -count, reason });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'reason') next.reason ??= issue.message;
        if (issue.path[0] === 'points') next.points ??= 'Enter a whole number of points, 1 or more';
      }
    }
    setErrors(next);
    if (parsed.success && !next.points && !next.reason) adjust.mutate(parsed.data);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="Adjust loyalty points"
      description={`${customer.name} has ${customer.loyaltyPoints.toLocaleString('en-IN')} points.`}
      footer={
        <>
          <Button onClick={onClose} disabled={adjust.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={adjust.isPending}>
            {direction === 'add' ? 'Add points' : 'Remove points'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Segmented label="Add or remove points" value={direction} onChange={setDirection} options={[{ value: 'add', label: 'Add' }, { value: 'remove', label: 'Remove' }]} className="self-start" />
        <Field label="Points" error={errors.points}>
          {(p) => <Input {...p} inputMode="numeric" autoComplete="off" value={points} onChange={(e) => setPoints(e.target.value)} />}
        </Field>
        <Field label="Reason" error={errors.reason} hint="At least 3 characters. Saved in the loyalty ledger and the audit log.">
          {(p) => <Textarea {...p} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        {adjust.isError ? <Notice tone="bad">{errorMessage(adjust.error)}</Notice> : null}
      </form>
    </Modal>
  );
}

/** A customer's profile, order history and loyalty ledger. */
export function CustomerDrawer({ customerId, onClose, onEdit }: { customerId: string | null; onClose: () => void; onEdit: (customer: CustomerRow) => void }) {
  const { me, can } = useAuth();
  const [adjusting, setAdjusting] = useState(false);
  const currency = me?.restaurant?.currency ?? 'INR';
  const query = useQuery({ queryKey: ['customers', 'detail', customerId], queryFn: () => api<CustomerDetail>(`/customers/${customerId}`), enabled: customerId !== null });
  const c = query.data;
  const outletName = (id: string) => me?.outlets.find((o) => o.id === id)?.name ?? '';

  const orderColumns: Array<Column<CustomerDetail['orders'][number]>> = [
    { key: 'number', header: 'Order', cell: (o) => <span className="tabular font-medium">{o.orderNumber}</span> },
    { key: 'when', header: 'Placed', cell: (o) => <span className="whitespace-nowrap">{dateTime(o.createdAt)}</span> },
    { key: 'type', header: 'Type', cell: (o) => titleCase(o.type) },
    { key: 'outlet', header: 'Outlet', cell: (o) => outletName(o.outletId) },
    { key: 'status', header: 'Status', cell: (o) => <StatusBadge status={o.status} /> },
    { key: 'total', header: 'Total', align: 'right', cell: (o) => money(o.totalMinor, currency) },
  ];
  const ledgerColumns: Array<Column<LoyaltyEntry>> = [
    { key: 'when', header: 'When', cell: (l) => <span className="whitespace-nowrap">{dateTime(l.createdAt)}</span> },
    { key: 'type', header: 'Type', cell: (l) => titleCase(l.type) },
    { key: 'reason', header: 'Reason', cell: (l) => l.reason },
    { key: 'points', header: 'Points', align: 'right', cell: (l) => signed(l.points) },
    { key: 'balance', header: 'Balance', align: 'right', cell: (l) => l.balanceAfter.toLocaleString('en-IN') },
  ];
  const consent = c ? [c.marketingSms && 'SMS', c.marketingEmail && 'Email', c.marketingWhatsapp && 'WhatsApp'].filter((v): v is string => Boolean(v)) : [];

  return (
    <Drawer
      open={customerId !== null}
      onClose={onClose}
      wide
      title={c?.name ?? 'Customer'}
      description="Profile, order history and loyalty points"
      footer={
        c ? (
          <>
            {can('loyalty.adjust') ? <Button onClick={() => setAdjusting(true)}>Adjust points</Button> : null}
            {can('customer.manage') ? (
              <Button variant="primary" onClick={() => onEdit(c)}>
                <Pencil className="h-4 w-4" aria-hidden /> Edit
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      {query.isError ? (
        <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      ) : !c ? (
        <SkeletonRows rows={6} />
      ) : (
        <div className="flex flex-col gap-6">
          <dl className="grid grid-cols-2 gap-4">
            <Fact label="Phone">{c.phone || <span className="text-ink-faint">Not given</span>}</Fact>
            <Fact label="Email">{c.email || <span className="text-ink-faint">Not given</span>}</Fact>
            <Fact label="Loyalty points">
              <span className="tabular text-base font-bold">{c.loyaltyPoints.toLocaleString('en-IN')}</span>
            </Fact>
            <Fact label="Marketing consent">
              {consent.length ? (
                <span className="flex flex-wrap gap-1">
                  {consent.map((channel) => (
                    <Badge key={channel} tone="ok">
                      {channel}
                    </Badge>
                  ))}
                </span>
              ) : (
                <span className="text-ink-faint">None given</span>
              )}
            </Fact>
            {c.gstin ? <Fact label="GSTIN">{c.gstin}</Fact> : null}
            {c.stateCode ? <Fact label="State code">{c.stateCode}</Fact> : null}
          </dl>
          {/* Notes are personal data: shown only when the API returned them for this role. */}
          {can('customer.notes') && c.notes !== undefined ? (
            <div>
              <h3 className="text-sm font-semibold text-ink">Notes</h3>
              <p className="mt-1 whitespace-pre-wrap text-sm text-ink-soft">{c.notes || 'No notes.'}</p>
            </div>
          ) : null}
          <section aria-label="Order history">
            <h3 className="mb-2 text-sm font-semibold text-ink">Order history</h3>
            <div className="rounded-card border border-line">
              <DataTable columns={orderColumns} rows={c.orders} rowKey={(o) => o.id} empty={<EmptyState title="No orders yet" description="Orders in your outlets that name this customer appear here." />} />
            </div>
            {c.orders.length >= 50 ? <p className="mt-1 text-xs text-ink-faint">Showing the 50 most recent orders.</p> : null}
          </section>
          <section aria-label="Loyalty ledger">
            <h3 className="mb-2 text-sm font-semibold text-ink">Loyalty ledger</h3>
            <div className="rounded-card border border-line">
              <DataTable columns={ledgerColumns} rows={c.ledger} rowKey={(l) => l.id} empty={<EmptyState title="No points activity" description="Points earned, redeemed or adjusted will be listed here." />} />
            </div>
          </section>
        </div>
      )}
      {c ? <AdjustPoints open={adjusting} onClose={() => setAdjusting(false)} customer={c} /> : null}
    </Drawer>
  );
}
