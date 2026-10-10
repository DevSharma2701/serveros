import { productSchema } from '@serveos/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { Button, Checkbox, Field, Input, Notice, Select, Textarea, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { FormSection, InlineError, RowControls } from '../common';
import { errorAt, payloadResolver, validatePayload } from '../forms';
import type { Category, ModifierGroup, Product, Station, TaxCategory } from '../types';
import { ImageUpload } from './ImageUpload';
import { emptyVariant, productDefaults, productPayload, type ProductFormValues } from './productValues';

export interface ProductLookups {
  categories: Category[];
  taxCategories: TaxCategory[];
  modifierGroups: ModifierGroup[];
  /** Kitchen stations of the current outlet; null when they could not be loaded. */
  stations: Station[] | null;
}

/** Create or edit a product. Saves through the API itself and reports the saved product. */
export function ProductForm({ product, lookups, onSaved, onCancel }: { product?: Product; lookups: ProductLookups; onSaved: (saved: Product) => void; onCancel: () => void }) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const form = useForm<ProductFormValues>({ resolver: payloadResolver(productSchema, productPayload), defaultValues: productDefaults(product) });
  const { errors } = form.formState;
  const variants = useFieldArray({ control: form.control, name: 'variants' });
  const watched = form.watch('variants');

  const save = useMutation({
    mutationFn: (body: unknown) => (product ? api<Product>(`/menu/products/${product.id}`, { method: 'PATCH', body }) : api<Product>('/menu/products', { method: 'POST', body })),
    onSuccess: (saved) => {
      for (const key of ['products', 'product', 'categories', 'modifier-groups', 'catalog']) void queryClient.invalidateQueries({ queryKey: [key] });
      notify(product ? `${saved.name} saved` : `${saved.name} added to the menu`);
      onSaved(saved);
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });

  const submit = form.handleSubmit((values) => {
    const result = validatePayload(productSchema, productPayload, values);
    if (result.ok) save.mutate(result.data);
  });

  const makeDefault = (index: number) => watched.forEach((_, i) => form.setValue(`variants.${i}.isDefault`, i === index, { shouldDirty: true }));

  const categoryOptions = lookups.categories.filter((c) => c.isActive || c.id === product?.categoryId);
  const parents = categoryOptions.filter((c) => !c.parentId);
  const stationKey = form.watch('stationKey');
  const unknownStation = stationKey && lookups.stations && !lookups.stations.some((s) => s.key === stationKey);

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5" aria-label={product ? 'Edit product' : 'New product'}>
      <FormSection title="Details">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={errors.name?.message}>
            {(p) => <Input {...p} autoComplete="off" {...form.register('name')} />}
          </Field>
          <Field label="SKU" error={errors.sku?.message} hint="A short code that is unique on your menu.">
            {(p) => <Input {...p} autoComplete="off" {...form.register('sku')} />}
          </Field>
          <Field label="Category" error={errors.categoryId?.message}>
            {(p) => (
              <Select {...p} {...form.register('categoryId')}>
                <option value="">Choose a category</option>
                {parents.map((parent) => [
                  <option key={parent.id} value={parent.id}>
                    {parent.name}
                  </option>,
                  ...categoryOptions
                    .filter((c) => c.parentId === parent.id)
                    .map((child) => (
                      <option key={child.id} value={child.id}>
                        {parent.name} › {child.name}
                      </option>
                    )),
                ])}
                {/* Children whose parent is hidden (inactive) still need to be selectable. */}
                {categoryOptions
                  .filter((c) => c.parentId && !parents.some((parent) => parent.id === c.parentId))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label="Food type" error={errors.veg?.message}>
            {(p) => (
              <Select {...p} {...form.register('veg')}>
                <option value="unspecified">Not specified</option>
                <option value="veg">Vegetarian</option>
                <option value="nonveg">Non-vegetarian</option>
              </Select>
            )}
          </Field>
          <Field label="Tax category" error={errors.taxCategoryId?.message} hint="Without one, no tax is charged on this product.">
            {(p) => (
              <Select {...p} {...form.register('taxCategoryId')}>
                <option value="">No tax</option>
                {lookups.taxCategories
                  .filter((t) => t.isActive || t.id === product?.taxCategoryId)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          {lookups.stations ? (
            <Field label="Kitchen station" error={errors.stationKey?.message} hint="Where tickets for this product are sent in this outlet.">
              {(p) => (
                <Select {...p} {...form.register('stationKey')}>
                  <option value="">Default station</option>
                  {lookups.stations!
                    .filter((s) => s.isActive || s.key === stationKey)
                    .map((s) => (
                      <option key={s.id} value={s.key}>
                        {s.name} ({s.key})
                      </option>
                    ))}
                  {unknownStation ? <option value={stationKey}>{stationKey} (not a station of this outlet)</option> : null}
                </Select>
              )}
            </Field>
          ) : (
            <Field label="Kitchen station key" error={errors.stationKey?.message} hint="The station list is not available to you; type the station key, or leave empty for the default station.">
              {(p) => <Input {...p} autoComplete="off" {...form.register('stationKey')} />}
            </Field>
          )}
        </div>
        <Field label="Description" error={errors.description?.message}>
          {(p) => <Textarea {...p} rows={2} {...form.register('description')} />}
        </Field>
        <Controller control={form.control} name="imageUrl" render={({ field }) => <ImageUpload value={field.value} onChange={field.onChange} />} />
        <div className="flex flex-wrap gap-x-6">
          <Checkbox label="Active (shown on the POS)" {...form.register('isActive')} />
          <Checkbox label="Favourite (pinned on the POS)" {...form.register('isFavorite')} />
        </div>
      </FormSection>

      <FormSection
        title="Variants and prices"
        description="Portion sizes such as Half / Full. Removing a variant retires it; past orders keep it."
        action={
          <Button size="sm" onClick={() => variants.append(emptyVariant(watched.length === 0))}>
            <Plus className="h-4 w-4" aria-hidden />
            Add variant
          </Button>
        }
      >
        <InlineError message={errorAt(errors, 'variants', 'root') ?? errorAt(errors, 'variants')} />
        <ul className="flex flex-col gap-3">
          {variants.fields.map((row, i) => {
            const label = watched[i]?.name || `variant ${i + 1}`;
            return (
              <li key={row.id} className="rounded-control border border-line bg-sunken/40 p-3">
                <div className="grid grid-cols-2 items-start gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]">
                  <Field label="Variant name" error={errors.variants?.[i]?.name?.message} className="col-span-2 sm:col-span-1">
                    {(p) => <Input {...p} autoComplete="off" placeholder="Regular" {...form.register(`variants.${i}.name`)} />}
                  </Field>
                  <Field label="Price (₹)" error={errors.variants?.[i]?.priceMinor?.message}>
                    {(p) => <Input {...p} inputMode="decimal" autoComplete="off" className="tabular text-right" placeholder="0.00" {...form.register(`variants.${i}.priceMinor`)} />}
                  </Field>
                  <div className="flex justify-end pt-7">
                    <RowControls index={i} count={variants.fields.length} name={label} onMove={variants.move} onRemove={() => variants.remove(i)} />
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-6">
                  <label className="flex min-h-11 items-center gap-3 text-sm text-ink">
                    <input type="radio" name="default-variant" className="h-5 w-5 accent-[var(--color-brand)]" checked={!!watched[i]?.isDefault} onChange={() => makeDefault(i)} />
                    <span>Default choice</span>
                  </label>
                  <Checkbox label="Active" {...form.register(`variants.${i}.isActive`)} />
                </div>
              </li>
            );
          })}
        </ul>
      </FormSection>

      <FormSection title="Modifier groups" description="Add-ons and choices offered with this product.">
        {lookups.modifierGroups.length === 0 ? (
          <p className="text-sm text-ink-faint">No modifier groups yet. Create them on the Modifier groups tab.</p>
        ) : (
          <Controller
            control={form.control}
            name="modifierGroupIds"
            render={({ field }) => (
              <div className="grid gap-x-6 sm:grid-cols-2">
                {lookups.modifierGroups
                  .filter((g) => g.isActive || field.value.includes(g.id))
                  .map((g) => (
                    <Checkbox
                      key={g.id}
                      label={
                        <>
                          {g.name} <span className="text-ink-faint">({g.minSelect >= 1 ? 'required' : 'optional'}{g.isActive ? '' : ', inactive'})</span>
                        </>
                      }
                      checked={field.value.includes(g.id)}
                      onChange={(e) => field.onChange(e.target.checked ? [...field.value, g.id] : field.value.filter((id) => id !== g.id))}
                    />
                  ))}
              </div>
            )}
          />
        )}
        <InlineError message={errorAt(errors, 'modifierGroupIds', 'root')} />
      </FormSection>

      {form.formState.isSubmitted && Object.keys(errors).length > 0 ? <Notice tone="bad">Some fields need attention. Check the messages above.</Notice> : null}

      <div className="sticky -bottom-4 -mx-5 -mb-4 rounded-b-card flex flex-wrap justify-end gap-2 border-t border-line bg-surface px-5 py-3">
        <Button onClick={onCancel} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {product ? 'Save product' : 'Create product'}
        </Button>
      </div>
    </form>
  );
}
