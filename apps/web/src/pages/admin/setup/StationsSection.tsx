import { zodResolver } from '@hookform/resolvers/zod';
import { stationSchema } from '@serveos/shared';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Badge, Button, Checkbox, DataTable, EmptyState, ErrorState, Field, Input, SkeletonRows, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth, useOutlet } from '@/lib/auth';
import { ActiveBadge, FormModal, SetupSection, useSave } from './components/SetupSection';
import type { KitchenStation } from './types';

type StationInput = z.input<typeof stationSchema>;
type StationOutput = z.output<typeof stationSchema>;

function StationModal({ open, onClose, station }: { open: boolean; onClose: () => void; station: KitchenStation | null }) {
  const form = useForm<StationInput, unknown, StationOutput>({ resolver: zodResolver(stationSchema), defaultValues: { key: '', name: '', isDefault: false, isActive: true, sortOrder: 0 } });
  const { errors } = form.formState;
  const { reset } = form;
  useEffect(() => {
    if (open) reset({ key: station?.key ?? '', name: station?.name ?? '', isDefault: station?.isDefault ?? false, isActive: station?.isActive ?? true, sortOrder: station?.sortOrder ?? 0 });
  }, [open, station, reset]);
  const save = useSave(
    (body: StationOutput) => {
      if (!station) return api<KitchenStation>('/kitchen/stations', { method: 'POST', body });
      // Products point at a station by its key, so the key is fixed once the station exists.
      const { key: _key, ...changes } = body;
      return api<KitchenStation>(`/kitchen/stations/${station.id}`, { method: 'PATCH', body: changes });
    },
    { invalidate: ['kitchen', 'catalog'], success: (saved) => `${saved.name} ${station ? 'updated' : 'added'}`, onDone: onClose },
  );
  return (
    <FormModal open={open} onClose={onClose} title={station ? `Edit ${station.name}` : 'Add a kitchen station'} submitLabel={station ? 'Save changes' : 'Add station'} pending={save.isPending} error={save.error} onSubmit={form.handleSubmit((v) => save.mutate(v))}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Station name" error={errors.name ? 'Enter a name (up to 120 characters)' : undefined} hint="For example Hot kitchen, Tandoor, Bar.">
          {(p) => <Input {...p} autoFocus {...form.register('name')} />}
        </Field>
        <Field label="Key" error={errors.key ? 'Use 2-20 capital letters, digits or underscores' : undefined} hint={station ? 'Products are routed by this key, so it cannot be changed.' : 'Short code products are routed by, e.g. HOT. Cannot be changed later.'}>
          {(p) => <Input {...p} maxLength={20} readOnly={station !== null} className={station ? 'bg-sunken uppercase text-ink-soft' : 'uppercase'} {...form.register('key')} />}
        </Field>
      </div>
      <Field label="Position in the list" error={errors.sortOrder ? 'Enter a whole number, 0 or more' : undefined} hint="Lower numbers are shown first.">
        {(p) => <Input {...p} type="number" min={0} step={1} inputMode="numeric" className="max-w-32" {...form.register('sortOrder', { valueAsNumber: true })} />}
      </Field>
      <div>
        <Checkbox label="Default station" {...form.register('isDefault')} />
        <p className="pl-8 text-sm text-ink-faint">Items with no station of their own print here. Making this the default takes it away from the current one.</p>
      </div>
      {station ? <Checkbox label="Station is in use" {...form.register('isActive')} /> : null}
    </FormModal>
  );
}

/** Where kitchen tickets are sent. Every outlet needs exactly one active default station. */
export function StationsSection() {
  const { can } = useAuth();
  const outlet = useOutlet();
  const manage = can('kitchen.manage');
  const [form, setForm] = useState<{ station: KitchenStation | null } | null>(null);
  const query = useQuery({ queryKey: ['kitchen', 'stations', outlet.id], queryFn: () => api<KitchenStation[]>('/kitchen/stations') });

  const columns: Array<Column<KitchenStation>> = [
    {
      key: 'name',
      header: 'Station',
      cell: (s) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{s.name}</span>
          {s.isDefault ? <Badge tone="brand">Default</Badge> : null}
        </span>
      ),
    },
    { key: 'key', header: 'Key', cell: (s) => <span className="font-mono text-xs">{s.key}</span> },
    { key: 'order', header: 'Position', align: 'right', cell: (s) => s.sortOrder, className: 'hidden sm:table-cell' },
    { key: 'status', header: 'Status', cell: (s) => <ActiveBadge active={s.isActive} /> },
  ];

  return (
    <SetupSection
      title="Kitchen stations"
      description="Each station gets its own kitchen tickets. Exactly one active station is the default: it receives items that are not routed anywhere else."
      readOnly={!manage}
      action={
        manage ? (
          <Button onClick={() => setForm({ station: null })}>
            <Plus className="h-4 w-4" aria-hidden /> Add station
          </Button>
        ) : undefined
      }
    >
      {query.isError && !query.data ? (
        <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      ) : !query.data ? (
        <SkeletonRows rows={3} />
      ) : (
        <DataTable columns={columns} rows={query.data} rowKey={(s) => s.id} onRowClick={manage ? (station) => setForm({ station }) : undefined} empty={<EmptyState title="No kitchen stations" description="Add a station so orders can be sent to the kitchen." />} />
      )}
      <StationModal open={form !== null} onClose={() => setForm(null)} station={form?.station ?? null} />
    </SetupSection>
  );
}
