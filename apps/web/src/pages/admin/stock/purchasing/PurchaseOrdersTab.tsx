import { purchaseOrderSchema } from '@serveos/shared';
import { useMutation } from '@tanstack/react-query';
import { PackageCheck, Plus, Send } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Button, Card, ConfirmDialog, DataTable, EmptyState, Field, Input, Modal, Notice, Select, StatusBadge, useToast, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth, useOutlet } from '@/lib/auth';
import { dateTime, money } from '@/lib/format';
import { Loadable, Toolbar, TwoLine } from '../../catalogue/common';
import { localInputToIso, payloadResolver, toMinor, validatePayload, type Report } from '../../catalogue/forms';
import { emptyLine, LinesEditor, type Line } from '../LinesEditor';
import { useInvalidateStock, usePurchaseOrders, useStockLookups, useSuppliers } from '../queries';
import { lineValueMinor, qty } from '../quantity';
import type { PurchaseOrder, PurchaseOrderItem, PurchaseOrderStatus } from '../types';
import { ReceiveGoodsDialog } from './ReceiveGoodsDialog';

interface OrderForm {
  supplierId: string;
  expectedOn: string;
  note: string;
  items: Line[];
}

const toPayload = (values: OrderForm, report: Report) => ({
  supplierId: values.supplierId,
  note: values.note,
  expectedOn: localInputToIso(values.expectedOn),
  items: values.items.map((line, i) => ({ ingredientId: line.ingredientId, quantity: line.quantity.trim(), unitId: line.unitId, unitCostMinor: toMinor(line.unitCostMinor, `items.${i}.unitCostMinor`, report) ?? 0 })),
});

const orderValue = (po: Pick<PurchaseOrder, 'items'>): number => po.items.reduce((sum, item) => sum + lineValueMinor(item.quantity, item.unitCostMinor), 0);
const dateOnly = (iso: string | null): string => (iso ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso)) : '');
const RECEIVABLE: PurchaseOrderStatus[] = ['SENT', 'PARTIALLY_RECEIVED'];

