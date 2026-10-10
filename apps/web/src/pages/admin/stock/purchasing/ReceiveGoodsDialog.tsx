import { goodsReceiptSchema } from '@serveos/shared';
import { useMutation } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { Button, ErrorState, Field, Input, Modal, Notice, Select, SkeletonRows, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useOutlet } from '@/lib/auth';
import { money } from '@/lib/format';
import { FormSection, InlineError } from '../../catalogue/common';
import { errorAt, localInputToIso, minorToText, payloadResolver, toMinor, validatePayload, type Report } from '../../catalogue/forms';
import { emptyLine, LinesEditor, type Line } from '../LinesEditor';
import { useInvalidateStock, useStockLookups, useSuppliers, type StockLookups } from '../queries';
import { isQty, isZero, lineValueMinor, qty, remainingQty } from '../quantity';
import type { GoodsReceipt, PurchaseOrder, Supplier } from '../types';

interface ReceiveLine extends Line {
  purchaseOrderItemId?: string;
}

interface ReceiveForm {
  supplierId: string;
  invoiceNumber: string;
  invoiceDate: string;
  invoiceTotalMinor: string;
  note: string;
  items: ReceiveLine[];
}

/**
 * Typed values -> the body of POST /goods-receipts. Against a purchase order, lines whose quantity
 * is empty or zero are simply not received now (a partial receipt); the rest of the order stays open.
 */
function buildPayload(po: PurchaseOrder | null) {
  return (values: ReceiveForm, report: Report) => {
    const lines = values.items.map((line, index) => ({ line, index }));
    const receiving = po ? lines.filter(({ line }) => line.quantity.trim() && !isZero(line.quantity.trim())) : lines;
    for (const { line, index } of receiving) {
      if (po && !isQty(line.quantity)) report(`items.${index}.quantity`, 'Enter a quantity with up to 4 decimals');
    }
    if (po && receiving.length === 0) report('items.root', 'Enter the quantity received for at least one line');
    return {
      purchaseOrderId: po?.id ?? null,
      supplierId: po ? null : values.supplierId || null,
      invoiceNumber: values.invoiceNumber,
      invoiceDate: localInputToIso(values.invoiceDate),
      invoiceTotalMinor: toMinor(values.invoiceTotalMinor, 'invoiceTotalMinor', report, { optional: true }),
      note: values.note,
      items: receiving.map(({ line, index }) => ({
        purchaseOrderItemId: line.purchaseOrderItemId ?? null,
        ingredientId: line.ingredientId,
        quantity: line.quantity.trim(),
        unitId: line.unitId,
        unitCostMinor: toMinor(line.unitCostMinor, `items.${index}.unitCostMinor`, report) ?? 0,
      })),
    };
  };
}

