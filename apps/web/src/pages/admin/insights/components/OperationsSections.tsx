import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Card, DataTable, EmptyState, type Column } from '@/components/ui';
import { dateTime } from '@/lib/format';
import type { DashboardCashShift, DashboardResponse, InventoryAlert } from '../types';

function TableCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <Card className="min-w-0 overflow-hidden">
      <div className="px-4 pb-3 pt-4">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-sm text-ink-soft">{subtitle}</p> : null}
      </div>
      {children}
    </Card>
  );
}

type Money = (minor: number) => string;

export function OutletComparison({ data, formatMoney }: { data: DashboardResponse; formatMoney: Money }) {
  type Row = DashboardResponse['outletComparison'][number];
  const columns: Array<Column<Row>> = [
    { key: 'outlet', header: 'Outlet', cell: (r) => <span className="font-medium">{r.outlet}</span> },
    { key: 'orders', header: 'Completed orders', align: 'right', cell: (r) => r.orders.toLocaleString('en-IN') },
    { key: 'net', header: 'Net sales', align: 'right', cell: (r) => formatMoney(r.netSalesMinor) },
    { key: 'total', header: 'Total billed', align: 'right', cell: (r) => formatMoney(r.totalBilledMinor) },
    { key: 'cancelled', header: 'Cancelled', align: 'right', cell: (r) => r.cancelledOrders.toLocaleString('en-IN') },
  ];
  return (
    <TableCard title="Outlet comparison" subtitle="The same period in each selected outlet">
      <DataTable columns={columns} rows={data.outletComparison} rowKey={(r) => r.outletId} />
    </TableCard>
  );
}

/** Signed variance with a word and an icon, so short/over never depends on colour. */
function Variance({ minor, formatMoney }: { minor: number | null; formatMoney: Money }) {
  if (minor == null) return <span className="text-ink-faint">Not recorded</span>;
  if (minor === 0) {
    return (
      <Badge tone="ok">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Matched
      </Badge>
    );
  }
  return (
    <Badge tone={minor < 0 ? 'bad' : 'warn'}>
      <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
      {minor < 0 ? `Short ${formatMoney(-minor)}` : `Over ${formatMoney(minor)}`}
    </Badge>
  );
}

export function CashShifts({ data, formatMoney, timeZone }: { data: DashboardResponse; formatMoney: Money; timeZone: string }) {
  const columns: Array<Column<DashboardCashShift>> = [
    { key: 'closed', header: 'Closed', cell: (r) => <span className="whitespace-nowrap">{dateTime(r.closedAt, timeZone)}</span> },
    { key: 'outlet', header: 'Outlet', cell: (r) => r.outlet },
    { key: 'register', header: 'Register', cell: (r) => r.register },
    { key: 'by', header: 'Opened by', cell: (r) => r.openedByName },
    { key: 'expected', header: 'Expected cash', align: 'right', cell: (r) => (r.expectedCashMinor == null ? '' : formatMoney(r.expectedCashMinor)) },
    { key: 'counted', header: 'Counted cash', align: 'right', cell: (r) => (r.countedCashMinor == null ? '' : formatMoney(r.countedCashMinor)) },
    { key: 'variance', header: 'Variance', align: 'right', cell: (r) => <Variance minor={r.varianceMinor} formatMoney={formatMoney} /> },
  ];
  return (
    <TableCard title="Closed cash shifts" subtitle="Shifts closed in the period, newest first">
      <DataTable columns={columns} rows={data.cashShifts} rowKey={(r) => r.id} empty={<EmptyState title="No shifts were closed" description="Cash shifts closed in this period will be listed here with their variance." />} />
    </TableCard>
  );
}

export function InventoryAlerts({ data }: { data: DashboardResponse }) {
  const columns: Array<Column<InventoryAlert>> = [
    { key: 'name', header: 'Ingredient', cell: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'outlet', header: 'Outlet', cell: (r) => r.outlet },
    { key: 'qty', header: 'In stock', align: 'right', cell: (r) => `${r.quantity} ${r.unit}` },
    { key: 'threshold', header: 'Alert level', align: 'right', cell: (r) => `${r.threshold} ${r.unit}` },
    {
      key: 'state',
      header: 'State',
      cell: (r) =>
        Number(r.quantity) <= 0 ? (
          <Badge tone="bad">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Out of stock
          </Badge>
        ) : (
          <Badge tone="warn">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Low
          </Badge>
        ),
    },
  ];
  return (
    <TableCard title="Inventory alerts" subtitle="Ingredients at or below their alert level right now (not affected by the date range)">
      <DataTable
        columns={columns}
        rows={data.inventoryAlerts}
        rowKey={(r) => `${r.outletId}:${r.ingredientId}`}
        empty={<EmptyState title="No low stock" description="Every ingredient with an alert level is above it in the selected outlets." icon={<CheckCircle2 className="h-6 w-6" aria-hidden />} />}
      />
    </TableCard>
  );
}
