import { discountSchema } from '@serveos/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Badge, Button, Card, Checkbox, DataTable, EmptyState, Field, Input, Modal, Notice, Select, useToast, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { dateTime, money, percent } from '@/lib/format';
import { Loadable, Toolbar, TwoLine } from '../common';
import { bpsToText, isoToLocalInput, localInputToIso, minorToText, payloadResolver, toBps, toInt, toMinor, validatePayload, type Report } from '../forms';
import { useDiscounts } from '../queries';
import type { Discount } from '../types';

interface DiscountForm {
  name: string;
  code: string;
  type: 'PERCENT' | 'FLAT';
  value: string;
  maxDiscountMinor: string;
  minOrderMinor: string;
  usageLimit: string;
  validFrom: string;
  validTo: string;
  isActive: boolean;
}

function toPayload(values: DiscountForm, report: Report) {
  const value = values.type === 'PERCENT' ? toBps(values.value, 'value', report) : (toMinor(values.value, 'value', report) ?? 0);
  if (values.type === 'PERCENT' && value > 10_000) report('value', 'A percentage discount cannot exceed 100%');
  const validFrom = localInputToIso(values.validFrom);
  const validTo = localInputToIso(values.validTo);
  if (validFrom && validTo && validFrom >= validTo) report('validTo', 'The discount must end after it starts');
  const code = values.code.trim().toUpperCase();
  if (code && !/^[A-Z0-9-]{3,20}$/.test(code)) report('code', 'Use 3 to 20 letters, digits or hyphens');
  return {
    name: values.name,
    code: code || null,
    type: values.type,
    value,
    // A cap only makes sense for a percentage; a flat discount is its own cap.
    maxDiscountMinor: values.type === 'PERCENT' ? toMinor(values.maxDiscountMinor, 'maxDiscountMinor', report, { optional: true }) : null,
    minOrderMinor: toMinor(values.minOrderMinor, 'minOrderMinor', report, { optional: true }) ?? 0,
    usageLimit: toInt(values.usageLimit, 'usageLimit', report, { optional: true }),
    validFrom,
    validTo,
    isActive: values.isActive,
  };
}

const valueLabel = (d: Pick<Discount, 'type' | 'value'>): string => (d.type === 'PERCENT' ? `${percent(d.value)} off` : `${money(d.value)} off`);

/** Why a discount cannot be used right now, or null when it can. Mirrors what the API checks at the till. */
function blockedReason(d: Discount, now = Date.now()): string | null {
  if (!d.isActive) return 'Inactive';
  if (d.validFrom && new Date(d.validFrom).getTime() > now) return 'Not started';
  if (d.validTo && new Date(d.validTo).getTime() < now) return 'Expired';
  if (d.usageLimit != null && d.usedCount >= d.usageLimit) return 'Used up';
  return null;
}