function NewOrderDialog({ onClose }: { onClose: () => void }) {
  const notify = useToast();
  const outlet = useOutlet();
  const lookups = useStockLookups();
  const suppliers = useSuppliers();
  const invalidate = useInvalidateStock();
  const form = useForm<OrderForm>({ resolver: payloadResolver(purchaseOrderSchema, toPayload), defaultValues: { supplierId: '', expectedOn: '', note: '', items: [emptyLine(true)] } });
  const { errors } = form.formState;
  const save = useMutation({
    mutationFn: (body: unknown) => api<PurchaseOrder>('/purchase-orders', { method: 'POST', body }),
    onSuccess: (po) => {
      invalidate();
      notify(`${po.poNumber} saved as a draft. Send it when it is ready.`);
      onClose();
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });
  const submit = form.handleSubmit((values) => {
    const result = validatePayload(purchaseOrderSchema, toPayload, values);
    if (result.ok) save.mutate(result.data);
  });
  const active = (suppliers.data ?? []).filter((s) => s.isActive);

  return (
    <Modal open onClose={onClose} title="New purchase order" description={`For delivery to ${outlet.name}. It is saved as a draft first.`} size="lg">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {suppliers.data && active.length === 0 ? <Notice tone="warn">There are no active suppliers. Add one on the Suppliers tab first.</Notice> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Supplier" error={errors.supplierId?.message ?? (suppliers.isError ? errorMessage(suppliers.error) : undefined)}>
            {(p) => (
              <Select {...p} {...form.register('supplierId')}>
                <option value="">Choose a supplier</option>
                {active.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Expected on" error={errors.expectedOn?.message} hint="Optional.">
            {(p) => <Input {...p} type="date" {...form.register('expectedOn')} />}
          </Field>
        </div>
        <Field label="Note to supplier" error={errors.note?.message} hint="Optional.">
          {(p) => <Input {...p} autoComplete="off" {...form.register('note')} />}
        </Field>
        <div>
          <h3 className="mb-2 text-sm font-bold text-ink">Items</h3>
          <Controller control={form.control} name="items" render={({ field }) => <LinesEditor value={field.value} onChange={field.onChange} errors={errors.items} lookups={lookups} withCost addLabel="Add item" />} />
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save draft order
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function OrderDialog({ po, onClose, onReceive }: { po: PurchaseOrder; onClose: () => void; onReceive: () => void }) {
  const notify = useToast();
  const outlet = useOutlet();
  const { can } = useAuth();
  const canManage = can('purchasing.manage');
  const lookups = useStockLookups();
  const invalidate = useInvalidateStock();
  const [cancelling, setCancelling] = useState(false);
  const setStatus = useMutation({
    mutationFn: (action: 'send' | 'cancel') => api<PurchaseOrder>(`/purchase-orders/${po.id}/${action}`, { method: 'POST' }),
    onSuccess: (_updated, action) => {
      invalidate();
      setCancelling(false);
      notify(action === 'send' ? `${po.poNumber} marked as sent. Goods can now be received against it.` : `${po.poNumber} cancelled`);
    },
    onError: (err, action) => {
      if (action === 'send') notify(errorMessage(err), 'bad');
    },
  });

  const columns: Array<Column<PurchaseOrderItem>> = [
    { key: 'ingredient', header: 'Ingredient', cell: (i) => <span className="font-medium">{lookups.ingredientName(i.ingredientId)}</span> },
    { key: 'ordered', header: 'Ordered', align: 'right', cell: (i) => `${qty(i.quantity)} ${lookups.unitCode(i.unitId)}` },
    { key: 'received', header: 'Received', align: 'right', cell: (i) => `${qty(i.receivedQuantity)} ${lookups.unitCode(i.unitId)}` },
    { key: 'cost', header: 'Unit cost', align: 'right', cell: (i) => money(i.unitCostMinor) },
    { key: 'total', header: 'Line value', align: 'right', cell: (i) => money(lineValueMinor(i.quantity, i.unitCostMinor)) },
  ];

  return (
    <Modal
      open
      onClose={onClose}
      title={po.poNumber}
      description={`${po.supplier.name} · created ${dateTime(po.createdAt, outlet.timezone)}${po.expectedOn ? ` · expected ${dateOnly(po.expectedOn)}` : ''}`}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {canManage && (po.status === 'DRAFT' || po.status === 'SENT') ? (
            <Button variant="ghost" className="text-bad hover:text-bad" disabled={setStatus.isPending} onClick={() => (setStatus.reset(), setCancelling(true))}>
              Cancel order
            </Button>
          ) : null}
          {canManage && po.status === 'DRAFT' ? (
            <Button variant="primary" loading={setStatus.isPending && setStatus.variables === 'send'} onClick={() => setStatus.mutate('send')}>
              <Send className="h-4 w-4" aria-hidden />
              Mark as sent
            </Button>
          ) : null}
          {canManage && RECEIVABLE.includes(po.status) ? (
            <Button variant="primary" onClick={onReceive}>
              <PackageCheck className="h-4 w-4" aria-hidden />
              Receive goods
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <StatusBadge status={po.status} />
          <span className="text-sm text-ink-soft">
            Order value <span className="tabular font-semibold text-ink">{money(orderValue(po))}</span>
          </span>
        </div>
        {po.status === 'DRAFT' ? <Notice tone="info">Draft. Marking it as sent records that the supplier has the order; ServeOS does not email it for you. Goods can be received only against a sent order.</Notice> : null}
        {po.note ? <p className="text-sm text-ink-soft">Note: {po.note}</p> : null}
        <div className="rounded-control border border-line">
          <DataTable columns={columns} rows={po.items} rowKey={(i) => i.id} />
        </div>
        <div>
          <h3 className="text-sm font-bold text-ink">Goods receipts</h3>
          {po.receipts.length === 0 ? (
            <p className="text-sm text-ink-faint">Nothing received yet.</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-1 text-sm text-ink-soft">
              {po.receipts.map((r) => (
                <li key={r.id}>
                  <span className="tabular font-medium text-ink">{r.grnNumber}</span> · {dateTime(r.receivedAt, outlet.timezone)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        onConfirm={() => setStatus.mutate('cancel')}
        title={`Cancel ${po.poNumber}?`}
        description="A cancelled purchase order cannot be reopened or received against."
        confirmLabel="Cancel order"
        danger
        pending={setStatus.isPending}
        error={setStatus.isError && setStatus.variables === 'cancel' ? errorMessage(setStatus.error) : null}
      />
    </Modal>
  );
}

export function PurchaseOrdersTab() {
  const outlet = useOutlet();
  const { can } = useAuth();
  const canManage = can('purchasing.manage');
  const orders = usePurchaseOrders();
  const [status, setStatusFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [receivingId, setReceivingId] = useState<string | null>(null);
  // Looked up from the list each time, so the dialogs show the order as it is after each change.
  const viewing = orders.data?.find((po) => po.id === viewingId) ?? null;
  const receiving = orders.data?.find((po) => po.id === receivingId) ?? null;
  const rows = (orders.data ?? []).filter((po) => !status || po.status === status);

  const columns: Array<Column<PurchaseOrder>> = [
    { key: 'number', header: 'Order', cell: (po) => <TwoLine primary={<span className="tabular">{po.poNumber}</span>} secondary={dateTime(po.createdAt, outlet.timezone)} /> },
    { key: 'supplier', header: 'Supplier', cell: (po) => po.supplier.name },
    { key: 'status', header: 'Status', cell: (po) => <StatusBadge status={po.status} /> },
    { key: 'items', header: 'Items', align: 'right', cell: (po) => po.items.length },
    { key: 'value', header: 'Value', align: 'right', cell: (po) => money(orderValue(po)) },
    { key: 'expected', header: 'Expected', cell: (po) => (po.expectedOn ? <span className="whitespace-nowrap">{dateOnly(po.expectedOn)}</span> : <span className="text-ink-faint">—</span>) },
  ];

  return (
    <Card>
      <Toolbar>
        <Select aria-label="Status" className="w-auto min-w-44" value={status} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">Any status</option>
          <option value="DRAFT">Draft</option>
          <option value="SENT">Sent</option>
          <option value="PARTIALLY_RECEIVED">Partially received</option>
          <option value="RECEIVED">Received</option>
          <option value="CANCELLED">Cancelled</option>
        </Select>
        {canManage ? (
          <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            New purchase order
          </Button>
        ) : null}
      </Toolbar>
      <Loadable query={orders}>
        {(data) => (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(po) => po.id}
            onRowClick={(po) => setViewingId(po.id)}
            empty={data.length ? <EmptyState title="No purchase orders with this status" /> : <EmptyState title="No purchase orders yet" description={`Orders raised for ${outlet.name} are listed here.`} action={canManage ? <Button variant="primary" onClick={() => setCreating(true)}>New purchase order</Button> : undefined} />}
          />
        )}
      </Loadable>
      {creating && canManage ? <NewOrderDialog onClose={() => setCreating(false)} /> : null}
      {viewing && !receiving ? <OrderDialog po={viewing} onClose={() => setViewingId(null)} onReceive={() => setReceivingId(viewing.id)} /> : null}
      {receiving && canManage ? <ReceiveGoodsDialog po={receiving} onClose={() => setReceivingId(null)} /> : null}
    </Card>
  );
}
