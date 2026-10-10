import { zodResolver } from '@hookform/resolvers/zod';
import { diningAreaSchema, tableSchema } from '@serveos/shared';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button, Checkbox, DataTable, EmptyState, ErrorState, Field, Input, Select, SkeletonRows, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth, useOutlet } from '@/lib/auth';
import { titleCase } from '@/lib/format';
import type { FloorArea, FloorTable } from '@/lib/types';
import { ActiveBadge, FormModal, SetupSection, useSave } from './components/SetupSection';

type AreaInput = z.input<typeof diningAreaSchema>;
type AreaOutput = z.output<typeof diningAreaSchema>;
// Position and assigned waiter are managed on the floor plan, so this form leaves them alone.
const tableFormSchema = tableSchema.pick({ name: true, areaId: true, capacity: true, shape: true, isActive: true });
type TableInput = z.input<typeof tableFormSchema>;
type TableOutput = z.output<typeof tableFormSchema>;

function AreaModal({ open, onClose, area }: { open: boolean; onClose: () => void; area: FloorArea | null }) {
  const defaults: AreaInput = { name: area?.name ?? '', sortOrder: area?.sortOrder ?? 0, isActive: area?.isActive ?? true };
  const form = useForm<AreaInput, unknown, AreaOutput>({ resolver: zodResolver(diningAreaSchema), defaultValues: defaults });
  const { errors } = form.formState;
  const { reset } = form;
  useEffect(() => {
    if (open) reset({ name: area?.name ?? '', sortOrder: area?.sortOrder ?? 0, isActive: area?.isActive ?? true });
  }, [open, area, reset]);
  const save = useSave((body: AreaOutput) => (area ? api<FloorArea>(`/dining-areas/${area.id}`, { method: 'PATCH', body }) : api<FloorArea>('/dining-areas', { method: 'POST', body })), {
    invalidate: ['floor'],
    success: (saved) => `${saved.name} ${area ? 'updated' : 'added'}`,
    onDone: onClose,
  });
  return (
    <FormModal open={open} onClose={onClose} title={area ? `Edit ${area.name}` : 'Add a dining area'} submitLabel={area ? 'Save changes' : 'Add area'} pending={save.isPending} error={save.error} onSubmit={form.handleSubmit((v) => save.mutate(v))}>
      <Field label="Area name" error={errors.name ? 'Enter a name (up to 120 characters)' : undefined} hint="For example Main hall, Terrace, Bar.">
        {(p) => <Input {...p} autoFocus {...form.register('name')} />}
      </Field>
      <Field label="Position in the list" error={errors.sortOrder ? 'Enter a whole number, 0 or more' : undefined} hint="Lower numbers are shown first.">
        {(p) => <Input {...p} type="number" min={0} step={1} inputMode="numeric" className="max-w-32" {...form.register('sortOrder', { valueAsNumber: true })} />}
      </Field>
      {area ? <Checkbox label="Area is in use" {...form.register('isActive')} /> : null}
    </FormModal>
  );
}

