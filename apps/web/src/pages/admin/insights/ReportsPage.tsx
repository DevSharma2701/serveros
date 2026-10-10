import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, Info } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button, Card, Checkbox, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Segmented, Skeleton, cn, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth, useOutlet } from '@/lib/auth';
import { money } from '@/lib/format';
import { KpiTiles } from './components/KpiTiles';
import { CashShifts, InventoryAlerts, OutletComparison } from './components/OperationsSections';
import { Categories, DailyTrend, HourlyTrend, OrderTypes, PaymentMethods, TopProducts } from './components/SalesSections';
import { RANGE_PRESETS, presetRange, rangeProblem, shortDay, type DateRange, type RangePreset } from './dateRange';
import type { DashboardResponse, ExportDataset } from './types';

const EXPORTS: Array<{ dataset: ExportDataset; label: string }> = [
  { dataset: 'orders', label: 'Orders' },
  { dataset: 'items', label: 'Items' },
  { dataset: 'payments', label: 'Payments' },
];

function saveCsv(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function LoadingDashboard() {
  return (
    <div role="status" aria-label="Loading report" className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-card" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-72 rounded-card" />
        <Skeleton className="h-72 rounded-card" />
      </div>
    </div>
  );
}

export function ReportsPage() {
  const { me, can } = useAuth();
  const outlet = useOutlet();
  const notify = useToast();
  const currency = me?.restaurant?.currency ?? 'INR';
  const outlets = me?.outlets ?? [];

  const [preset, setPreset] = useState<RangePreset>('today');
  const [custom, setCustom] = useState<DateRange>(() => presetRange('last7', outlet.timezone));
  const [outletIds, setOutletIds] = useState<string[]>([outlet.id]);
  const [exporting, setExporting] = useState<ExportDataset | null>(null);

  // Preset dates follow the wall clock of the outlet being worked in, not of this computer.
  const range = preset === 'custom' ? custom : presetRange(preset, outlet.timezone);
  const problem = rangeProblem(range);
  const outletParam = useMemo(() => [...outletIds].sort().join(','), [outletIds]);

  const query = useQuery({
    queryKey: ['dashboard', range.from, range.to, outletParam],
    queryFn: () => api<DashboardResponse>('/reports/dashboard', { query: { from: range.from, to: range.to, outletIds: outletParam } }),
    enabled: !problem && outletIds.length > 0,
    // Changing a filter keeps the previous figures on screen (dimmed) instead of flashing a skeleton.
    placeholderData: keepPreviousData,
  });
  const data = query.data;

  const formatMoney = (minor: number) => money(minor, currency);
  const axisFormat = useMemo(() => new Intl.NumberFormat('en-IN', { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }), [currency]);
  const formatAxis = (minor: number) => axisFormat.format(minor / 100);

  const toggleOutlet = (id: string, checked: boolean) => setOutletIds((ids) => (checked ? [...new Set([...ids, id])] : ids.filter((x) => x !== id)));

  const exportCsv = async (dataset: ExportDataset) => {
    setExporting(dataset);
    try {
      const text = await api<string>('/reports/export.csv', { query: { from: range.from, to: range.to, outletIds: outletParam, dataset }, asText: true });
      saveCsv(text, `serveos-${dataset}-${range.from}-to-${range.to}.csv`);
      notify(`${EXPORTS.find((e) => e.dataset === dataset)?.label} export downloaded`);
    } catch (err) {
      notify(errorMessage(err), 'bad');
    } finally {
      setExporting(null);
    }
  };

  const noSales = data ? data.summary.orders === 0 && data.summary.collectedMinor === 0 && data.summary.refundsMinor === 0 : false;
  const sectionProps = data ? { data, formatMoney, formatAxis } : null;

  return (
    <div>
      <PageHeader
        title="Reports"
        description="Sales, payments and operations for the period and outlets you choose."
        actions={
          can('report.export') ? (
            <div role="group" aria-label="Export to CSV" className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-ink-soft">Export CSV</span>
              {EXPORTS.map((e) => (
                <Button key={e.dataset} size="sm" loading={exporting === e.dataset} disabled={Boolean(problem) || outletIds.length === 0 || exporting !== null} onClick={() => void exportCsv(e.dataset)} aria-label={`Export ${e.label.toLowerCase()} to CSV`}>
                  {exporting === e.dataset ? null : <Download className="h-4 w-4" aria-hidden />}
                  {e.label}
                </Button>
              ))}
            </div>
          ) : undefined
        }
      />

      {/* One filter row above everything it scopes. */}
      <Card className="mb-4 flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="max-w-full overflow-x-auto">
            <Segmented label="Date range" value={preset} onChange={setPreset} options={RANGE_PRESETS} className="[&>button]:whitespace-nowrap" />
          </div>
          {preset === 'custom' ? (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="From" className="w-40">
                {(p) => <Input {...p} type="date" value={custom.from} max={custom.to || undefined} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />}
              </Field>
              <Field label="To" className="w-40">
                {(p) => <Input {...p} type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />}
              </Field>
            </div>
          ) : null}
        </div>
        {outlets.length > 1 ? (
          <fieldset className="flex flex-wrap items-center gap-x-5 gap-y-0">
            <legend className="sr-only">Outlets</legend>
            <span aria-hidden className="text-sm font-medium text-ink">
              Outlets
            </span>
            {outlets.map((o) => (
              <Checkbox key={o.id} label={o.name} checked={outletIds.includes(o.id)} onChange={(e) => toggleOutlet(o.id, e.target.checked)} />
            ))}
          </fieldset>
        ) : null}
        <p className="text-sm text-ink-soft">
          {problem ? null : range.from === range.to ? shortDay(range.from) : `${shortDay(range.from)} to ${shortDay(range.to)}`}
          {problem ? null : ` · dates in ${outlet.timezone} time`}
        </p>
        {problem ? <Notice tone="warn">{problem}</Notice> : null}
        {outletIds.length === 0 ? <Notice tone="warn">Choose at least one outlet.</Notice> : null}
      </Card>

      {problem || outletIds.length === 0 ? null : query.isError && !data ? (
        <Card>
          <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        </Card>
      ) : !data || !sectionProps ? (
        <LoadingDashboard />
      ) : (
        <div className={cn('flex flex-col gap-4 transition-opacity', query.isPlaceholderData && 'opacity-60')} aria-busy={query.isFetching || undefined}>
          {query.isError ? (
            <Notice tone="bad" title="Could not refresh">
              {errorMessage(query.error)} The figures below are from the last successful load.
            </Notice>
          ) : null}
          {data.definitions.scope ? (
            <p className="flex items-start gap-2 text-sm text-ink-soft">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{data.definitions.scope}</span>
            </p>
          ) : null}

          <KpiTiles data={data} currency={currency} />

          {noSales ? (
            <Card>
              <EmptyState title="No sales in this period" description="No orders were completed and no payments or refunds were recorded for the dates and outlets selected. Try a wider date range." />
            </Card>
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <DailyTrend {...sectionProps} />
                <HourlyTrend {...sectionProps} />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <PaymentMethods {...sectionProps} />
                <OrderTypes {...sectionProps} />
                <TopProducts {...sectionProps} />
                <Categories {...sectionProps} />
              </div>
            </>
          )}

          <OutletComparison data={data} formatMoney={formatMoney} />
          <CashShifts data={data} formatMoney={formatMoney} timeZone={outlet.timezone} />
          <InventoryAlerts data={data} />
        </div>
      )}
    </div>
  );
}
