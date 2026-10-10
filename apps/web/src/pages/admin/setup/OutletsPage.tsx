import { zodResolver } from '@hookform/resolvers/zod';
import { outletSchema } from '@serveos/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Badge, Button, Card, Checkbox, DataTable, EmptyState, ErrorState, Field, Input, Modal, Notice, PageHeader, SkeletonRows, useToast, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { amount, money, parseAmount } from '@/lib/format';
import type { Outlet } from './types';

const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value.length > 0;
  } catch {
    return false;
  }
};

/** The outlet form as typed: the delivery charge is text in rupees, and empty tax numbers mean "none". */
const outletFormSchema = z.object({
  name: outletSchema.shape.name,
  code: outletSchema.shape.code,
  addressLine1: z.string().trim().max(200),
  city: z.string().trim().max(80),
  stateCode: z.string().trim().max(4, 'Use the GST state code, up to 4 characters'),
  postalCode: z.string().trim().max(12),
  phone: z.string().trim().max(20),
  gstin: z.string().trim().max(20),
  fssaiNumber: z.string().trim().max(20),
  timezone: z.string().trim().max(60).refine(isTimeZone, 'Enter an IANA time zone such as Asia/Kolkata'),
  serviceChargeEnabled: z.boolean(),
  deliveryCharge: z.string().refine((v) => parseAmount(v) !== null, 'Enter an amount such as 40 or 40.00'),
  isActive: z.boolean(),
});
type OutletForm = z.infer<typeof outletFormSchema>;
type OutletBody = z.output<typeof outletSchema>;

const toForm = (o: Outlet | null): OutletForm => ({
  name: o?.name ?? '',
  code: o?.code ?? '',
  addressLine1: o?.addressLine1 ?? '',
  city: o?.city ?? '',
  stateCode: o?.stateCode ?? '',
  postalCode: o?.postalCode ?? '',
  phone: o?.phone ?? '',
  gstin: o?.gstin ?? '',
  fssaiNumber: o?.fssaiNumber ?? '',
  timezone: o?.timezone ?? 'Asia/Kolkata',
  serviceChargeEnabled: o?.serviceChargeEnabled ?? false,
  deliveryCharge: amount(o?.deliveryChargeMinor ?? 0),
  isActive: o?.isActive ?? true,
});

const toBody = (f: OutletForm): OutletBody => {
  const { deliveryCharge, gstin, fssaiNumber, ...rest } = f;
  return outletSchema.parse({ ...rest, gstin: gstin || null, fssaiNumber: fssaiNumber || null, deliveryChargeMinor: parseAmount(deliveryCharge) ?? 0 });
};

