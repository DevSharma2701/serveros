import { stockAdjustmentSchema } from '@serveos/shared';
import { useMutation } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { Button, Field, Input, Modal, Notice, Segmented, Select, Textarea, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { payloadResolver, validatePayload } from '../../catalogue/forms';
import { useInvalidateStock } from '../queries';
import { qty } from '../quantity';
import type { StockRow, Unit } from '../types';

interface AdjustForm {
  type: 'WASTAGE' | 'ADJUSTMENT';
  direction: 'IN' | 'OUT';
  quantity: string;
  unitId: string;
  reason: string;
}

/** Records wastage (always removes stock) or a manual adjustment (adds or removes) for one ingredient. */
export function AdjustDialog({ row, units, onClose }: { row: StockRow; units: Unit[]; onClose: () => void }) {
  const notify = useToast();
  const invalidate = useInvalidateStock();
  const baseUnit = units.find((u) => u.code === row.unit);
  const choices = baseUnit ? units.filter((u) => u.dimension === baseUnit.dimension) : [];
  const toPayload = (values: AdjustForm) => ({ ingredientId: row.ingredientId, ...values, direction: values.type === 'WASTAGE' ? 'OUT' : values.direction });
  const form = useForm<AdjustForm>({
    resolver: payloadResolver(stockAdjustmentSchema, toPayload),
    defaultValues: { type: 'WASTAGE', direction: 'OUT', quantity: '', unitId: baseUnit?.id ?? '', reason: '' },
  });
  const { errors } = form.formState;
  const type = form.watch('type');
  const save = useMutation({
    mutationFn: (body: unknown) => api<{ ingredientId: string; balanceAfter: string }>('/inventory/adjustments', { method: 'POST', body }),
    onSuccess: (result) => {
      invalidate();
      notify(`${row.name}: stock is now ${qty(result.balanceAfter)} ${row.unit}`);
      onClose();
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });
  const submit = form.handleSubmit((values) => {
    const result = validatePayload(stockAdjustmentSchema, toPayload, values);
    if (result.ok) save.mutate(result.data);
  });

  return (
    <Modal open onClose={onClose} title={`Adjust ${row.name}`} description={`System stock: ${qty(row.quantity)} ${row.unit}`}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Controller
          control={form.control}
          name="type"
          render={({ field }) => (
            <Segmented
              label="Kind of change"
              value={field.value}
              onChange={field.onChange}
              options={[
                { value: 'WASTAGE', label: 'Wastage' },
                { value: 'ADJUSTMENT', label: 'Adjustment' },
              ]}
              className="self-start"
            />
          )}
        />
        {type === 'ADJUSTMENT' ? (
          <Field label="Direction" error={errors.direction?.message}>
            {(p) => (
              <Select {...p} {...form.register('direction')}>
                <option value="OUT">Remove from stock</option>
                <option value="IN">Add to stock</option>
              </Select>
            )}
          </Field>
        ) : (
          <p className="text-sm text-ink-soft">Wastage removes stock: spoiled, spilled, burnt or expired.</p>
        )}
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-3">
          <Field label="Quantity" error={errors.quantity?.message}>
            {(p) => <Input {...p} inputMode="decimal" autoComplete="off" className="tabular text-right" autoFocus {...form.register('quantity')} />}
          </Field>
          <Field label="Unit" error={errors.unitId?.message}>
            {(p) => (
              <Select {...p} {...form.register('unitId')}>
                {choices.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.code}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Reason" error={errors.reason?.message} hint="At least 3 characters. Saved in the stock history and the audit log.">
          {(p) => <Textarea {...p} rows={2} maxLength={300} {...form.register('reason')} />}
        </Field>
        {choices.length === 0 ? <Notice tone="warn">The units for this ingredient could not be loaded.</Notice> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {type === 'WASTAGE' ? 'Record wastage' : 'Record adjustment'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
