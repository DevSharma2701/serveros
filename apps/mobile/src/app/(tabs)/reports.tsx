import { Text } from 'react-native';
import { DateRangeFilter, OutletFilter, useReportFilters } from '../../components/filters';
import { BarRow, Card, Empty, ErrorState, KeyValue, Loading, NoAccess, Notice, ScreenScroll, SectionTitle, styles as ui } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { hourLabel, money, shortDay, titleCase } from '../../lib/format';
import { useDashboard } from '../../lib/queries';

const max = (values: number[]): number => Math.max(1, ...values);

/**
 * Sales reports: trends, payment methods and top products. Bars are scaled against the largest
 * value in each list; all numbers are the API's, nothing is estimated on the device.
 */
export default function ReportsScreen() {
  const { me, can } = useAuth();
  const { range, outletIds } = useReportFilters();
  const allowed = can('report.view');
  const query = useDashboard({ from: range.from, to: range.to, outletIds }, allowed);
  const currency = me?.restaurant?.currency ?? 'INR';
  const d = query.data;

  if (!allowed) {
    return (
      <ScreenScroll refreshing={false} onRefresh={() => undefined}>
        <NoAccess feature="sales reports" />
      </ScreenScroll>
    );
  }

  const multiDay = range.from !== range.to;
  const nothingSold = !!d && d.summary.orders === 0 && d.paymentsByMethod.length === 0;

  return (
    <ScreenScroll testID="reports" refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
      <DateRangeFilter />
      <OutletFilter />
      {query.isPending ? (
        <Loading label="Loading sales" />
      ) : query.isError && !d ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} feature="sales reports" />
      ) : d ? (
        <>
          {query.isError ? <Notice text={`Could not refresh: ${errorMessage(query.error)}`} /> : null}
          <Card>
            <SectionTitle>Summary</SectionTitle>
            <KeyValue label="Gross sales" value={money(d.summary.grossSalesMinor, currency)} />
            <KeyValue label="Discounts" value={`-${money(d.summary.discountsMinor, currency)}`} />
            <KeyValue label="Service charge" value={money(d.summary.serviceChargeMinor, currency)} />
            <KeyValue label="Delivery charge" value={money(d.summary.deliveryChargeMinor, currency)} />
            <KeyValue label="Net sales" value={money(d.summary.netSalesMinor, currency)} strong />
            <KeyValue label="Taxes" value={money(d.summary.taxesMinor, currency)} />
            <KeyValue label="Round-off" value={money(d.summary.roundOffMinor, currency)} />
            <KeyValue label="Total billed" value={money(d.summary.totalBilledMinor, currency)} strong />
            <KeyValue label="Collected" value={money(d.summary.collectedMinor, currency)} />
            <KeyValue label="Refunds" value={`-${money(d.summary.refundsMinor, currency)}`} />
            <KeyValue label="Net collected" value={money(d.summary.netCollectedMinor, currency)} strong />
          </Card>

          {nothingSold ? (
            <Empty icon="bar-chart-outline" title="No sales in this period" body="Pick another date range or outlet." />
          ) : (
            <>
              {multiDay ? (
                <Card>
                  <SectionTitle hint="Total billed per day (days with sales)">Daily trend</SectionTitle>
                  {d.daily.length === 0 ? <Text style={ui.sectionHint}>No completed orders.</Text> : null}
                  {d.daily.map((row) => (
                    <BarRow key={row.day} label={shortDay(row.day)} value={money(row.totalMinor, currency)} fraction={row.totalMinor / max(d.daily.map((x) => x.totalMinor))} sublabel={`${row.orders} orders`} />
                  ))}
                </Card>
              ) : null}

              <Card>
                <SectionTitle hint="Total billed by hour of completion (outlet time)">Hourly trend</SectionTitle>
                {d.hourly.length === 0 ? <Text style={ui.sectionHint}>No completed orders.</Text> : null}
                {d.hourly.map((row) => (
                  <BarRow key={row.hour} label={hourLabel(row.hour)} value={money(row.totalMinor, currency)} fraction={row.totalMinor / max(d.hourly.map((x) => x.totalMinor))} sublabel={`${row.orders} orders`} />
                ))}
              </Card>

              <Card>
                <SectionTitle hint="Payments received in the period">Payment methods</SectionTitle>
                {d.paymentsByMethod.length === 0 ? <Text style={ui.sectionHint}>No payments.</Text> : null}
                {d.paymentsByMethod.map((row) => (
                  <BarRow
                    key={row.method}
                    label={row.method === 'UPI' ? 'UPI' : titleCase(row.method)}
                    value={money(row.amountMinor, currency)}
                    fraction={row.amountMinor / max(d.paymentsByMethod.map((x) => x.amountMinor))}
                    sublabel={`${row.count} payment${row.count === 1 ? '' : 's'}${row.refundedMinor ? ` · ${money(row.refundedMinor, currency)} refunded` : ''}`}
                  />
                ))}
              </Card>

              <Card>
                <SectionTitle>Order types</SectionTitle>
                {d.salesByType.map((row) => (
                  <BarRow key={row.type} label={titleCase(row.type)} value={money(row.totalMinor, currency)} fraction={row.totalMinor / max(d.salesByType.map((x) => x.totalMinor))} sublabel={`${row.orders} orders`} />
                ))}
              </Card>

              <Card>
                <SectionTitle hint="By quantity sold; value is net sales">Top products</SectionTitle>
                {d.topProducts.length === 0 ? <Text style={ui.sectionHint}>No items sold.</Text> : null}
                {d.topProducts.map((row, index) => (
                  <BarRow key={row.productId} label={`${index + 1}. ${row.name}`} value={`${row.quantity} sold`} fraction={row.quantity / max(d.topProducts.map((x) => x.quantity))} sublabel={money(row.netSalesMinor, currency)} />
                ))}
              </Card>

              <Card>
                <SectionTitle hint="Net sales">Categories</SectionTitle>
                {d.categories.map((row) => (
                  <BarRow key={row.name} label={row.name} value={money(row.netSalesMinor, currency)} fraction={row.netSalesMinor / max(d.categories.map((x) => x.netSalesMinor))} sublabel={`${row.quantity} items`} />
                ))}
              </Card>
            </>
          )}

          <Card>
            <SectionTitle>How these numbers are calculated</SectionTitle>
            {Object.entries(d.definitions).map(([key, text]) => (
              <Text key={key} style={ui.rowSubtitle}>
                <Text style={{ fontWeight: '700' }}>{titleCase(key.replace(/([A-Z])/g, ' $1'))}: </Text>
                {text}
              </Text>
            ))}
          </Card>
        </>
      ) : null}
    </ScreenScroll>
  );
}
