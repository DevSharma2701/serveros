import { ingredientSchema, updateIngredientSchema } from '@serveos/shared';
import { useMutation } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button, Card, Checkbox, DataTable, EmptyState, Field, Input, Modal, SearchInput, Select, useToast, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ActiveBadge, Loadable, Toolbar, TwoLine } from '../../catalogue/common';
import { payloadResolver, validatePayload } from '../../catalogue/forms';
import { useIngredients, useInvalidateStock, useSuppliers, useUnits } from '../queries';
import { qty } from '../quantity';
import type { Ingredient, Supplier, Unit } from '../types';

interface IngredientForm {
  name: string;
  sku: string;
  baseUnitId: string;
  lowStockThreshold: string;
  supplierId: string;
  isActive: boolean;
}

const DIMENSION_LABEL = { MASS: 'Weight', VOLUME: 'Volume', COUNT: 'Count' } as const;

const toPayload = (values: IngredientForm) => ({ ...values, lowStockThreshold: values.lowStockThreshold.trim() || '0', supplierId: values.supplierId || null });
const toPatch = (values: IngredientForm) => {
  // The base unit is fixed after creation: stock and recipes are stored in it.
  const { baseUnitId: _baseUnitId, ...rest } = toPayload(values);
  return rest;
};

/** Average cost shown per base unit, in rupees. Small numbers need more than two decimals. */
function averageCost(costPerBaseMinor: string, unit: string): string {
  const rupees = Number(costPerBaseMinor) / 100;
  if (!rupees) return '—';
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: rupees < 1 ? 4 : 2 })} / ${unit}`;
}

function IngredientDialog({ ingredient, units, suppliers, onClose }: { ingredient: Ingredient | null; units: Unit[]; suppliers: Supplier[]; onClose: () => void }) {
  const notify = useToast();
  const invalidate = useInvalidateStock();
  const schema = ingredient ? updateIngredientSchema : ingredientSchema;
  const convert = ingredient ? toPatch : toPayload;
  const form = useForm<IngredientForm>({
    resolver: payloadResolver(schema, convert),
    defaultValues: ingredient
      ? { name: ingredient.name, sku: ingredient.sku, baseUnitId: ingredient.baseUnitId, lowStockThreshold: qty(ingredient.lowStockThreshold), supplierId: ingredient.supplierId ?? '', isActive: ingredient.isActive }
      : { name: '', sku: '', baseUnitId: '', lowStockThreshold: '', supplierId: '', isActive: true },
  });
  const { errors } = form.formState;
  const baseUnit = units.find((u) => u.id === form.watch('baseUnitId'));
  const save = useMutation({
    mutationFn: (body: unknown) => (ingredient ? api<Ingredient>(`/ingredients/${ingredient.id}`, { method: 'PATCH', body }) : api<Ingredient>('/ingredients', { method: 'POST', body })),
    onSuccess: (saved) => {
      invalidate();
      notify(`Ingredient ${saved.name} saved`);
      onClose();
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });
  const submit = form.handleSubmit((values) => {
    const result = validatePayload(schema, convert, values);
    if (result.ok) save.mutate(result.data);
  });

  return (
    <Modal open onClose={onClose} title={ingredient ? `Edit ${ingredient.name}` : 'New ingredient'} description="Ingredients are shared by all outlets; each outlet has its own stock.">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={errors.name?.message}>
            {(p) => <Input {...p} autoComplete="off" autoFocus {...form.register('name')} />}
          </Field>
          <Field label="SKU" error={errors.sku?.message}>
            {(p) => <Input {...p} autoComplete="off" {...form.register('sku')} />}
          </Field>
          <Field label="Base unit" error={errors.baseUnitId?.message} hint={ingredient ? 'Fixed after creation: stock and recipes are kept in it.' : 'Stock is kept in this unit. It cannot be changed later.'}>
            {(p) => (
              <Select {...p} disabled={!!ingredient} {...form.register('baseUnitId')}>
                <option value="">Choose a unit</option>
                {(Object.keys(DIMENSION_LABEL) as Array<keyof typeof DIMENSION_LABEL>).map((dimension) => (
                  <optgroup key={dimension} label={DIMENSION_LABEL[dimension]}>
                    {units
                      .filter((u) => u.dimension === dimension)
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name} ({u.code})
                        </option>
                      ))}
                  </optgroup>
                ))}
              </Select>
            )}
          </Field>
          <Field label={`Low-stock level${baseUnit ? ` (${baseUnit.code})` : ''}`} error={errors.lowStockThreshold?.message} hint="Flagged as low at or below this. Empty or 0 turns the flag off.">
            {(p) => <Input {...p} inputMode="decimal" autoComplete="off" className="tabular text-right" {...form.register('lowStockThreshold')} />}
          </Field>
          <Field label="Usual supplier" error={errors.supplierId?.message} hint="Optional." className="sm:col-span-2">
            {(p) => (
              <Select {...p} {...form.register('supplierId')}>
                <option value="">None</option>
                {suppliers
                  .filter((s) => s.isActive || s.id === ingredient?.supplierId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        </div>
        <Checkbox label="Active (listed in stock, recipes and purchasing)" {...form.register('isActive')} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {ingredient ? 'Save ingredient' : 'Create ingredient'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function IngredientsTab() {
  const { can } = useAuth();
  const canManage = can('inventory.manage');
  const ingredients = useIngredients();
  const units = useUnits();
  const suppliers = useSuppliers();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Ingredient | 'new' | null>(null);
  const unitCode = (id: string) => units.data?.find((u) => u.id === id)?.code ?? '';
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (ingredients.data ?? []).filter((i) => !needle || i.name.toLowerCase().includes(needle) || i.sku.toLowerCase().includes(needle));
  }, [ingredients.data, search]);

  const columns: Array<Column<Ingredient>> = [
    { key: 'name', header: 'Ingredient', cell: (i) => <TwoLine primary={i.name} secondary={i.sku} /> },
    { key: 'unit', header: 'Base unit', cell: (i) => unitCode(i.baseUnitId) },
    { key: 'threshold', header: 'Low-stock level', align: 'right', cell: (i) => (Number(i.lowStockThreshold) > 0 ? `${qty(i.lowStockThreshold)} ${unitCode(i.baseUnitId)}` : <span className="text-ink-faint">Not set</span>) },
    { key: 'cost', header: 'Average cost', align: 'right', cell: (i) => averageCost(i.costPerBaseMinor, unitCode(i.baseUnitId)) },
    { key: 'supplier', header: 'Supplier', cell: (i) => i.supplier?.name ?? <span className="text-ink-faint">—</span> },
    { key: 'status', header: 'Status', cell: (i) => <ActiveBadge active={i.isActive} /> },
  ];

  return (
    <Card>
      <Toolbar>
        <SearchInput className="min-w-0 flex-1 basis-56" aria-label="Search ingredients" placeholder="Search by name or SKU" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} />
        {canManage ? (
          <Button variant="primary" className="ml-auto" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden />
            New ingredient
          </Button>
        ) : null}
      </Toolbar>
      <Loadable query={ingredients} rows={8}>
        {(data) => (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(i) => i.id}
            onRowClick={canManage ? setEditing : undefined}
            empty={data.length ? <EmptyState title="No ingredients match" /> : <EmptyState title="No ingredients yet" description="Ingredients are what you buy and stock: flour, paneer, cooking oil." action={canManage ? <Button variant="primary" onClick={() => setEditing('new')}>New ingredient</Button> : undefined} />}
          />
        )}
      </Loadable>
      {editing && canManage ? <IngredientDialog ingredient={editing === 'new' ? null : editing} units={units.data ?? []} suppliers={suppliers.data ?? []} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}
