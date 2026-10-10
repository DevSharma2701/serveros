import { Plus, Star } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, DataTable, EmptyState, ErrorState, Modal, Pagination, SearchInput, Select, SkeletonRows, type Column } from '@/components/ui';
import { assetUrl, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money } from '@/lib/format';
import { ActiveBadge, Loadable, Toolbar, TwoLine } from '../common';
import { useCategories, useDebounced, useModifierGroups, useProduct, useProducts, useStations, useTaxCategories } from '../queries';
import type { Product } from '../types';
import { ProductForm } from './ProductForm';

const PAGE_SIZE = 25;

export function VegMark({ isVeg }: { isVeg: boolean | null }) {
  if (isVeg == null) return null;
  // The Indian veg / non-veg mark, with a text label so it does not rely on colour.
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${isVeg ? 'text-ok' : 'text-bad'}`}>
      <span aria-hidden className="flex h-3.5 w-3.5 items-center justify-center border border-current">
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      {isVeg ? 'Veg' : 'Non-veg'}
    </span>
  );
}

export function priceRange(product: Pick<Product, 'variants'>): string {
  const prices = product.variants.filter((v) => v.isActive).map((v) => v.priceMinor);
  if (prices.length === 0) return '—';
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return low === high ? money(low) : `${money(low)} – ${money(high)}`;
}

/** Loads what the editor needs, then shows the form in a dialog. */
function ProductEditor({ productId, onClose }: { productId: string | null; onClose: () => void }) {
  const product = useProduct(productId);
  const categories = useCategories();
  const taxCategories = useTaxCategories();
  const modifierGroups = useModifierGroups();
  const stations = useStations();
  const { can } = useAuth();

  const needed = [categories, taxCategories, modifierGroups, ...(productId ? [product] : []), ...(can('kitchen.view') ? [stations] : [])];
  const failed = needed.find((q) => q.isError);
  const loading = needed.some((q) => q.isPending);

  return (
    <Modal open onClose={onClose} title={productId ? (product.data?.name ?? 'Edit product') : 'New product'} description={productId ? `SKU ${product.data?.sku ?? '…'}` : 'Add a dish or drink to the menu of every outlet.'} size="lg">
      {failed ? (
        <ErrorState message={errorMessage(failed.error)} onRetry={() => needed.forEach((q) => q.isError && void q.refetch())} />
      ) : loading ? (
        <SkeletonRows rows={8} />
      ) : (
        <ProductForm
          key={productId ?? 'new'}
          product={productId ? product.data : undefined}
          lookups={{ categories: categories.data ?? [], taxCategories: taxCategories.data ?? [], modifierGroups: modifierGroups.data ?? [], stations: stations.data ?? null }}
          onSaved={onClose}
          onCancel={onClose}
        />
      )}
    </Modal>
  );
}

export function ProductsTab() {
  const { can } = useAuth();
  const canManage = can('menu.manage');
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [active, setActive] = useState<'all' | 'true' | 'false'>('all');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const q = useDebounced(search.trim());
  const categories = useCategories();
  const products = useProducts({ q: q || undefined, categoryId: categoryId || undefined, active: active === 'all' ? undefined : active === 'true', page, pageSize: PAGE_SIZE });
  const filtered = !!q || !!categoryId || active !== 'all';

  const columns: Array<Column<Product>> = [
    {
      key: 'name',
      header: 'Product',
      cell: (p) => (
        <div className="flex items-center gap-3">
          <div className="hidden h-10 w-10 shrink-0 overflow-hidden rounded-control bg-sunken sm:block">{p.imageUrl ? <img src={assetUrl(p.imageUrl)} alt="" className="h-full w-full object-cover" loading="lazy" /> : null}</div>
          <TwoLine
            primary={
              <span className="inline-flex flex-wrap items-center gap-x-2">
                {p.name}
                {p.isFavorite ? <Star className="h-3.5 w-3.5 fill-current text-warn" aria-label="Favourite" /> : null}
              </span>
            }
            secondary={<VegMark isVeg={p.isVeg} />}
          />
        </div>
      ),
    },
    { key: 'sku', header: 'SKU', cell: (p) => <span className="tabular text-ink-soft">{p.sku}</span> },
    { key: 'category', header: 'Category', cell: (p) => p.category.name },
    {
      key: 'variants',
      header: 'Variants',
      cell: (p) => {
        const live = p.variants.filter((v) => v.isActive);
        return live.length === 1 ? live[0]!.name : `${live.length} variants`;
      },
    },
    { key: 'price', header: 'Price', align: 'right', cell: (p) => priceRange(p) },
    { key: 'status', header: 'Status', cell: (p) => <ActiveBadge active={p.isActive} /> },
  ];

  return (
    <Card>
      <Toolbar>
        <SearchInput className="min-w-0 flex-1 basis-56" aria-label="Search products by name or SKU" placeholder="Search by name or SKU" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} onClear={() => (setSearch(''), setPage(1))} />
        <Select aria-label="Category" className="w-auto min-w-40 flex-1 basis-40 sm:flex-none" value={categoryId} onChange={(e) => (setCategoryId(e.target.value), setPage(1))}>
          <option value="">All categories</option>
          {(categories.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Status" className="w-auto flex-1 basis-32 sm:flex-none" value={active} onChange={(e) => (setActive(e.target.value as typeof active), setPage(1))}>
          <option value="all">Any status</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </Select>
        {canManage ? (
          <Button variant="primary" className="ml-auto" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden />
            New product
          </Button>
        ) : null}
      </Toolbar>
      <Loadable query={products} rows={8}>
        {(data) => (
          <>
            <DataTable
              columns={columns}
              rows={data.items}
              rowKey={(p) => p.id}
              onRowClick={canManage ? (p) => setEditing(p.id) : undefined}
              empty={
                filtered ? (
                  <EmptyState title="No products match" description="Try a different search or clear the filters." />
                ) : (
                  <EmptyState title="No products yet" description="Products are the dishes and drinks sold at the POS." action={canManage ? <Button variant="primary" onClick={() => setEditing('new')}>New product</Button> : undefined} />
                )
              }
            />
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Loadable>
      {!canManage && products.data?.items.length ? <p className="border-t border-line px-4 py-2 text-xs text-ink-faint">You can view the menu. Editing needs the “manage menu” permission.</p> : null}
      {editing && canManage ? <ProductEditor productId={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}
