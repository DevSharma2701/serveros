import { useRouter } from 'expo-router';
import { Text } from 'react-native';
import { DateRangeFilter, OutletFilter, useReportFilters } from '../../components/filters';
import { BarRow, Card, ErrorState, ListRow, Loading, NoAccess, Notice, ScreenScroll, SectionTitle, StatGrid, StatTile, styles as ui } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { money, signedMoney } from '../../lib/format';
import { useDashboard } from '../../lib/queries';

/** Key numbers for a date range and outlet filter. Every figure comes straight from /reports/dashboard. */
export default function DashboardScreen() {
  const router = useRouter();
  const { me, can } = useAuth();
  const { range, outletIds } = useReportFilters();
  const allowed = can('report.view');
  const query = useDashboard({ from: range.from, to: range.to, outletIds }, allowed);
  const currency = me?.restaurant?.currency ?? 'INR';
  const data = query.data;
  const s = data?.summary;

  return (
    <ScreenScroll testID="dashboard" refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
      {!allowed ? (
        <NoAccess feature="reports" body="Your role cannot view sales reports. Live orders and the tools under More are still available." />
      ) : (
        <>
          <DateRangeFilter />
          <OutletFilter />
          {query.isPending ? (
            <Loading label="Loading dashboard" />
          ) : query.isError && !data ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} feature="reports" />
          ) : data && s ? (
            <>
              {query.isError ? <Notice text={`Could not refresh: ${errorMessage(query.error)}`} /> : null}
              <StatGrid>
                <StatTile testID="stat-net-sales" label="Net sales" value={money(s.netSalesMinor, currency)} hint="After discounts, before tax" />
                <StatTile testID="stat-orders" label="Completed orders" value={String(s.orders)} />
                <StatTile label="Average order" value={money(s.averageOrderValueMinor, currency)} />
                <StatTile label="Total billed" value={money(s.totalBilledMinor, currency)} hint="Net sales + taxes" />
                <StatTile label="Collected" value={money(s.collectedMinor, currency)} />
                <StatTile label="Refunds" value={money(s.refundsMinor, currency)} tone={s.refundsMinor > 0 ? 'warn' : undefined} />
                <StatTile label="Discounts" value={money(s.discountsMinor, currency)} />
                <StatTile label="Taxes" value={money(s.taxesMinor, currency)} />
                <StatTile testID="stat-open-orders" label="Open orders now" value={String(s.openOrders)} tone={s.openOrders > 0 ? 'info' : undefined} />
                <StatTile label="Cancelled orders" value={String(s.cancelledOrders)} tone={s.cancelledOrders > 0 ? 'bad' : undefined} />
                <StatTile
                  testID="stat-cash-variance"
                  label="Cash variance"
                  value={signedMoney(s.cashVarianceMinor, currency)}
                  tone={s.cashVarianceMinor < 0 ? 'bad' : s.cashVarianceMinor > 0 ? 'warn' : 'ok'}
                  hint={`${data.cashShifts.length} shift${data.cashShifts.length === 1 ? '' : 's'} closed`}
                />
                <StatTile label="Low-stock items" value={String(data.inventoryAlerts.length)} tone={data.inventoryAlerts.length > 0 ? 'warn' : 'ok'} />
              </StatGrid>

              {data.outletComparison.length > 1 ? (
                <Card>
                  <SectionTitle hint="Net sales in the selected period">By outlet</SectionTitle>
                  {data.outletComparison.map((o) => (
                    <BarRow
                      key={o.outletId}
                      label={o.outlet}
                      value={money(o.netSalesMinor, currency)}
                      fraction={o.netSalesMinor / Math.max(1, ...data.outletComparison.map((x) => x.netSalesMinor))}
                      sublabel={`${o.orders} orders · ${o.cancelledOrders} cancelled`}
                    />
                  ))}
                </Card>
              ) : null}

              <Card style={{ padding: 0, overflow: 'hidden', gap: 0 }}>
                <ListRow icon="notifications-outline" title="Notifications" subtitle="Low stock, cash variance, cancelled and long-open orders" onPress={() => router.push('/notifications')} />
                <ListRow icon="bar-chart-outline" title="Sales reports" subtitle="Trends, payment methods and top products" onPress={() => router.push('/reports')} />
              </Card>
              {data.definitions.scope ? <Text style={ui.sectionHint}>{data.definitions.scope}</Text> : null}
            </>
          ) : null}
        </>
      )}
    </ScreenScroll>
  );
}