function TableModal({ open, onClose, table, areaId, areas }: { open: boolean; onClose: () => void; table: FloorTable | null; /** Area to start in when adding. */ areaId: string; areas: FloorArea[] }) {
  const form = useForm<TableInput, unknown, TableOutput>({ resolver: zodResolver(tableFormSchema), defaultValues: { name: '', areaId, capacity: 4, shape: 'square', isActive: true } });
  const { errors } = form.formState;
  const { reset } = form;
  useEffect(() => {
    if (open) reset({ name: table?.name ?? '', areaId: table?.areaId ?? areaId, capacity: table?.capacity ?? 4, shape: (table?.shape as TableInput['shape']) ?? 'square', isActive: table?.isActive ?? true });
  }, [open, table, areaId, reset]);
  const save = useSave((body: TableOutput) => (table ? api<FloorTable>(`/tables/${table.id}`, { method: 'PATCH', body }) : api<FloorTable>('/tables', { method: 'POST', body })), {
    invalidate: ['floor'],
    success: (saved) => `Table ${saved.name} ${table ? 'updated' : 'added'}`,
    onDone: onClose,
  });
  return (
    <FormModal open={open} onClose={onClose} title={table ? `Edit table ${table.name}` : 'Add a table'} submitLabel={table ? 'Save changes' : 'Add table'} pending={save.isPending} error={save.error} onSubmit={form.handleSubmit((v) => save.mutate(v))}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Table name" error={errors.name ? 'Enter a name of up to 20 characters' : undefined} hint="Shown on the floor plan and on bills, e.g. T12.">
          {(p) => <Input {...p} autoFocus maxLength={20} {...form.register('name')} />}
        </Field>
        <Field label="Dining area" error={errors.areaId ? 'Choose an area' : undefined}>
          {(p) => (
            <Select {...p} {...form.register('areaId')}>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Seats" error={errors.capacity ? 'Enter a number of seats from 1 to 100' : undefined}>
          {(p) => <Input {...p} type="number" min={1} max={100} step={1} inputMode="numeric" {...form.register('capacity', { valueAsNumber: true })} />}
        </Field>
        <Field label="Shape" error={errors.shape?.message} hint="How the table is drawn on the floor plan.">
          {(p) => (
            <Select {...p} {...form.register('shape')}>
              <option value="square">Square</option>
              <option value="round">Round</option>
              <option value="rect">Rectangle</option>
            </Select>
          )}
        </Field>
      </div>
      {table ? <Checkbox label="Table is in use" {...form.register('isActive')} /> : null}
    </FormModal>
  );
}

/** Dining areas and their tables for the current outlet. */
export function FloorSection() {
  const { can } = useAuth();
  const outlet = useOutlet();
  const manage = can('table.manage');
  const [areaForm, setAreaForm] = useState<{ area: FloorArea | null } | null>(null);
  const [tableForm, setTableForm] = useState<{ table: FloorTable | null; areaId: string } | null>(null);
  const query = useQuery({ queryKey: ['floor', 'setup', outlet.id], queryFn: () => api<FloorArea[]>('/floor') });
  const areas = query.data ?? [];

  const columns: Array<Column<FloorTable>> = [
    { key: 'name', header: 'Table', cell: (t) => <span className="font-medium">{t.name}</span> },
    { key: 'seats', header: 'Seats', align: 'right', cell: (t) => t.capacity },
    { key: 'shape', header: 'Shape', cell: (t) => titleCase(t.shape === 'rect' ? 'rectangle' : t.shape), className: 'hidden sm:table-cell' },
    { key: 'waiter', header: 'Assigned waiter', cell: (t) => t.assignedWaiterName ?? '', className: 'hidden md:table-cell' },
    { key: 'status', header: 'Status', cell: (t) => <ActiveBadge active={t.isActive} /> },
  ];

  return (
    <SetupSection
      title="Dining areas and tables"
      description="The rooms of this outlet and the tables in each. Tables that are not in use are hidden from the floor plan."
      readOnly={!manage}
      action={
        manage ? (
          <Button onClick={() => setAreaForm({ area: null })}>
            <Plus className="h-4 w-4" aria-hidden /> Add area
          </Button>
        ) : undefined
      }
    >
      {query.isError && !query.data ? (
        <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      ) : !query.data ? (
        <SkeletonRows />
      ) : areas.length === 0 ? (
        <EmptyState title="No dining areas yet" description="Add an area, then add its tables." />
      ) : (
        <div className="divide-y divide-line">
          {areas.map((area) => (
            <div key={area.id}>
              <div className="flex flex-wrap items-center justify-between gap-2 bg-sunken/40 px-4 py-2.5">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-ink">{area.name}</h3>
                  {!area.isActive ? <ActiveBadge active={false} /> : null}
                  <span className="text-sm text-ink-soft">
                    {area.tables.length} table{area.tables.length === 1 ? '' : 's'} · {area.tables.reduce((sum, t) => sum + (t.isActive ? t.capacity : 0), 0)} seats in use
                  </span>
                </div>
                {manage ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setAreaForm({ area })} aria-label={`Edit area ${area.name}`}>
                      <Pencil className="h-4 w-4" aria-hidden /> Edit area
                    </Button>
                    <Button size="sm" onClick={() => setTableForm({ table: null, areaId: area.id })} aria-label={`Add a table to ${area.name}`}>
                      <Plus className="h-4 w-4" aria-hidden /> Add table
                    </Button>
                  </div>
                ) : null}
              </div>
              <DataTable
                columns={columns}
                rows={area.tables}
                rowKey={(t) => t.id}
                onRowClick={manage ? (table) => setTableForm({ table, areaId: table.areaId }) : undefined}
                empty={<p className="px-4 py-4 text-sm text-ink-soft">No tables in this area yet.</p>}
              />
            </div>
          ))}
        </div>
      )}
      <AreaModal open={areaForm !== null} onClose={() => setAreaForm(null)} area={areaForm?.area ?? null} />
      <TableModal open={tableForm !== null} onClose={() => setTableForm(null)} table={tableForm?.table ?? null} areaId={tableForm?.areaId ?? areas[0]?.id ?? ''} areas={areas} />
    </SetupSection>
  );
}
