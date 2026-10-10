import { AlertTriangle, ArrowLeftRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Card, Checkbox, DataTable, EmptyState, Notice, SearchInput, type Column } from '@/components/ui';
import { useAuth, useOutlet } from '@/lib/auth';
import { money } from '@/lib/format';
import { Loadable, Toolbar, TwoLine } from '../../catalogue/common';
import { useStock, useUnits } from '../queries';
import { isNegative, qty } from '../quantity';
import type { StockRow } from '../types';
import { AdjustDialog } from './AdjustDialog';
import { TransferDialog } from './TransferDialog';

export function StockTab() {
  const outlet = useOutlet();
  const { can, me } = useAuth();
  const canManage = can('inventory.manage');
  const stock = useStock();
  const units = useUnits();
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [adjusting, setAdjusting] = useState<StockRow | null>(null);
  const [transferring, setTransferring] = useState(false);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (stock.data ?? []).filter((r) => (!needle || r.name.toLowerCase().includes(needle) || r.sku.toLowerCase().includes(needle)) && (!lowOnly || r.isLow));
  }, [stock.data, search, lowOnly]);
  const lowCount = (stock.data ?? []).filter((r) => r.isLow).length;
  const totalValue = (stock.data ?? []).reduce((sum, r) => sum + r.valueMinor, 0);

  const columns: Array<Column<StockRow>> = [
    { key: 'name', header: 'Ingredient', cell: (r) => <TwoLine primary={r.name} secondary={r.sku} /> },
    {
      key: 'quantity',
      header: 'Theoretical stock',
      align: 'right',
      cell: (r) => (
        <span className={isNegative(r.quantity) ? 'font-semibold text-bad' : undefined}>
          {qty(r.quantity)} <span className="text-ink-faint">{r.unit}</span>
        </span>
      ),
    },
    {
      key: 'threshold',
      header: 'Low-stock level',
      align: 'right',
      cell: (r) => (Number(r.lowStockThreshold) > 0 ? <>{qty(r.lowStockThreshold)} <span className="text-ink-faint">{r.unit}</span></> : <span className="text-ink-faint">Not set</span>),
    },
    {
      key: 'flag',
      header: 'Level',
      cell: (r) =>
        r.isLow ? (
          <Badge tone="bad">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            Low stock
          </Badge>
        ) : (
          <Badge tone="ok">OK</Badge>
        ),
    },
    { key: 'value', header: 'Value at avg. cost', align: 'right', cell: (r) => money(r.valueMinor) },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            // Keeps the visually hidden header inside the scrolling table instead of widening the page.
            className: 'relative',
            align: 'right' as const,
            cell: (r: StockRow) => (
              <Button size="sm" aria-label={`Adjust ${r.name}`} onClick={() => setAdjusting(r)}>
                Adjust
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="info" title="This is theoretical stock">
        These figures are calculated from recorded movements at {outlet.name}: goods received, recipe usage from sales, wastage, adjustments and transfers. They are not a physical count. Do a stock count to compare them with what is actually on the shelf.
      </Notice>
      {stock.data ? (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Card className="p-4">
            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Ingredients</dt>
            <dd className="tabular mt-1 text-xl font-bold text-ink">{stock.data.length}</dd>
          </Card>
          <Card className="p-4">
            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Low on stock</dt>
            <dd className={`tabular mt-1 text-xl font-bold ${lowCount ? 'text-bad' : 'text-ink'}`}>{lowCount}</dd>
          </Card>
          <Card className="col-span-2 p-4 sm:col-span-1">
            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Theoretical stock value</dt>
            <dd className="tabular mt-1 text-xl font-bold text-ink">{money(totalValue)}</dd>
          </Card>
        </dl>
      ) : null}
      <Card>
        <Toolbar>
          <SearchInput className="min-w-0 flex-1 basis-56" aria-label="Search ingredients" placeholder="Search ingredients" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} />
          <Checkbox label="Low stock only" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
          {canManage && (me?.outlets.length ?? 0) > 1 ? (
            <Button className="ml-auto" onClick={() => setTransferring(true)}>
              <ArrowLeftRight className="h-4 w-4" aria-hidden />
              Transfer stock
            </Button>
          ) : null}
        </Toolbar>
        <Loadable query={stock} rows={8}>
          {(data) => (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(r) => r.ingredientId}
              empty={data.length ? <EmptyState title="No ingredients match" description="Try a different search or clear the low-stock filter." /> : <EmptyState title="No ingredients yet" description="Add ingredients on the Ingredients tab, then receive goods to build up stock." />}
            />
          )}
        </Loadable>
      </Card>
      {adjusting && canManage ? <AdjustDialog row={adjusting} units={units.data ?? []} onClose={() => setAdjusting(null)} /> : null}
      {transferring && canManage ? <TransferDialog onClose={() => setTransferring(false)} /> : null}
    </div>
  );
}
