import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ORDER_TYPES, type OrderType } from '@serveos/shared';
import { ChevronLeft, CloudOff, Flame, Leaf, Minus, Pause, Percent, Plus, RefreshCw, Send, ShoppingBag, Star, Tag, Trash2, User, Wallet } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CheckoutDialog } from '@/components/checkout';
import { Badge, Button, cn, EmptyState, ErrorState, Field, Input, Notice, SearchInput, Segmented, Skeleton, StatusBadge, useToast } from '@/components/ui';
import { api, ApiError, assetUrl, errorMessage } from '@/lib/api';
import { useAuth, useOutlet } from '@/lib/auth';
import { dateTime, money, titleCase } from '@/lib/format';
import { reportOffline, useOnline } from '@/lib/online';
import type { Catalog, CatalogProduct, Order, ShiftSummary } from '@/lib/types';
import { loadCatalog, saveCatalog } from '@/offline/queue';
import { offlineDb, useSyncQueue } from '@/offline/useSyncQueue';
import { cartCount, cartProblem, cartReducer, emptyCart, lineUnitMinor, previewTotals, searchProducts, toOrderPayload, type CartLine, type CartState } from './cart';
import { CustomerDialog, DiscountDialog, HeldOrdersDrawer, OfflineCaptureDialog, ProductOptionsDialog, SyncCenterDrawer, TablePickerDialog } from './dialogs';

type CatalogResult = { catalog: Catalog; cachedAt: string | null };
type Dialog = null | 'customer' | 'table' | 'held' | 'sync' | 'orderDiscount' | 'offline';

/** The menu for the POS: from the server when possible (and saved for later), otherwise the saved copy. */
function useCatalog(outletId: string) {
  return useQuery({
    queryKey: ['catalog', outletId],
    staleTime: 60_000,
    queryFn: async (): Promise<CatalogResult> => {
      const db = await offlineDb();
      try {
        const catalog = await api<Catalog>('/menu/catalog');
        await saveCatalog(db, outletId, catalog);
        return { catalog, cachedAt: null };
      } catch (err) {
        const saved = err instanceof ApiError && err.isNetwork ? await loadCatalog(db, outletId) : null;
        if (!saved) throw err;
        reportOffline();
        return { catalog: saved.catalog, cachedAt: saved.savedAt };
      }
    },
  });
}

const draftKey = (outletId: string) => `serveos.cart.${outletId}`;

function orderToCart(order: Order): CartState {
  return {
    ...emptyCart(order.type),
    tableId: order.tables[0]?.table.id ?? null,
    tableName: order.tableLabel,
    customer: order.customer,
    guestCount: order.guestCount,
    notes: order.notes,
    deliveryName: order.deliveryName,
    deliveryPhone: order.deliveryPhone,
    deliveryAddress: order.deliveryAddress,
    draftOrderId: order.id,
    lines: order.items.map((i) => ({
      lineId: crypto.randomUUID(), productId: i.productId, variantId: i.variantId, name: i.productName, variantName: i.variantName, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor, notes: i.notes, discount: null,
      modifiers: i.modifiers.map((m) => ({ id: m.modifierOptionId, name: m.optionName, groupName: m.groupName, priceMinor: m.priceMinor })),
    })),
  };
}

