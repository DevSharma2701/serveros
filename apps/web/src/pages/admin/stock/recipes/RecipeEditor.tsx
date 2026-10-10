import { recipeSchema } from '@serveos/shared';
import { useMutation } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { Badge, Button, Card, EmptyState, Field, Input, Notice, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useOutlet } from '@/lib/auth';
import { dateTime, money } from '@/lib/format';
import { payloadResolver, validatePayload } from '../../catalogue/forms';
import type { ProductDetail } from '../../catalogue/types';
import { emptyLine, LinesEditor, type Line } from '../LinesEditor';
import { useInvalidateStock, type StockLookups } from '../queries';
import { qty } from '../quantity';
import type { Recipe } from '../types';

interface RecipeForm {
  note: string;
  ingredients: Line[];
}

const linesOf = (recipe: Recipe | undefined): Line[] => (recipe ? recipe.ingredients.map((l) => ({ ingredientId: l.ingredientId, quantity: qty(l.quantity), unitId: l.unitId })) : [emptyLine()]);

/** Cost as a share of the selling price, e.g. "31.4%". Display only. */
export function foodCostPercent(costMinor: number, priceMinor: number): string {
  return priceMinor > 0 ? `${((costMinor / priceMinor) * 100).toFixed(1)}%` : '—';
}

function CostSummary({ recipe, product, variantId, versions }: { recipe: Recipe | undefined; product: ProductDetail; variantId: string | null; versions: Recipe[] }) {
  if (!recipe) return <Notice tone="info">No recipe saved yet for this choice, so selling it does not use any stock.</Notice>;
  // A product-level recipe applies to every variant that has no recipe of its own.
  const ownRecipe = new Set(versions.filter((r) => r.isActive && r.variantId).map((r) => r.variantId));
  const priced = product.variants.filter((v) => v.isActive && (variantId ? v.id === variantId : !ownRecipe.has(v.id)));
  return (
    <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
      <div className="rounded-control border border-line bg-sunken/50 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Recipe cost (version {recipe.version})</p>
        <p className="tabular mt-1 text-xl font-bold text-ink">{money(recipe.costMinor)}</p>
        <p className="text-xs text-ink-faint">At today’s average ingredient cost</p>
      </div>
      <div className="rounded-control border border-line px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Food cost against menu price</p>
        {priced.length === 0 ? (
          <p className="mt-1 text-sm text-ink-soft">Every active variant has its own recipe, so this one is not used.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {priced.map((v) => (
              <li key={v.id} className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
                <span className="text-ink-soft">
                  {v.name} <span className="tabular text-ink">{money(v.priceMinor)}</span>
                </span>
                <span className="tabular text-base font-bold text-ink">{foodCostPercent(recipe.costMinor, v.priceMinor)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Editor for the recipe of one product (or one of its variants). Saving never edits the current
 * recipe: it creates a new version and the older ones stay as history.
 */
export function RecipeEditor({ product, variantId, versions, lookups, canManage }: { product: ProductDetail; variantId: string | null; versions: Recipe[]; lookups: StockLookups; canManage: boolean }) {
  const notify = useToast();
  const outlet = useOutlet();
  const invalidate = useInvalidateStock();
  const scoped = versions.filter((r) => r.variantId === variantId).sort((a, b) => b.version - a.version);
  const active = scoped.find((r) => r.isActive);
  const toPayload = (values: RecipeForm) => ({ productId: product.id, variantId, note: values.note, ingredients: values.ingredients });
  const form = useForm<RecipeForm>({ resolver: payloadResolver(recipeSchema, toPayload), defaultValues: { note: '', ingredients: linesOf(active) } });
  const { errors } = form.formState;
  const save = useMutation({
    mutationFn: (body: unknown) => api<{ version: number }>('/recipes', { method: 'PUT', body }),
    onSuccess: (saved) => {
      invalidate();
      form.setValue('note', '');
      notify(`Recipe saved as version ${saved.version}`);
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });
  const submit = form.handleSubmit((values) => {
    const result = validatePayload(recipeSchema, toPayload, values);
    if (result.ok) save.mutate(result.data);
  });

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 p-4">
        <CostSummary recipe={active} product={product} variantId={variantId} versions={versions} />
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-bold text-ink">Ingredients for one portion</h2>
            <p className="text-sm text-ink-soft">This is what one sale takes out of stock.</p>
          </div>
          <fieldset disabled={!canManage} className="contents">
            <Controller control={form.control} name="ingredients" render={({ field }) => <LinesEditor value={field.value} onChange={field.onChange} errors={errors.ingredients} lookups={lookups} addLabel="Add ingredient" />} />
            <Field label="Note for this version" error={errors.note?.message} hint="Optional, for example “smaller paneer portion”.">
              {(p) => <Input {...p} autoComplete="off" {...form.register('note')} />}
            </Field>
          </fieldset>
          {canManage ? (
            <div className="flex flex-wrap items-center justify-end gap-3">
              <p className="text-sm text-ink-faint">Saving creates version {(scoped[0]?.version ?? 0) + 1}. The cost is recalculated when you save.</p>
              <Button type="submit" variant="primary" loading={save.isPending}>
                Save as new version
              </Button>
            </div>
          ) : (
            <p className="text-sm text-ink-faint">You can view recipes. Changing them needs the “manage recipes” permission.</p>
          )}
        </form>
      </Card>

      <Card>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <History className="h-4 w-4 text-ink-faint" aria-hidden />
          <h2 className="text-sm font-bold text-ink">Version history</h2>
        </div>
        {scoped.length === 0 ? (
          <EmptyState title="No versions yet" description="Each save adds a version here. Older versions are kept so past stock usage can be explained." />
        ) : (
          <ul className="divide-y divide-line">
            {scoped.map((r) => (
              <li key={r.id}>
                <details className="group px-4 py-3">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="font-semibold text-ink">Version {r.version}</span>
                    <Badge tone={r.isActive ? 'ok' : 'neutral'}>{r.isActive ? 'In use' : 'Replaced'}</Badge>
                    <span className="text-ink-soft">{dateTime(r.createdAt, outlet.timezone)}</span>
                    {r.note ? <span className="text-ink-soft">· {r.note}</span> : null}
                    <span className="tabular ml-auto font-medium text-ink">{money(r.costMinor)}</span>
                  </summary>
                  <ul className="mt-2 flex flex-col gap-1 text-sm text-ink-soft">
                    {r.ingredients.map((l) => (
                      <li key={l.id} className="flex justify-between gap-4">
                        <span>{l.ingredientName}</span>
                        <span className="tabular whitespace-nowrap">
                          {qty(l.quantity)} {lookups.unitCode(l.unitId)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {canManage && !r.isActive ? (
                    <Button size="sm" className="mt-3" onClick={() => form.reset({ note: `Based on version ${r.version}`, ingredients: linesOf(r) })}>
                      Load into editor
                    </Button>
                  ) : null}
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
