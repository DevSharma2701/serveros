import { taxCategorySchema } from '@serveos/shared';
import { useMutation } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { Button, Card, Checkbox, DataTable, EmptyState, Field, Input, Modal, Notice, Select, useToast, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { percent } from '@/lib/format';
import { ActiveBadge, FormSection, InlineError, Loadable, RowControls, Toolbar, TwoLine } from '../common';
import { bpsToText, errorAt, payloadResolver, toBps, validatePayload, type Report } from '../forms';
import { useInvalidateMenu, useTaxCategories } from '../queries';
import type { TaxCategory, TaxComponent, TaxScope } from '../types';

const COMPONENTS: TaxComponent[] = ['CGST', 'SGST', 'IGST', 'CESS', 'VAT', 'OTHER'];
const SCOPES: Record<TaxScope, string> = { ANY: 'Every sale', INTRA_STATE: 'Sales within the state', INTER_STATE: 'Sales to another state' };
const SCOPE_SHORT: Record<TaxScope, string> = { ANY: '', INTRA_STATE: 'intra-state', INTER_STATE: 'inter-state' };

interface TaxForm {
  name: string;
  hsnSac: string;
  isActive: boolean;
  rules: Array<{ component: TaxComponent; name: string; rateBps: string; scope: TaxScope }>;
}

const toPayload = (values: TaxForm, report: Report) => ({
  name: values.name,
  hsnSac: values.hsnSac,
  isActive: values.isActive,
  rules: values.rules.map((r, i) => ({ component: r.component, name: r.name, rateBps: toBps(r.rateBps, `rules.${i}.rateBps`, report), scope: r.scope })),
});

export const TaxDisclaimer = () => (
  <Notice tone="warn" title="Rates are configuration, not tax advice">
    ServeOS applies the rates entered here exactly as configured. Confirm the correct rates, HSN/SAC codes and rules for your business with a tax professional.
  </Notice>
);

function TaxDialog({ category, onClose }: { category: TaxCategory | null; onClose: () => void }) {
  const notify = useToast();
  const invalidate = useInvalidateMenu();
  const form = useForm<TaxForm>({
    resolver: payloadResolver(taxCategorySchema, toPayload),
    defaultValues: category
      ? { name: category.name, hsnSac: category.hsnSac, isActive: category.isActive, rules: category.rules.map((r) => ({ component: r.component, name: r.name, rateBps: bpsToText(r.rateBps), scope: r.scope })) }
      : { name: '', hsnSac: '', isActive: true, rules: [{ component: 'CGST', name: '', rateBps: '', scope: 'INTRA_STATE' }] },
  });
  const { errors } = form.formState;
  const rules = useFieldArray({ control: form.control, name: 'rules' });
  const save = useMutation({
    mutationFn: (body: unknown) => (category ? api<TaxCategory>(`/tax-categories/${category.id}`, { method: 'PUT', body }) : api<TaxCategory>('/tax-categories', { method: 'POST', body })),
    onSuccess: (saved) => {
      invalidate();
      notify(`Tax category ${saved.name} saved`);
      onClose();
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });
  const submit = form.handleSubmit((values) => {
    const result = validatePayload(taxCategorySchema, toPayload, values);
    if (result.ok) save.mutate(result.data);
  });

  return (
    <Modal open onClose={onClose} title={category ? `Edit ${category.name}` : 'New tax category'} description="New rates apply to new orders. Bills already raised keep the tax they were charged." size="lg">
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <FormSection title="Category">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" error={errors.name?.message}>
              {(p) => <Input {...p} autoComplete="off" autoFocus placeholder="GST 5%" {...form.register('name')} />}
            </Field>
            <Field label="HSN / SAC code" error={errors.hsnSac?.message} hint="Printed on tax invoices. Optional.">
              {(p) => <Input {...p} autoComplete="off" className="tabular" {...form.register('hsnSac')} />}
            </Field>
          </div>
          <Checkbox label="Active" {...form.register('isActive')} />
        </FormSection>
        <FormSection
          title="Tax rules"
          description="Each rule is one line on the bill."
          action={
            <Button size="sm" onClick={() => rules.append({ component: 'OTHER', name: '', rateBps: '', scope: 'ANY' })}>
              <Plus className="h-4 w-4" aria-hidden />
              Add rule
            </Button>
          }
        >
          <InlineError message={errorAt(errors, 'rules', 'root') ?? errorAt(errors, 'rules')} />
          {rules.fields.length === 0 ? <p className="text-sm text-ink-faint">No rules: products in this category are not taxed.</p> : null}
          <ul className="flex flex-col gap-3">
            {rules.fields.map((row, i) => (
              <li key={row.id} className="grid grid-cols-2 items-start gap-3 rounded-control border border-line bg-sunken/40 p-3 sm:grid-cols-[7rem_minmax(0,1fr)_6rem]">
                <Field label="Component" error={errors.rules?.[i]?.component?.message}>
                  {(p) => (
                    <Select {...p} {...form.register(`rules.${i}.component`)}>
                      {COMPONENTS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Label on the bill" error={errors.rules?.[i]?.name?.message} className="order-first col-span-2 sm:order-none sm:col-span-1">
                  {(p) => <Input {...p} autoComplete="off" placeholder="CGST 2.5%" {...form.register(`rules.${i}.name`)} />}
                </Field>
                <Field label="Rate (%)" error={errors.rules?.[i]?.rateBps?.message}>
                  {(p) => <Input {...p} inputMode="decimal" autoComplete="off" className="tabular text-right" placeholder="2.5" {...form.register(`rules.${i}.rateBps`)} />}
                </Field>
                <Field label="Applies to" error={errors.rules?.[i]?.scope?.message} className="col-span-2 sm:col-span-2">
                  {(p) => (
                    <Select {...p} {...form.register(`rules.${i}.scope`)}>
                      {(Object.keys(SCOPES) as TaxScope[]).map((s) => (
                        <option key={s} value={s}>
                          {SCOPES[s]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <div className="col-span-2 flex justify-end sm:col-span-1 sm:pt-7">
                  <RowControls index={i} count={rules.fields.length} name={`rule ${i + 1}`} onRemove={() => rules.remove(i)} />
                </div>
              </li>
            ))}
          </ul>
        </FormSection>
        <TaxDisclaimer />
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {category ? 'Save tax category' : 'Create tax category'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function TaxCategoriesTab() {
  const { can } = useAuth();
  const canManage = can('restaurant.manage');
  const taxes = useTaxCategories();
  const [editing, setEditing] = useState<TaxCategory | 'new' | null>(null);

  const columns: Array<Column<TaxCategory>> = [
    { key: 'name', header: 'Tax category', cell: (t) => <TwoLine primary={t.name} secondary={t.hsnSac ? `HSN/SAC ${t.hsnSac}` : undefined} /> },
    {
      key: 'rules',
      header: 'Rules',
      cell: (t) =>
        t.rules.length === 0 ? (
          <span className="text-ink-faint">No tax</span>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {t.rules.map((r) => (
              <li key={r.id} className="whitespace-nowrap">
                <span className="font-medium">{r.component}</span> <span className="tabular">{percent(r.rateBps)}</span>
                {SCOPE_SHORT[r.scope] ? <span className="text-ink-faint"> · {SCOPE_SHORT[r.scope]}</span> : null}
                {r.name ? <span className="text-ink-faint"> · “{r.name}”</span> : null}
              </li>
            ))}
          </ul>
        ),
    },
    { key: 'status', header: 'Status', cell: (t) => <ActiveBadge active={t.isActive} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <TaxDisclaimer />
      <Card>
        {canManage ? (
          <Toolbar className="justify-end">
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus className="h-4 w-4" aria-hidden />
              New tax category
            </Button>
          </Toolbar>
        ) : null}
        <Loadable query={taxes}>
          {(data) => (
            <DataTable
              columns={columns}
              rows={data}
              rowKey={(t) => t.id}
              onRowClick={canManage ? setEditing : undefined}
              empty={<EmptyState title="No tax categories yet" description="Create a tax category, then choose it on each product." action={canManage ? <Button variant="primary" onClick={() => setEditing('new')}>New tax category</Button> : undefined} />}
            />
          )}
        </Loadable>
        {!canManage && taxes.data?.length ? <p className="border-t border-line px-4 py-2 text-xs text-ink-faint">Only people who manage the restaurant settings can change tax categories.</p> : null}
      </Card>
      {editing && canManage ? <TaxDialog category={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
