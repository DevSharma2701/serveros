import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, Card, DataTable, EmptyState, ErrorState, Field, PageHeader, SearchInput, Select, SkeletonRows, type Column } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money } from '@/lib/format';
import { Loadable, TwoLine } from '../catalogue/common';
import { useDebounced, useProduct, useProducts } from '../catalogue/queries';
import { useRecipes, useStockLookups } from './queries';
import { foodCostPercent, RecipeEditor } from './recipes/RecipeEditor';
import type { Recipe } from './types';

function ActiveRecipes({ onOpen }: { onOpen: (recipe: Recipe) => void }) {
  const recipes = useRecipes();
  const columns: Array<Column<Recipe>> = [
    { key: 'product', header: 'Product', cell: (r) => <TwoLine primary={r.product.name} secondary={r.variant ? r.variant.name : 'All variants'} /> },
    { key: 'version', header: 'Version', align: 'right', cell: (r) => r.version },
    { key: 'lines', header: 'Ingredients', align: 'right', cell: (r) => r.ingredients.length },
    { key: 'cost', header: 'Recipe cost', align: 'right', cell: (r) => money(r.costMinor) },
    { key: 'price', header: 'Menu price', align: 'right', cell: (r) => (r.variant ? money(r.variant.priceMinor) : <span className="text-ink-faint">Per variant</span>) },
    { key: 'pct', header: 'Food cost', align: 'right', cell: (r) => (r.variant ? <span className="font-semibold">{foodCostPercent(r.costMinor, r.variant.priceMinor)}</span> : <span className="text-ink-faint">Open to see</span>) },
  ];
  return (
    <Card>
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-bold text-ink">Recipes in use</h2>
        <p className="text-sm text-ink-soft">Costs use today’s average ingredient cost. Choose a product above to add a recipe.</p>
      </div>
      <Loadable query={recipes}>
        {(data) => <DataTable columns={columns} rows={data} rowKey={(r) => r.id} onRowClick={onOpen} empty={<EmptyState title="No recipes yet" description="A recipe tells ServeOS which ingredients one portion uses, so sales reduce stock and you can see food cost." />} />}
      </Loadable>
    </Card>
  );
}

export function RecipesPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const productId = params.get('product') ?? '';
  const variantId = params.get('variant') || null;
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const products = useProducts({ q: q || undefined, page: 1, pageSize: 200 });
  const product = useProduct(productId || null);
  const versions = useRecipes(productId || undefined);
  const lookups = useStockLookups();

  const choose = (nextProduct: string, nextVariant: string | null = null) =>
    setParams(nextProduct ? { product: nextProduct, ...(nextVariant ? { variant: nextVariant } : {}) } : {}, { replace: false });

  const loading = [product, versions, lookups.ingredients, lookups.units];
  const failed = loading.find((query) => query.isError);
  const active = versions.data?.find((r) => r.variantId === variantId && r.isActive);
  const options = products.data?.items ?? [];

  return (
    <>
      <PageHeader title="Recipes" description="What one portion of each product takes out of stock. Saving a recipe adds a new version; earlier versions are kept as history." />
      <Card className="mb-4 grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1fr)]">
        <Field label="Find a product" hint="Narrows the product list.">
          {(p) => <SearchInput {...p} placeholder="Name or SKU" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} />}
        </Field>
        <Field label="Product" error={products.isError ? errorMessage(products.error) : undefined} hint={products.data && products.data.total > options.length ? `Showing ${options.length} of ${products.data.total}; search to narrow.` : undefined}>
          {(p) => (
            <Select {...p} value={productId} onChange={(e) => choose(e.target.value)}>
              <option value="">Choose a product</option>
              {product.data && !options.some((o) => o.id === productId) ? <option value={product.data.id}>{product.data.name}</option> : null}
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.isActive ? '' : ' (inactive)'}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Applies to" hint="A variant’s own recipe wins over the product’s.">
          {(p) => (
            <Select {...p} value={variantId ?? ''} disabled={!product.data} onChange={(e) => choose(productId, e.target.value || null)}>
              <option value="">All variants</option>
              {(product.data?.variants ?? [])
                .filter((v) => v.isActive || v.id === variantId)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} only
                  </option>
                ))}
            </Select>
          )}
        </Field>
      </Card>

      {!productId ? (
        <ActiveRecipes onOpen={(r) => choose(r.productId, r.variantId)} />
      ) : failed ? (
        <Card>
          <ErrorState message={errorMessage(failed.error)} onRetry={() => loading.forEach((query) => query.isError && void query.refetch())} />
        </Card>
      ) : loading.some((query) => query.isPending) ? (
        <Card>
          <SkeletonRows rows={6} />
        </Card>
      ) : (
        <>
          <Button variant="ghost" size="sm" className="mb-3" onClick={() => choose('')}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            All recipes
          </Button>
          {/* Remounts when the choice or the saved recipe changes, so the editor always starts from the recipe in use. */}
          <RecipeEditor key={`${productId}:${variantId ?? 'all'}:${active?.id ?? 'none'}`} product={product.data!} variantId={variantId} versions={versions.data!} lookups={lookups} canManage={can('recipe.manage')} />
        </>
      )}
    </>
  );
}
