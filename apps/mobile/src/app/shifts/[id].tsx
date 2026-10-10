import { useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';
import { Badge, Card, ErrorState, KeyValue, Loading, NoAccess, Notice, ScreenScroll, SectionTitle, styles as ui } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, money, signedMoney, titleCase } from '../../lib/format';
import { useShift } from '../../lib/queries';

/** Reconciliation of one cash shift: expected vs counted cash, takings by method, cash movements. */
export default function ShiftDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me, outlet, can } = useAuth();
  const allowed = can('shift.operate');
  const query = useShift(id, allowed);
  const currency = me?.restaurant?.currency ?? 'INR';
  const tz = outlet?.timezone;
  const d = query.data;
  // Sales rows are one per cash payment; the summary above already totals them.
  const manual = d?.movements.filter((m) => m.type !== 'SALE') ?? [];

  return (
    <ScreenScroll testID="shift-detail" refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
      {!allowed ? (
        <NoAccess feature="cash shifts" />
      ) : query.isPending ? (
        <Loading label="Loading shift" />
      ) : query.isError && !d ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} feature="this shift" />
      ) : d ? (
        <>
          {query.isError ? <Notice text={`Could not refresh: ${errorMessage(query.error)}`} /> : null}
          <Card>
            <Badge label={d.shift.status === 'OPEN' ? 'Open' : 'Closed'} tone={d.shift.status === 'OPEN' ? 'ok' : 'neutral'} />
            <KeyValue label="Register" value={d.shift.register.name} />
            <KeyValue label="Opened by" value={d.shift.openedByName} />
            <KeyValue label="Opened" value={dateTime(d.shift.openedAt, tz)} />
            {d.shift.closedAt ? <KeyValue label="Closed" value={dateTime(d.shift.closedAt, tz)} /> : null}
            {d.shift.closeNote ? <KeyValue label="Closing note" value={d.shift.closeNote} /> : null}
          </Card>

          <Card>
            <SectionTitle>Cash reconciliation</SectionTitle>
            <KeyValue label="Opening float" value={money(d.cash.openingFloatMinor, currency)} />
            <KeyValue label="Cash sales" value={money(d.cash.salesMinor, currency)} />
            <KeyValue label="Cash refunds" value={`-${money(d.cash.refundsMinor, currency)}`} />
            <KeyValue label="Cash in" value={money(d.cash.cashInMinor, currency)} />
            <KeyValue label="Cash out" value={`-${money(d.cash.cashOutMinor, currency)}`} />
            <KeyValue label="Petty cash" value={`-${money(d.cash.pettyCashMinor, currency)}`} />
            <KeyValue label="Expected in drawer" value={money(d.cash.expectedCashMinor, currency)} strong />
            {d.shift.countedCashMinor !== null ? <KeyValue label="Counted" value={money(d.shift.countedCashMinor, currency)} strong /> : <Text style={ui.sectionHint}>Not counted yet: the shift is still open.</Text>}
            {d.shift.varianceMinor !== null ? (
              <KeyValue label="Variance" value={signedMoney(d.shift.varianceMinor, currency)} strong tone={d.shift.varianceMinor < 0 ? 'bad' : d.shift.varianceMinor > 0 ? 'warn' : 'ok'} />
            ) : null}
          </Card>

          <Card>
            <SectionTitle hint="All payment methods during this shift">Takings by method</SectionTitle>
            {d.byMethod.length === 0 ? <Text style={ui.sectionHint}>No payments during this shift.</Text> : null}
            {d.byMethod.map((m) => (
              <KeyValue key={m.method} label={`${m.method === 'UPI' ? 'UPI' : titleCase(m.method)} · ${m.count} payment${m.count === 1 ? '' : 's'}${m.refundedMinor ? ` · ${money(m.refundedMinor, currency)} refunded` : ''}`} value={money(m.netMinor, currency)} />
            ))}
          </Card>

          <Card>
            <SectionTitle hint="Cash in, cash out, petty cash and refunds (sales are totalled above)">Cash movements</SectionTitle>
            {manual.length === 0 ? <Text style={ui.sectionHint}>No manual cash movements.</Text> : null}
            {manual.map((m) => (
              <KeyValue key={m.id} label={`${titleCase(m.type)} · ${dateTime(m.createdAt, tz)}${m.reason ? ` · ${m.reason}` : ''}`} value={money(m.amountMinor, currency)} />
            ))}
          </Card>
        </>
      ) : null}
    </ScreenScroll>
  );
}
