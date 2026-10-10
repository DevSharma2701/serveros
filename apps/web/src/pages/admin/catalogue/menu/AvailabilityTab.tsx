import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, Input, Modal, Notice, SearchInput, Select, SkeletonRows, useToast, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth, useOutlet } from '@/lib/auth';
import { money } from '@/lib/format';
import type { Catalog, CatalogProduct } from '@/lib/types';
import { Loadable, Toolbar, TwoLine } from '../common';
import { minorToText } from '../forms';
import { useProduct } from '../queries';
import { VegMark } from './ProductsTab';
import { parseAmount } from '@/lib/format';

interface AvailabilityBody {
  isAvailable: boolean;
  variantPrices?: Array<{ variantId: string; priceMinor: number | null }>;
}

function useSetAvailability() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ productId, body }: { productId: string; body: AvailabilityBody }) => api(`/menu/products/${productId}/availability`, { method: 'PUT', body }),
    onSuccess: () => {
      for (const key of ['catalog', 'product']) void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}

/** Price overrides of one product for the selected outlet. An empty box means "use the menu price". */
function OutletPricesDialog({ product, onClose }: { product: CatalogProduct; onClose: () => void }) {
  const outlet = useOutlet();
  const notify = useToast();
  const detail = useProduct(product.id);
  const save = useSetAvailability();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const variants = (detail.data?.variants ?? []).filter((v) => v.isActive);
  const overrideOf = (variantId: string) => variants.find((v) => v.id === variantId)?.outletPrices.find((p) => p.outletId === outlet.id)?.priceMinor ?? null;
  const textOf = (variantId: string) => typed[variantId] ?? minorToText(overrideOf(variantId));

  const submit = () => {
    const problems: Record<string, string> = {};
    const variantPrices = variants.map((v) => {
      const text = textOf(v.id).trim();
      const priceMinor = text ? parseAmount(text) : null;
      if (text && priceMinor == null) problems[v.id] = 'Enter an amount like 120 or 120.50';
      return { variantId: v.id, priceMinor };
    });
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    save.mutate(
      { productId: product.id, body: { isAvailable: product.isAvailable, variantPrices } },
      {
        onSuccess: () => {
          notify(`Prices for ${product.name} at ${outlet.name} saved`);
          onClose();
        },
        onError: (err) => notify(errorMessage(err), 'bad'),
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${product.name}: prices at ${outlet.name}`}
      description="Leave a price empty to charge the menu price in this outlet."
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!detail.data} onClick={submit}>
            Save outlet prices
          </Button>
        </>
      }
    >
      {detail.isPending ? (
        <SkeletonRows rows={3} />
      ) : detail.isError ? (
        <ErrorState message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {variants.map((v) => (
            <div key={v.id} className="grid grid-cols-2 items-start gap-3">
              <div className="pt-1">
                <p className="font-medium text-ink">{v.name}</p>
                <p className="text-sm text-ink-soft">
                  Menu price <span className="tabular">{money(v.priceMinor)}</span>
                </p>
              </div>
              <Field label={`Price at this outlet (₹), ${v.name}`} error={errors[v.id]}>
                {(p) => <Input {...p} inputMode="decimal" autoComplete="off" className="tabular text-right" placeholder={minorToText(v.priceMinor)} value={textOf(v.id)} onChange={(e) => setTyped((t) => ({ ...t, [v.id]: e.target.value }))} />}
              </Field>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function AvailabilityTab() {
  const outlet = useOutlet();
  const { can } = useAuth();
  const notify = useToast();
  const canToggle = can('menu.availability');
  const canPrice = can('menu.manage') && canToggle;
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [show, setShow] = useState<'all' | 'unavailable'>('all');
  const [pricing, setPricing] = useState<CatalogProduct | null>(null);
  // The POS catalogue is the outlet's own view of the menu: availability and prices as sold here.
  const catalog = useQuery({ queryKey: ['catalog', 'availability', outlet.id], queryFn: () => api<Catalog>('/menu/catalog') });
  const toggle = useSetAvailability();

  const categoryName = useMemo(() => new Map((catalog.data?.categories ?? []).map((c) => [c.id, c.name])), [catalog.data]);
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (catalog.data?.products ?? []).filter(
      (p) => (!needle || p.name.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle)) && (!categoryId || p.categoryId === categoryId) && (show === 'all' || !p.isAvailable),
    );
  }, [catalog.data, search, categoryId, show]);

  const setAvailable = (product: CatalogProduct, isAvailable: boolean) =>
    toggle.mutate(
      { productId: product.id, body: { isAvailable } },
      {
        onSuccess: () => notify(`${product.name} is now ${isAvailable ? 'available' : 'unavailable'} at ${outlet.name}`),
        onError: (err) => notify(errorMessage(err), 'bad'),
      },
    );

  const columns: Array<Column<CatalogProduct>> = [
    { key: 'name', header: 'Product', cell: (p) => <TwoLine primary={p.name} secondary={<span className="inline-flex flex-wrap gap-x-2">{p.sku} <VegMark isVeg={p.isVeg} /></span>} /> },
    { key: 'category', header: 'Category', cell: (p) => categoryName.get(p.categoryId) ?? '' },
    {
      key: 'price',
      header: 'Price here',
      align: 'right',
      cell: (p) => (
        <div className="flex flex-col items-end">
          {p.variants.map((v) => (
            <span key={v.id} className="whitespace-nowrap">
              {p.variants.length > 1 ? <span className="mr-2 text-xs text-ink-faint">{v.name}</span> : null}
              {money(v.priceMinor)}
            </span>
          ))}
        </div>
      ),
    },
    { key: 'status', header: 'At this outlet', cell: (p) => <Badge tone={p.isAvailable ? 'ok' : 'bad'}>{p.isAvailable ? 'Available' : 'Unavailable'}</Badge> },
    ...(canToggle
      ? [
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            // Keeps the visually hidden header inside the scrolling table instead of widening the page.
            className: 'relative',
            align: 'right' as const,
            cell: (p: CatalogProduct) => (
              <div className="flex flex-wrap justify-end gap-2">
                <Button size="sm" disabled={toggle.isPending} aria-label={`Mark ${p.name} ${p.isAvailable ? 'unavailable' : 'available'}`} onClick={() => setAvailable(p, !p.isAvailable)}>
                  {p.isAvailable ? 'Mark unavailable' : 'Mark available'}
                </Button>
                {canPrice ? (
                  <Button size="sm" variant="ghost" aria-label={`Outlet prices for ${p.name}`} onClick={() => setPricing(p)}>
                    Outlet prices
                  </Button>
                ) : null}
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="info">
        Availability and prices on this tab apply to <strong>{outlet.name}</strong> only. Switch outlet in the sidebar to manage another one. Only active products are listed.
      </Notice>
      <Card>
        <Toolbar>
          <SearchInput className="min-w-0 flex-1 basis-56" aria-label="Search products" placeholder="Search by name or SKU" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} />
          <Select aria-label="Category" className="w-auto min-w-40 flex-1 basis-40 sm:flex-none" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All categories</option>
            {(catalog.data?.categories ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Show" className="w-auto flex-1 basis-40 sm:flex-none" value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
            <option value="all">All products</option>
            <option value="unavailable">Unavailable only</option>
          </Select>
        </Toolbar>
        <Loadable query={catalog} rows={8}>
          {() => (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(p) => p.id}
              empty={<EmptyState title={catalog.data?.products.length ? 'No products match' : 'No active products'} description={catalog.data?.products.length ? 'Try a different search or filter.' : 'Add products on the Products tab first.'} />}
            />
          )}
        </Loadable>
      </Card>
      {pricing ? <OutletPricesDialog product={pricing} onClose={() => setPricing(null)} /> : null}
    </div>
  );
}