function DiscountDialog({ discount, onClose }: { discount: Discount | null; onClose: () => void }) {
  const notify = useToast();
  const queryClient = useQueryClient();
  // The API refuses to change the value of a discount that has been used, so those fields are locked.
  const locked = !!discount && discount.usedCount > 0;
  const form = useForm<DiscountForm>({
    resolver: payloadResolver(discountSchema, toPayload),
    defaultValues: discount
      ? {
          name: discount.name,
          code: discount.code ?? '',
          type: discount.type,
          value: discount.type === 'PERCENT' ? bpsToText(discount.value) : minorToText(discount.value),
          maxDiscountMinor: minorToText(discount.maxDiscountMinor),
          minOrderMinor: discount.minOrderMinor ? minorToText(discount.minOrderMinor) : '',
          usageLimit: discount.usageLimit == null ? '' : String(discount.usageLimit),
          validFrom: isoToLocalInput(discount.validFrom),
          validTo: isoToLocalInput(discount.validTo),
          isActive: discount.isActive,
        }
      : { name: '', code: '', type: 'PERCENT', value: '', maxDiscountMinor: '', minOrderMinor: '', usageLimit: '', validFrom: '', validTo: '', isActive: true },
  });
  const { errors } = form.formState;
  const type = form.watch('type');
  const save = useMutation({
    mutationFn: (body: unknown) => (discount ? api<Discount>(`/discounts/${discount.id}`, { method: 'PATCH', body }) : api<Discount>('/discounts', { method: 'POST', body })),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['discounts'] });
      notify(`Discount ${saved.name} saved`);
      onClose();
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });
  const submit = form.handleSubmit((values) => {
    const result = validatePayload(discountSchema, toPayload, values);
    if (!result.ok) return;
    if (!locked) return save.mutate(result.data);
    const { type: _type, value: _value, ...rest } = result.data;
    save.mutate(rest);
  });

  return (
    <Modal open onClose={onClose} title={discount ? `Edit ${discount.name}` : 'New discount'} description="With a coupon code the cashier types the code; without one the discount is picked from a list." size="lg">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {locked ? (
          <Notice tone="info">
            This discount has been used {discount.usedCount} time{discount.usedCount === 1 ? '' : 's'}, so its type and value can no longer change. To offer a different value, deactivate it and create a new one.
          </Notice>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={errors.name?.message}>
            {(p) => <Input {...p} autoComplete="off" autoFocus {...form.register('name')} />}
          </Field>
          <Field label="Coupon code" error={errors.code?.message} hint="Optional. Letters, digits and hyphens.">
            {(p) => <Input {...p} autoComplete="off" className="uppercase" {...form.register('code')} />}
          </Field>
          <Field label="Type" error={errors.type?.message}>
            {(p) => (
              <Select {...p} disabled={locked} {...form.register('type')}>
                <option value="PERCENT">Percentage of the bill</option>
                <option value="FLAT">Fixed amount</option>
              </Select>
            )}
          </Field>
          <Field label={type === 'PERCENT' ? 'Discount (%)' : 'Discount (₹)'} error={errors.value?.message}>
            {(p) => <Input {...p} inputMode="decimal" autoComplete="off" className="tabular text-right" disabled={locked} {...form.register('value')} />}
          </Field>
          {type === 'PERCENT' ? (
            <Field label="Maximum discount (₹)" error={errors.maxDiscountMinor?.message} hint="Optional cap on the amount taken off.">
              {(p) => <Input {...p} inputMode="decimal" autoComplete="off" className="tabular text-right" {...form.register('maxDiscountMinor')} />}
            </Field>
          ) : null}
          <Field label="Minimum order (₹)" error={errors.minOrderMinor?.message} hint="Optional.">
            {(p) => <Input {...p} inputMode="decimal" autoComplete="off" className="tabular text-right" {...form.register('minOrderMinor')} />}
          </Field>
          <Field label="Usage limit" error={errors.usageLimit?.message} hint="Optional. Total number of times it can be used.">
            {(p) => <Input {...p} inputMode="numeric" autoComplete="off" className="tabular text-right" {...form.register('usageLimit')} />}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Valid from" error={errors.validFrom?.message} hint="Optional. Your local time.">
            {(p) => <Input {...p} type="datetime-local" {...form.register('validFrom')} />}
          </Field>
          <Field label="Valid until" error={errors.validTo?.message} hint="Optional.">
            {(p) => <Input {...p} type="datetime-local" {...form.register('validTo')} />}
          </Field>
        </div>
        <Checkbox label="Active" {...form.register('isActive')} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {discount ? 'Save discount' : 'Create discount'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function DiscountsTab() {
  const discounts = useDiscounts();
  const [editing, setEditing] = useState<Discount | 'new' | null>(null);

  const columns: Array<Column<Discount>> = [
    { key: 'name', header: 'Discount', cell: (d) => <TwoLine primary={d.name} secondary={d.code ? <span className="tabular">Code {d.code}</span> : 'No code (picked from a list)'} /> },
    {
      key: 'value',
      header: 'Value',
      cell: (d) => <TwoLine primary={valueLabel(d)} secondary={[d.maxDiscountMinor != null ? `up to ${money(d.maxDiscountMinor)}` : '', d.minOrderMinor ? `orders from ${money(d.minOrderMinor)}` : ''].filter(Boolean).join(' · ') || undefined} />,
    },
    { key: 'used', header: 'Used', align: 'right', cell: (d) => (d.usageLimit != null ? `${d.usedCount} of ${d.usageLimit}` : d.usedCount) },
    {
      key: 'validity',
      header: 'Valid',
      cell: (d) => (d.validFrom || d.validTo ? <span className="whitespace-nowrap text-ink-soft">{d.validFrom ? dateTime(d.validFrom) : 'Any time'} → {d.validTo ? dateTime(d.validTo) : 'no end'}</span> : <span className="text-ink-faint">Always</span>),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (d) => {
        const blocked = blockedReason(d);
        return <Badge tone={blocked ? (blocked === 'Inactive' ? 'neutral' : 'warn') : 'ok'}>{blocked ?? 'Active'}</Badge>;
      },
    },
  ];

  return (
    <Card>
      <Toolbar className="justify-end">
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" aria-hidden />
          New discount
        </Button>
      </Toolbar>
      <Loadable query={discounts}>
        {(data) => (
          <DataTable
            columns={columns}
            rows={data}
            rowKey={(d) => d.id}
            onRowClick={setEditing}
            empty={<EmptyState title="No discounts yet" description="Create named discounts and coupon codes for the cashiers to apply." action={<Button variant="primary" onClick={() => setEditing('new')}>New discount</Button>} />}
          />
        )}
      </Loadable>
      {editing ? <DiscountDialog discount={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}