function OutletFormModal({ open, onClose, outlet }: { open: boolean; onClose: () => void; outlet: Outlet | null }) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const formId = useId();
  const zonesId = useId();
  const editing = outlet !== null;
  const form = useForm<OutletForm>({ resolver: zodResolver(outletFormSchema), defaultValues: toForm(outlet) });
  const { errors } = form.formState;
  const { reset, register } = form;
  useEffect(() => {
    if (open) reset(toForm(outlet));
  }, [open, outlet, reset]);
  const zones = useMemo(() => (typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []), []);

  const save = useMutation({
    mutationFn: (body: Partial<OutletBody>) => (outlet ? api<Outlet>(`/outlets/${outlet.id}`, { method: 'PATCH', body }) : api<Outlet>('/outlets', { method: 'POST', body })),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['outlets'] });
      notify(editing ? `${saved.name} updated` : `${saved.name} created with a kitchen station, a cash register and a dining area. Reload to see it in the outlet switcher.`);
      onClose();
    },
  });

  const submit = form.handleSubmit((values) => {
    const next = toBody(values);
    if (!outlet) return save.mutate(next);
    // PATCH is partial: send only what was changed.
    const body: Record<string, unknown> = {};
    // Guest (QR) ordering is switched on the QR codes page, never from this form.
    for (const key of Object.keys(next) as Array<keyof OutletBody>) if (key !== 'qrOrderingEnabled' && next[key] !== outlet[key]) body[key] = next[key];
    if (Object.keys(body).length === 0) return onClose();
    save.mutate(body as Partial<OutletBody>);
  });
  const active = form.watch('isActive');

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? `Edit ${outlet.name}` : 'Add an outlet'}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={save.isPending}>
            {editing ? 'Save changes' : 'Create outlet'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <Field label="Outlet name" error={errors.name ? 'Enter a name (up to 120 characters)' : undefined}>
            {(p) => <Input {...p} autoFocus {...register('name')} />}
          </Field>
          <Field label="Code" error={errors.code?.message} hint={editing ? 'Part of invoice numbers: cannot change once the outlet has orders.' : '2-5 capital letters or digits. Used in invoice numbers.'}>
            {(p) => <Input {...p} maxLength={5} autoCapitalize="characters" className="uppercase" {...register('code', { setValueAs: (v: string) => (typeof v === 'string' ? v.toUpperCase() : v) })} />}
          </Field>
        </div>
        <Field label="Address" error={errors.addressLine1?.message}>
          {(p) => <Input {...p} {...register('addressLine1')} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="City" error={errors.city?.message}>
            {(p) => <Input {...p} {...register('city')} />}
          </Field>
          <Field label="State code" error={errors.stateCode?.message} hint="GST state code, e.g. 29.">
            {(p) => <Input {...p} maxLength={4} {...register('stateCode')} />}
          </Field>
          <Field label="Postal code" error={errors.postalCode?.message}>
            {(p) => <Input {...p} {...register('postalCode')} />}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Phone" error={errors.phone?.message}>
            {(p) => <Input {...p} type="tel" {...register('phone')} />}
          </Field>
          <Field label="GSTIN" error={errors.gstin?.message} hint="Optional.">
            {(p) => <Input {...p} {...register('gstin')} />}
          </Field>
          <Field label="FSSAI number" error={errors.fssaiNumber?.message} hint="Optional.">
            {(p) => <Input {...p} {...register('fssaiNumber')} />}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Time zone" error={errors.timezone?.message} hint="IANA name, e.g. Asia/Kolkata. Decides what counts as today in reports.">
            {(p) => <Input {...p} list={zonesId} autoComplete="off" {...register('timezone')} />}
          </Field>
          <Field label="Delivery charge" error={errors.deliveryCharge?.message} hint="Added to delivery orders. 0 for none.">
            {(p) => <Input {...p} inputMode="decimal" {...register('deliveryCharge')} />}
          </Field>
        </div>
        <datalist id={zonesId}>
          {zones.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        <div>
          <Checkbox label="Add the service charge to dine-in bills here" {...register('serviceChargeEnabled')} />
          <p className="pl-8 text-sm text-ink-faint">The percentage is set once for the restaurant, under Settings.</p>
        </div>
        {editing ? (
          <div>
            <Checkbox label="Outlet is active" {...register('isActive')} />
            {!active ? (
              <Notice tone="warn" className="mt-1">
                An inactive outlet cannot take orders. Its past orders and reports are kept.
              </Notice>
            ) : null}
          </div>
        ) : null}
        {save.isError ? <Notice tone="bad" title="The outlet was not saved">{errorMessage(save.error)}</Notice> : null}
      </form>
    </Modal>
  );
}

export function OutletsPage() {
  const { me } = useAuth();
  const currency = me?.restaurant?.currency ?? 'INR';
  const [form, setForm] = useState<{ outlet: Outlet | null } | null>(null);
  const query = useQuery({ queryKey: ['outlets'], queryFn: () => api<Outlet[]>('/outlets') });

  const columns: Array<Column<Outlet>> = [
    {
      key: 'name',
      header: 'Outlet',
      cell: (o) => (
        <div>
          <p className="font-medium">{o.name}</p>
          <p className="text-xs text-ink-soft">{[o.addressLine1, o.city].filter(Boolean).join(', ')}</p>
        </div>
      ),
    },
    { key: 'code', header: 'Code', cell: (o) => <span className="tabular font-mono text-xs">{o.code}</span> },
    { key: 'tz', header: 'Time zone', cell: (o) => o.timezone, className: 'hidden md:table-cell' },
    { key: 'service', header: 'Service charge', cell: (o) => (o.serviceChargeEnabled ? <Badge tone="info">On</Badge> : <Badge>Off</Badge>), className: 'hidden sm:table-cell' },
    { key: 'delivery', header: 'Delivery charge', align: 'right', cell: (o) => money(o.deliveryChargeMinor, currency), className: 'hidden sm:table-cell' },
    { key: 'status', header: 'Status', cell: (o) => (o.isActive ? <Badge tone="ok">Active</Badge> : <Badge tone="bad">Inactive</Badge>) },
  ];

  return (
    <div>
      <PageHeader
        title="Outlets"
        description="Each place you trade from. Select an outlet to edit it."
        actions={
          <Button variant="primary" onClick={() => setForm({ outlet: null })}>
            <Plus className="h-4 w-4" aria-hidden /> Add outlet
          </Button>
        }
      />
      <Card className="overflow-hidden">
        {query.isError && !query.data ? (
          <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : !query.data ? (
          <SkeletonRows rows={4} />
        ) : (
          <DataTable columns={columns} rows={query.data} rowKey={(o) => o.id} onRowClick={(outlet) => setForm({ outlet })} empty={<EmptyState title="No outlets yet" description="Add your first outlet to start taking orders." />} />
        )}
      </Card>
      <OutletFormModal open={form !== null} onClose={() => setForm(null)} outlet={form?.outlet ?? null} />
    </div>
  );
}
