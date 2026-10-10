import { modifierGroupSchema } from '@serveos/shared';
import { useMutation } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { Badge, Button, Card, Checkbox, DataTable, EmptyState, Field, Input, Modal, useToast, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money } from '@/lib/format';
import { ActiveBadge, FormSection, InlineError, Loadable, RowControls, Toolbar, TwoLine } from '../common';
import { errorAt, minorToText, payloadResolver, toInt, toMinor, validatePayload, type Report } from '../forms';
import { useInvalidateMenu, useModifierGroups } from '../queries';
import type { ModifierGroup } from '../types';

interface GroupForm {
  name: string;
  minSelect: string;
  maxSelect: string;
  isActive: boolean;
  options: Array<{ id?: string; name: string; priceMinor: string; isActive: boolean }>;
}

const toPayload = (values: GroupForm, report: Report) => ({
  name: values.name,
  minSelect: toInt(values.minSelect, 'minSelect', report) ?? 0,
  maxSelect: toInt(values.maxSelect, 'maxSelect', report) ?? 1,
  isActive: values.isActive,
  options: values.options.map((o, i) => ({
    ...(o.id ? { id: o.id } : {}),
    name: o.name,
    // An empty price means the option is free.
    priceMinor: toMinor(o.priceMinor, `options.${i}.priceMinor`, report, { optional: true }) ?? 0,
    isActive: o.isActive,
  })),
});

export const selectionRule = (g: Pick<ModifierGroup, 'minSelect' | 'maxSelect'>): string =>
  g.minSelect >= 1 ? (g.minSelect === g.maxSelect ? `Required, choose ${g.minSelect}` : `Required, choose ${g.minSelect} to ${g.maxSelect}`) : `Optional, up to ${g.maxSelect}`;

function GroupDialog({ group, onClose }: { group: ModifierGroup | null; onClose: () => void }) {
  const notify = useToast();
  const invalidate = useInvalidateMenu();
  const form = useForm<GroupForm>({
    resolver: payloadResolver(modifierGroupSchema, toPayload),
    defaultValues: group
      ? { name: group.name, minSelect: String(group.minSelect), maxSelect: String(group.maxSelect), isActive: group.isActive, options: group.options.map((o) => ({ id: o.id, name: o.name, priceMinor: minorToText(o.priceMinor), isActive: o.isActive })) }
      : { name: '', minSelect: '0', maxSelect: '1', isActive: true, options: [{ name: '', priceMinor: '', isActive: true }] },
  });
  const { errors } = form.formState;
  const options = useFieldArray({ control: form.control, name: 'options' });
  const watched = form.watch('options');
  const save = useMutation({
    mutationFn: (body: unknown) => (group ? api<ModifierGroup>(`/menu/modifier-groups/${group.id}`, { method: 'PUT', body }) : api<ModifierGroup>('/menu/modifier-groups', { method: 'POST', body })),
    onSuccess: (saved) => {
      invalidate();
      notify(`Modifier group ${saved.name} saved`);
      onClose();
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });
  const submit = form.handleSubmit((values) => {
    const result = validatePayload(modifierGroupSchema, toPayload, values);
    if (result.ok) save.mutate(result.data);
  });

  return (
    <Modal open onClose={onClose} title={group ? `Edit ${group.name}` : 'New modifier group'} description="A set of choices offered with a product, such as spice level or add-ons." size="lg">
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <FormSection title="Group">
          <Field label="Name" error={errors.name?.message}>
            {(p) => <Input {...p} autoComplete="off" autoFocus {...form.register('name')} />}
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Minimum selections" error={errors.minSelect?.message} hint="1 or more makes the group required.">
              {(p) => <Input {...p} inputMode="numeric" className="tabular" {...form.register('minSelect')} />}
            </Field>
            <Field label="Maximum selections" error={errors.maxSelect?.message}>
              {(p) => <Input {...p} inputMode="numeric" className="tabular" {...form.register('maxSelect')} />}
            </Field>
          </div>
          <Checkbox label="Active" {...form.register('isActive')} />
        </FormSection>
        <FormSection
          title="Options"
          description="Removing an option retires it; past orders keep it."
          action={
            <Button size="sm" onClick={() => options.append({ name: '', priceMinor: '', isActive: true })}>
              <Plus className="h-4 w-4" aria-hidden />
              Add option
            </Button>
          }
        >
          <InlineError message={errorAt(errors, 'options', 'root') ?? errorAt(errors, 'options')} />
          <ul className="flex flex-col gap-3">
            {options.fields.map((row, i) => (
              <li key={row.id} className="rounded-control border border-line bg-sunken/40 p-3">
                <div className="grid grid-cols-2 items-start gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]">
                  <Field label="Option name" error={errors.options?.[i]?.name?.message} className="col-span-2 sm:col-span-1">
                    {(p) => <Input {...p} autoComplete="off" {...form.register(`options.${i}.name`)} />}
                  </Field>
                  <Field label="Extra price (₹)" error={errors.options?.[i]?.priceMinor?.message}>
                    {(p) => <Input {...p} inputMode="decimal" autoComplete="off" className="tabular text-right" placeholder="0.00" {...form.register(`options.${i}.priceMinor`)} />}
                  </Field>
                  <div className="flex justify-end pt-7">
                    <RowControls index={i} count={options.fields.length} name={watched[i]?.name || `option ${i + 1}`} onMove={options.move} onRemove={() => options.remove(i)} />
                  </div>
                </div>
                <Checkbox label="Active" {...form.register(`options.${i}.isActive`)} />
              </li>
            ))}
          </ul>
        </FormSection>
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {group ? 'Save group' : 'Create group'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ModifierGroupsTab() {
  const { can } = useAuth();
  const canManage = can('menu.manage');
  const groups = useModifierGroups();
  const [editing, setEditing] = useState<ModifierGroup | 'new' | null>(null);

  const columns: Array<Column<ModifierGroup>> = [
    { key: 'name', header: 'Group', cell: (g) => <TwoLine primary={g.name} secondary={`Used by ${g._count?.products ?? 0} product${g._count?.products === 1 ? '' : 's'}`} /> },
    { key: 'rule', header: 'Selection', cell: (g) => <Badge tone={g.minSelect >= 1 ? 'warn' : 'neutral'}>{selectionRule(g)}</Badge> },
    {
      key: 'options',
      header: 'Options',
      cell: (g) => {
        const live = g.options.filter((o) => o.isActive);
        return (
          <span className="text-ink-soft">
            {live.slice(0, 4).map((o) => `${o.name}${o.priceMinor ? ` (+${money(o.priceMinor)})` : ''}`).join(', ')}
            {live.length > 4 ? ` and ${live.length - 4} more` : ''}
            {live.length === 0 ? 'No active options' : ''}
          </span>
        );
      },
    },
    { key: 'status', header: 'Status', cell: (g) => <ActiveBadge active={g.isActive} /> },
  ];

  return (
    <Card>
      {canManage ? (
        <Toolbar className="justify-end">
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden />
            New modifier group
          </Button>
        </Toolbar>
      ) : null}
      <Loadable query={groups}>
        {(data) => (
          <DataTable
            columns={columns}
            rows={data}
            rowKey={(g) => g.id}
            onRowClick={canManage ? setEditing : undefined}
            empty={<EmptyState title="No modifier groups yet" description="Use modifier groups for add-ons and choices, then attach them to products." action={canManage ? <Button variant="primary" onClick={() => setEditing('new')}>New modifier group</Button> : undefined} />}
          />
        )}
      </Loadable>
      {editing && canManage ? <GroupDialog group={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}