function ReceiveGoodsForm({ po, suppliers, lookups, onClose }: { po: PurchaseOrder | null; suppliers: Supplier[]; lookups: StockLookups; onClose: () => void }) {
  const notify = useToast();
  const invalidate = useInvalidateStock();
  const toPayload = buildPayload(po);
  const form = useForm<ReceiveForm>({
    resolver: payloadResolver(goodsReceiptSchema, toPayload),
    defaultValues: {
      supplierId: '',
      invoiceNumber: '',
      invoiceDate: '',
      invoiceTotalMinor: '',
      note: '',
      // Start from what is still outstanding on the order, at the agreed cost.
      items: po ? po.items.map((item) => ({ purchaseOrderItemId: item.id, ingredientId: item.ingredientId, unitId: item.unitId, quantity: remainingQty(item.quantity, item.receivedQuantity), unitCostMinor: minorToText(item.unitCostMinor) })) : [emptyLine(true)],
    },
  });
  const { errors } = form.formState;
  const save = useMutation({
    mutationFn: (body: unknown) => api<GoodsReceipt>('/goods-receipts', { method: 'POST', body }),
    onSuccess: (grn) => {
      invalidate();
      notify(`${grn.grnNumber} recorded: ${grn.items.length} line${grn.items.length === 1 ? '' : 's'} added to stock`);
      onClose();
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });
  const submit = form.handleSubmit((values) => {
    const result = validatePayload(goodsReceiptSchema, toPayload, values);
    if (result.ok) save.mutate(result.data);
  });

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <FormSection title="Supplier invoice" description="Optional, but it makes matching the supplier’s bill easier later.">
        <div className="grid gap-4 sm:grid-cols-3">
          {po ? null : (
            <Field label="Supplier" error={errors.supplierId?.message} hint="Optional." className="sm:col-span-3">
              {(p) => (
                <Select {...p} {...form.register('supplierId')}>
                  <option value="">Not recorded</option>
                  {suppliers
                    .filter((s) => s.isActive)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="Invoice number" error={errors.invoiceNumber?.message}>
            {(p) => <Input {...p} autoComplete="off" {...form.register('invoiceNumber')} />}
          </Field>
          <Field label="Invoice date" error={errors.invoiceDate?.message}>
            {(p) => <Input {...p} type="date" {...form.register('invoiceDate')} />}
          </Field>
          <Field label="Invoice total (₹)" error={errors.invoiceTotalMinor?.message}>
            {(p) => <Input {...p} inputMode="decimal" autoComplete="off" className="tabular text-right" {...form.register('invoiceTotalMinor')} />}
          </Field>
        </div>
        <Field label="Note" error={errors.note?.message}>
          {(p) => <Input {...p} autoComplete="off" {...form.register('note')} />}
        </Field>
      </FormSection>

      {po ? (
        <FormSection title="Quantities received" description="Change a quantity for a partial delivery, or clear it for a line that did not arrive. The order stays open until everything is received.">
          <InlineError message={errorAt(errors, 'items', 'root')} />
          <ul className="flex flex-col gap-2">
            {po.items.map((item, i) => {
              const name = lookups.ingredientName(item.ingredientId);
              const unit = lookups.unitCode(item.unitId);
              const problems = [errorAt(errors, 'items', i, 'quantity'), errorAt(errors, 'items', i, 'unitCostMinor'), errorAt(errors, 'items', i, 'unitId')].filter(Boolean);
              return (
                <li key={item.id} className="rounded-control border border-line bg-sunken/40 p-3">
                  <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
                    <div className="col-span-2 sm:col-span-1 sm:self-center">
                      <p className="font-medium text-ink">{name}</p>
                      <p className="text-xs text-ink-soft">
                        Ordered {qty(item.quantity)} {unit} · received so far {qty(item.receivedQuantity)} {unit}
                      </p>
                    </div>
                    <Field label={`Receiving now (${unit})`}>
                      {(p) => <Input {...p} aria-label={`Quantity of ${name} receiving now, in ${unit}`} inputMode="decimal" autoComplete="off" className="tabular text-right" {...form.register(`items.${i}.quantity`)} />}
                    </Field>
                    <Field label={`Cost per ${unit} (₹)`}>
                      {(p) => <Input {...p} aria-label={`Cost of ${name} per ${unit} in rupees`} inputMode="decimal" autoComplete="off" className="tabular text-right" {...form.register(`items.${i}.unitCostMinor`)} />}
                    </Field>
                  </div>
                  {problems.length ? (
                    <p role="alert" className="mt-1 text-sm text-bad">
                      {problems.join(' · ')}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </FormSection>
      ) : (
        <FormSection title="Goods received" description="Each line adds to stock at this outlet and updates the ingredient’s average cost.">
          <Controller control={form.control} name="items" render={({ field }) => <LinesEditor value={field.value} onChange={field.onChange} errors={errors.items} lookups={lookups} withCost addLabel="Add ingredient" />} />
        </FormSection>
      )}

      <div className="sticky -bottom-4 -mx-5 -mb-4 rounded-b-card flex flex-wrap justify-end gap-2 border-t border-line bg-surface px-5 py-3">
        <Button onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          Receive into stock
        </Button>
      </div>
    </form>
  );
}

/** Receives goods into the selected outlet: against a sent purchase order, or directly without one. */
export function ReceiveGoodsDialog({ po, onClose }: { po: PurchaseOrder | null; onClose: () => void }) {
  const outlet = useOutlet();
  const lookups = useStockLookups();
  const suppliers = useSuppliers();
  const needed = [lookups.ingredients, lookups.units, ...(po ? [] : [suppliers])];
  const failed = needed.find((q) => q.isError);
  const orderValue = po ? po.items.reduce((sum, item) => sum + lineValueMinor(item.quantity, item.unitCostMinor), 0) : 0;
  return (
    <Modal
      open
      onClose={onClose}
      title={po ? `Receive goods for ${po.poNumber}` : 'Receive goods without a purchase order'}
      description={po ? `${po.supplier.name} · order value about ${money(orderValue)} · into ${outlet.name}` : `Directly into stock at ${outlet.name}`}
      size="lg"
    >
      {failed ? (
        <ErrorState message={errorMessage(failed.error)} onRetry={() => needed.forEach((q) => q.isError && void q.refetch())} />
      ) : needed.some((q) => q.isPending) ? (
        <SkeletonRows rows={5} />
      ) : !po && (lookups.ingredients.data ?? []).every((i) => !i.isActive) ? (
        <Notice tone="info">There are no active ingredients yet. Add them on the Inventory page first.</Notice>
      ) : (
        <ReceiveGoodsForm po={po} suppliers={suppliers.data ?? []} lookups={lookups} onClose={onClose} />
      )}
    </Modal>
  );
}