export function PosPage() {
  const outlet = useOutlet();
  const { me, can } = useAuth();
  const online = useOnline();
  const notify = useToast();
  const queryClient = useQueryClient();
  const queue = useSyncQueue();
  const [params, setParams] = useSearchParams();
  const existingId = params.get('order');
  const searchRef = useRef<HTMLInputElement>(null);

  const [cart, dispatch] = useReducer(cartReducer, outlet.id, (id): CartState => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey(id)) ?? 'null') as CartState | null;
      if (saved?.lines && saved.attemptKey) return saved;
    } catch {
      /* a corrupt draft is ignored */
    }
    return emptyCart();
  });
  const [category, setCategory] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [options, setOptions] = useState<CatalogProduct | null>(null);
  const [lineDiscount, setLineDiscount] = useState<CartLine | null>(null);
  const [payOrderId, setPayOrderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTicket, setShowTicket] = useState(false);
  const [offlineSlip, setOfflineSlip] = useState<string | null>(null);

  const catalogQuery = useCatalog(outlet.id);
  const catalog = catalogQuery.data?.catalog;
  const shift = useQuery({ queryKey: ['shift', 'current'], queryFn: () => api<ShiftSummary | null>('/shifts/current'), enabled: online && can('shift.operate') });
  const existing = useQuery({ queryKey: ['order', existingId], queryFn: () => api<Order>(`/orders/${existingId}`), enabled: !!existingId && online });
  // An open (already placed) order: new items are added to it. A draft is loaded into the cart instead.
  const openOrder = existing.data && existing.data.status !== 'DRAFT' ? existing.data : null;

  useEffect(() => {
    if (existing.data?.status === 'DRAFT' && cart.draftOrderId !== existing.data.id) dispatch({ kind: 'load', cart: orderToCart(existing.data) });
  }, [existing.data, cart.draftOrderId]);

  // Arriving from the Tables screen with a free table chosen: start a dine-in order on it.
  const tableParam = params.get('table');
  useEffect(() => {
    if (!tableParam) return;
    dispatch({ kind: 'setTable', tableId: tableParam, tableName: params.get('tableName') ?? '' });
    params.delete('table');
    params.delete('tableName');
    setParams(params, { replace: true });
  }, [tableParam, params, setParams]);

  // The unsent cart survives a refresh or a crash. Open orders live on the server, not here.
  useEffect(() => {
    if (!existingId) localStorage.setItem(draftKey(outlet.id), JSON.stringify(cart));
  }, [cart, outlet.id, existingId]);

  // Discounts, customers and tables need the server: they are cleared when the POS goes offline.
  useEffect(() => {
    if (!online && !openOrder) {
      dispatch({ kind: 'clearDiscounts' });
      if (cart.type === 'DINE_IN') dispatch({ kind: 'setType', type: 'TAKEAWAY' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  const totals = useMemo(() => (catalog ? previewTotals(cart, catalog) : null), [cart, catalog]);
  const currency = catalog?.settings.currency ?? 'INR';
  const problem = cartProblem(openOrder ? { ...cart, type: 'TAKEAWAY' } : cart);

  const products = useMemo(() => {
    if (!catalog) return [];
    let list = catalog.products;
    if (category === 'favorites') list = list.filter((p) => p.isFavorite);
    else if (category === 'popular') list = catalog.popularProductIds.map((id) => list.find((p) => p.id === id)).filter((p) => !!p);
    else if (category !== 'all') {
      const ids = new Set([category, ...catalog.categories.filter((c) => c.parentId === category).map((c) => c.id)]);
      list = list.filter((p) => ids.has(p.categoryId));
    }
    return searchProducts(list, search);
  }, [catalog, category, search]);

  const pick = useCallback(
    (product: CatalogProduct) => {
      if (!product.isAvailable) return;
      if (product.variants.length > 1 || product.modifierGroupIds.length > 0) return setOptions(product);
      const variant = product.variants[0]!;
      dispatch({ kind: 'add', line: { productId: product.id, variantId: variant.id, name: product.name, variantName: variant.name, quantity: 1, unitPriceMinor: variant.priceMinor, modifiers: [], notes: '' } });
    },
    [],
  );

  const leaveOrder = () => {
    params.delete('order');
    setParams(params, { replace: true });
    dispatch({ kind: 'reset', type: 'TAKEAWAY' });
  };
  const refreshLists = () => {
    for (const key of ['orders', 'order', 'floor']) void queryClient.invalidateQueries({ queryKey: [key] });
  };

  const send = useMutation({
    mutationFn: async ({ action }: { action: 'PLACE' | 'HOLD'; thenPay: boolean }): Promise<Order> => {
      if (openOrder) return api<Order>(`/orders/${openOrder.id}/items`, { method: 'POST', body: { items: toOrderPayload(cart, 'PLACE').items } });
      const body = toOrderPayload(cart, action);
      if (cart.draftOrderId) return api<Order>(`/orders/${cart.draftOrderId}`, { method: 'PUT', body });
      // The key stays the same until this cart succeeds, so a retry after a timeout cannot create a second order.
      return api<Order>('/orders', { method: 'POST', body, idempotencyKey: cart.attemptKey });
    },
    onSuccess: (order, { action, thenPay }) => {
      setError(null);
      setShowTicket(false);
      refreshLists();
      if (openOrder) {
        dispatch({ kind: 'load', cart: { ...emptyCart(order.type), lines: [] } });
        void existing.refetch();
        notify(`Added to ${order.orderNumber} and sent to the kitchen`);
      } else {
        notify(action === 'HOLD' ? `Order ${order.orderNumber} held` : `Order ${order.orderNumber} sent to the kitchen`);
        if (existingId) leaveOrder();
        else dispatch({ kind: 'reset' });
      }
      if (thenPay) setPayOrderId(order.id);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.isNetwork) {
        reportOffline();
        setError('The server cannot be reached. You can save this order offline instead.');
      } else setError(errorMessage(err));
    },
  });

  const captureOffline = async (cashTenderedMinor: number | null) => {
    if (!me || !totals) return;
    const op = await queue.enqueue({
      outletId: outlet.id,
      userId: me.user.id,
      userName: me.user.name,
      payload: toOrderPayload(cart, 'PLACE'),
      summary: { lines: cart.lines.map((l) => ({ name: l.name, quantity: l.quantity, totalMinor: lineUnitMinor(l) * l.quantity })), totalMinor: totals.totalMinor },
      cashTenderedMinor,
    });
    setDialog(null);
    setOfflineSlip(op.localRef);
    dispatch({ kind: 'reset' });
  };

  const canSend = !problem && !send.isPending;
  const startPay = () => {
    if (!online) return setDialog('offline');
    if (openOrder && cart.lines.length === 0) return setPayOrderId(openOrder.id);
    send.mutate({ action: 'PLACE', thenPay: true });
  };

  // Keyboard shortcuts (documented in docs/setup.md). Ignored while a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === 'F2' || (e.key === '/' && !typing)) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'F4' && online) {
        e.preventDefault();
        setDialog('customer');
      } else if (e.key === 'F6' && online && canSend && !openOrder) {
        e.preventDefault();
        send.mutate({ action: 'HOLD', thenPay: false });
      } else if (e.key === 'F7' && online) {
        e.preventDefault();
        setDialog('held');
      } else if (e.key === 'F8' && online && canSend) {
        e.preventDefault();
        send.mutate({ action: 'PLACE', thenPay: false });
      } else if (e.key === 'F9' && (canSend || (openOrder && cart.lines.length === 0))) {
        e.preventDefault();
        startPay();
      } else if (e.key === 'Escape' && typing && search) {
        setSearch('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (catalogQuery.isPending) {
    return (
      <div className="grid h-full grid-cols-2 gap-3 p-4 md:grid-cols-4" role="status" aria-label="Loading menu">
        {Array.from({ length: 12 }, (_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }
  if (catalogQuery.isError || !catalog || !totals) {
    return <ErrorState message={online ? errorMessage(catalogQuery.error) : 'You are offline and no menu has been saved on this device yet. Connect once to download it.'} onRetry={() => void catalogQuery.refetch()} />;
  }

  const pendingSync = queue.counts.queued + queue.counts.syncing + queue.counts.conflict;
  const topCategories = catalog.categories.filter((c) => !c.parentId);
  const tabs = [
    { id: 'all', name: 'All' },
    ...(catalog.products.some((p) => p.isFavorite) ? [{ id: 'favorites', name: 'Favourites' }] : []),
    ...(catalog.popularProductIds.length ? [{ id: 'popular', name: 'Popular' }] : []),
    ...topCategories,
  ];
  const orderTypes = ORDER_TYPES.map((t) => ({ value: t, label: titleCase(t), disabled: !online && t === 'DINE_IN' }));

  const ticket = (
    <section aria-label="Current order" className="flex h-full min-h-0 flex-col bg-surface">
      <header className="border-b border-line px-4 py-3">
        {openOrder ? (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-lg font-bold text-ink">
                {openOrder.orderNumber} {openOrder.tableLabel ? `· ${openOrder.tableLabel}` : ''}
              </p>
              <p className="text-sm text-ink-soft">
                {titleCase(openOrder.type)} · opened {dateTime(openOrder.createdAt, outlet.timezone)}
              </p>
            </div>
            <StatusBadge status={openOrder.status} />
          </div>
        ) : (
          <>
            <Segmented label="Order type" className="w-full [&>button]:flex-1" value={cart.type} onChange={(type: OrderType) => dispatch({ kind: 'setType', type })} options={orderTypes} />
            <div className="mt-2 flex gap-2">
              {cart.type === 'DINE_IN' ? (
                <Button className="flex-1 justify-start" onClick={() => setDialog('table')}>
                  {cart.tableId ? `Table ${cart.tableName}` : 'Choose table'}
                </Button>
              ) : null}
              <Button className="flex-1 justify-start truncate" disabled={!online || !can('customer.view')} onClick={() => setDialog('customer')}>
                <User className="h-4 w-4 shrink-0" aria-hidden />
                <span className="truncate">{cart.customer?.name ?? 'Customer'}</span>
              </Button>
              {cart.customer ? (
                <Button variant="ghost" size="icon" aria-label="Remove customer" onClick={() => dispatch({ kind: 'setCustomer', customer: null })}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
            {cart.type === 'DELIVERY' ? (
              <div className="mt-2 grid gap-2">
                <div className="grid grid-cols-2 gap-2">
                  <Input aria-label="Delivery name" placeholder="Name" value={cart.deliveryName} onChange={(e) => dispatch({ kind: 'patch', fields: { deliveryName: e.target.value } })} />
                  <Input aria-label="Delivery phone" placeholder="Phone" inputMode="tel" value={cart.deliveryPhone} onChange={(e) => dispatch({ kind: 'patch', fields: { deliveryPhone: e.target.value } })} />
                </div>
                <Input aria-label="Delivery address" placeholder="Delivery address" value={cart.deliveryAddress} onChange={(e) => dispatch({ kind: 'patch', fields: { deliveryAddress: e.target.value } })} />
              </div>
            ) : null}
          </>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {openOrder ? (
          <ul className="divide-y divide-line border-b border-line bg-sunken/50" aria-label="Items already sent">
            {openOrder.items.map((i) => (
              <li key={i.id} className={cn('flex items-start justify-between gap-3 px-4 py-2 text-sm', i.status === 'VOIDED' && 'text-ink-faint line-through')}>
                <span>
                  {i.quantity} × {i.productName}
                  {i.variantName !== 'Regular' ? ` (${i.variantName})` : ''}
                  {i.modifiers.length ? <span className="block text-xs text-ink-faint">{i.modifiers.map((m) => m.optionName).join(', ')}</span> : null}
                </span>
                <span className="tabular">{money(i.lineSubtotalMinor, currency)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {cart.lines.length === 0 ? (
          <EmptyState icon={<ShoppingBag className="h-6 w-6" aria-hidden />} title={openOrder ? 'Tap items to add to this order' : 'No items yet'} description={openOrder ? undefined : 'Tap a product to start an order.'} />
        ) : (
          <ul className="divide-y divide-line">
            {cart.lines.map((line) => (
              <li key={line.lineId} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">
                      {line.name}
                      {line.variantName !== 'Regular' ? <span className="text-ink-soft"> · {line.variantName}</span> : null}
                    </p>
                    {line.modifiers.length ? <p className="text-sm text-ink-soft">{line.modifiers.map((m) => m.name).join(', ')}</p> : null}
                    {line.notes ? <p className="text-sm italic text-ink-faint">“{line.notes}”</p> : null}
                    {line.discount ? (
                      <Badge tone="brand" className="mt-1">
                        <Tag className="h-3 w-3" aria-hidden /> {line.discount.type === 'PERCENT' ? `${line.discount.value / 100}% off` : `${money(line.discount.value, currency)} off`}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="tabular shrink-0 font-semibold text-ink">{money(lineUnitMinor(line) * line.quantity, currency)}</p>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Button size="icon" aria-label={`Decrease ${line.name}`} onClick={() => dispatch({ kind: 'setQuantity', lineId: line.lineId, quantity: line.quantity - 1 })}>
                    {line.quantity === 1 ? <Trash2 className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
                  </Button>
                  <span className="tabular w-8 text-center font-bold" aria-label={`Quantity ${line.quantity}`}>
                    {line.quantity}
                  </span>
                  <Button size="icon" aria-label={`Increase ${line.name}`} onClick={() => dispatch({ kind: 'setQuantity', lineId: line.lineId, quantity: line.quantity + 1 })}>
                    <Plus className="h-4 w-4" />
                  </Button>
                  {online && !openOrder && can('discount.apply') ? (
                    <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setLineDiscount(line)}>
                      <Percent className="h-4 w-4" aria-hidden /> Discount
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="border-t border-line bg-surface px-4 pb-4 pt-3">
        {!openOrder ? (
          <Field label="Order note" className="mb-3 [&>label]:sr-only">
            {(p) => <Input {...p} placeholder="Order note (e.g. allergy)" value={cart.notes} maxLength={300} onChange={(e) => dispatch({ kind: 'patch', fields: { notes: e.target.value } })} />}
          </Field>
        ) : null}
        <dl className="tabular space-y-1 text-sm text-ink-soft">
          <div className="flex justify-between">
            <dt>Subtotal</dt>
            <dd>{money(totals.subtotalMinor, currency)}</dd>
          </div>
          {totals.itemDiscountMinor + totals.orderDiscountMinor > 0 ? (
            <div className="flex justify-between text-brand-strong">
              <dt>Discount</dt>
              <dd>−{money(totals.itemDiscountMinor + totals.orderDiscountMinor, currency)}</dd>
            </div>
          ) : null}
          {cart.couponCode ? (
            <div className="flex justify-between text-brand-strong">
              <dt>Coupon {cart.couponCode}</dt>
              <dd>applied at checkout</dd>
            </div>
          ) : null}
          {totals.serviceChargeMinor > 0 ? (
            <div className="flex justify-between">
              <dt>Service charge</dt>
              <dd>{money(totals.serviceChargeMinor, currency)}</dd>
            </div>
          ) : null}
          {totals.deliveryChargeMinor > 0 ? (
            <div className="flex justify-between">
              <dt>Delivery charge</dt>
              <dd>{money(totals.deliveryChargeMinor, currency)}</dd>
            </div>
          ) : null}
          {totals.taxLines.map((t) => (
            <div key={t.name} className="flex justify-between">
              <dt>
                {t.name}
                {catalog.settings.pricesIncludeTax ? ' (included)' : ''}
              </dt>
              <dd>{money(t.amountMinor, currency)}</dd>
            </div>
          ))}
          {totals.roundOffMinor !== 0 ? (
            <div className="flex justify-between">
              <dt>Round off</dt>
              <dd>{money(totals.roundOffMinor, currency)}</dd>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between border-t border-line pt-2 text-ink">
            <dt className="text-base font-semibold">{openOrder ? 'New items' : 'Total'}</dt>
            <dd className="text-2xl font-bold">{money(totals.totalMinor, currency)}</dd>
          </div>
          {openOrder ? (
            <div className="flex justify-between text-ink">
              <dt>Bill so far (due)</dt>
              <dd className="font-semibold">{money(openOrder.dueMinor, currency)}</dd>
            </div>
          ) : null}
        </dl>

        {error ? <Notice tone="bad" className="mt-3">{error}</Notice> : null}
        {problem && cart.lines.length > 0 ? <p className="mt-2 text-sm font-medium text-warn">{problem}</p> : null}

        <div className="mt-3 grid grid-cols-3 gap-2">
          {openOrder ? (
            <Button className="col-span-1" onClick={leaveOrder}>
              <ChevronLeft className="h-4 w-4" aria-hidden /> Close
            </Button>
          ) : (
            <>
              <Button disabled={!online || !canSend} title="Hold (F6)" onClick={() => send.mutate({ action: 'HOLD', thenPay: false })}>
                <Pause className="h-4 w-4" aria-hidden /> Hold
              </Button>
              <Button disabled={!online || cart.lines.length === 0} onClick={() => setDialog('orderDiscount')}>
                <Percent className="h-4 w-4" aria-hidden /> Discount
              </Button>
            </>
          )}
          <Button variant="dark" className={openOrder ? 'col-span-2' : ''} disabled={!online || !canSend} loading={send.isPending && !send.variables?.thenPay} title="Send to kitchen (F8)" onClick={() => send.mutate({ action: 'PLACE', thenPay: false })}>
            <Send className="h-4 w-4" aria-hidden /> {openOrder ? 'Send new items' : 'Send'}
          </Button>
        </div>
        {can('payment.record') || !online ? (
          <Button variant="primary" size="lg" className="mt-2 w-full" disabled={!(canSend || (openOrder && cart.lines.length === 0 && openOrder.dueMinor > 0))} loading={send.isPending && send.variables?.thenPay} title="Pay (F9)" onClick={startPay}>
            {online ? <Wallet className="h-5 w-5" aria-hidden /> : <CloudOff className="h-5 w-5" aria-hidden />}
            {online ? (openOrder && cart.lines.length === 0 ? `Take payment · ${money(openOrder.dueMinor, currency)}` : `Pay · ${money(totals.totalMinor, currency)}`) : `Save offline · ${money(totals.totalMinor, currency)}`}
          </Button>
        ) : null}
      </footer>
    </section>
  );

  return (
    <div className="flex h-full min-h-0">
      <div className={cn('flex min-w-0 flex-1 flex-col', showTicket && 'hidden lg:flex')}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
          <SearchInput ref={searchRef} className="min-w-40 flex-1" placeholder="Search name or SKU (F2)" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} />
          {can('shift.operate') && online ? (
            <Button asChild variant={shift.data ? 'secondary' : 'primary'} size="sm">
              <Link to="/shift">
                <Wallet className="h-4 w-4" aria-hidden />
                {shift.data ? `${shift.data.shift.register.name} open` : 'Open cash shift'}
              </Link>
            </Button>
          ) : null}
          <Button size="sm" disabled={!online} title="Held orders (F7)" onClick={() => setDialog('held')}>
            <Pause className="h-4 w-4" aria-hidden /> Held
          </Button>
          <Button size="sm" variant={queue.counts.conflict > 0 ? 'danger' : 'secondary'} onClick={() => setDialog('sync')}>
            <RefreshCw className={cn('h-4 w-4', queue.syncing && 'animate-spin')} aria-hidden />
            {pendingSync > 0 ? `${pendingSync} offline` : 'Offline orders'}
          </Button>
        </div>
        {catalogQuery.data?.cachedAt ? (
          <Notice tone="warn" className="m-3 mb-0">
            Showing the menu saved on {dateTime(catalogQuery.data.cachedAt, outlet.timezone)}. Prices and availability may have changed; the server checks them when orders are sent.
          </Notice>
        ) : null}
        {offlineSlip ? (
          <Notice tone="warn" title={`Saved offline as ${offlineSlip}`} className="m-3 mb-0">
            Not yet confirmed by the server. Give the guest this reference and tell the kitchen directly.{' '}
            <button type="button" className="font-semibold underline" onClick={() => setOfflineSlip(null)}>
              Dismiss
            </button>
          </Notice>
        ) : null}

        <nav aria-label="Categories" className="flex gap-2 overflow-x-auto border-b border-line bg-surface px-3 py-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={category === t.id}
              onClick={() => setCategory(t.id)}
              className={cn('flex h-11 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-semibold transition-colors', category === t.id ? 'bg-ink text-white' : 'bg-sunken text-ink-soft hover:bg-line')}
            >
              {t.id === 'favorites' ? <Star className="h-4 w-4" aria-hidden /> : t.id === 'popular' ? <Flame className="h-4 w-4" aria-hidden /> : null}
              {t.name}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {products.length === 0 ? (
            <EmptyState title="No products match" description={search ? `Nothing found for “${search}”.` : 'This category is empty.'} />
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {products.map((p) => {
                const from = Math.min(...p.variants.map((v) => v.priceMinor));
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      disabled={!p.isAvailable}
                      onClick={() => pick(p)}
                      className={cn('flex h-full min-h-28 w-full flex-col overflow-hidden rounded-card border border-line bg-surface text-left shadow-card transition-transform active:scale-[0.98]', p.isAvailable ? 'hover:border-brand' : 'opacity-50')}
                    >
                      {p.imageUrl ? <img src={assetUrl(p.imageUrl)} alt="" loading="lazy" className="h-20 w-full object-cover" /> : null}
                      <span className="flex flex-1 flex-col justify-between gap-2 p-3">
                        <span className="flex items-start gap-1.5 text-sm font-semibold leading-snug text-ink">
                          {p.isVeg != null ? <Leaf className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', p.isVeg ? 'text-ok' : 'text-bad')} aria-label={p.isVeg ? 'Vegetarian' : 'Non-vegetarian'} /> : null}
                          {p.name}
                        </span>
                        <span className="flex items-center justify-between gap-2">
                          <span className="tabular text-sm font-bold text-ink">
                            {p.variants.length > 1 ? 'from ' : ''}
                            {money(from, currency)}
                          </span>
                          {!p.isAvailable ? <Badge tone="bad">Unavailable</Badge> : null}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="border-t border-line bg-surface p-3 lg:hidden">
          <Button variant="primary" size="lg" className="w-full justify-between" onClick={() => setShowTicket(true)}>
            <span>View order ({cartCount(cart)})</span>
            <span className="tabular">{money(totals.totalMinor, currency)}</span>
          </Button>
        </div>
      </div>

      <aside className={cn('w-full shrink-0 border-l border-line lg:block lg:w-[24rem]', showTicket ? 'block' : 'hidden')}>
        <div className="flex h-full flex-col">
          <Button variant="ghost" className="m-2 justify-start lg:hidden" onClick={() => setShowTicket(false)}>
            <ChevronLeft className="h-4 w-4" aria-hidden /> Back to menu
          </Button>
          <div className="min-h-0 flex-1">{ticket}</div>
        </div>
      </aside>

      <ProductOptionsDialog product={options} catalog={catalog} onClose={() => setOptions(null)} onAdd={(line) => dispatch({ kind: 'add', line })} />
      <CustomerDialog open={dialog === 'customer'} onClose={() => setDialog(null)} onSelect={(customer) => dispatch({ kind: 'setCustomer', customer })} />
      <TablePickerDialog open={dialog === 'table'} onClose={() => setDialog(null)} onSelect={(t) => dispatch({ kind: 'setTable', tableId: t.id, tableName: t.name })} />
      <HeldOrdersDrawer open={dialog === 'held'} onClose={() => setDialog(null)} onResume={(id) => setParams({ order: id })} />
      <SyncCenterDrawer open={dialog === 'sync'} onClose={() => setDialog(null)} />
      <OfflineCaptureDialog open={dialog === 'offline'} onClose={() => setDialog(null)} totalMinor={totals.totalMinor} currency={currency} onConfirm={(cash) => void captureOffline(cash)} />
      <DiscountDialog
        open={dialog === 'orderDiscount'}
        onClose={() => setDialog(null)}
        title="Order discount"
        baseMinor={totals.subtotalMinor - totals.itemDiscountMinor}
        current={cart.orderDiscount}
        onApply={(discount) => dispatch({ kind: 'setOrderDiscount', discount })}
        allowCoupon
        coupon={cart.couponCode}
        onCoupon={(code) => dispatch({ kind: 'setCoupon', code })}
      />
      <DiscountDialog
        open={!!lineDiscount}
        onClose={() => setLineDiscount(null)}
        title={`Discount on ${lineDiscount?.name ?? ''}`}
        baseMinor={lineDiscount ? lineUnitMinor(lineDiscount) * lineDiscount.quantity : 0}
        current={lineDiscount?.discount ?? null}
        onApply={(discount) => lineDiscount && dispatch({ kind: 'setLineDiscount', lineId: lineDiscount.lineId, discount })}
      />
      <CheckoutDialog
        orderId={payOrderId}
        open={!!payOrderId}
        onClose={() => {
          setPayOrderId(null);
          if (openOrder) void existing.refetch();
        }}
      />
    </div>
  );
}
