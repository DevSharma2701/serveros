import { useRouter } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Badge, Empty, ErrorState, Loading, NoAccess, Notice, refresher } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, money, signedMoney } from '../../lib/format';
import { useShifts } from '../../lib/queries';
import { colors, radius, space, TOUCH } from '../../theme';

/** Cash shifts in the selected outlet. People with shift.view_all see everyone's; others see their own. */
export default function ShiftsScreen() {
  const router = useRouter();
  const { me, outlet, can } = useAuth();
  const allowed = can('shift.operate');
  const query = useShifts(allowed);
  const currency = me?.restaurant?.currency ?? 'INR';

  if (!allowed) return <NoAccess feature="cash shifts" />;

  return (
    <FlatList
      testID="shifts"
      style={styles.list}
      contentContainerStyle={styles.content}
      data={query.data ?? []}
      keyExtractor={(s) => s.id}
      refreshControl={refresher(query.isRefetching, () => void query.refetch())}
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={styles.caption}>
            {outlet?.name} · {can('shift.view_all') ? 'all staff' : 'your shifts only'}
          </Text>
          {query.isError && query.data ? <Notice text={`Could not refresh: ${errorMessage(query.error)}`} /> : null}
        </View>
      }
      renderItem={({ item }) => {
        const variance = item.varianceMinor ?? 0;
        const open = item.status === 'OPEN';
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.register.name}, opened by ${item.openedByName} on ${dateTime(item.openedAt, outlet?.timezone)}, ${open ? 'still open' : `closed, variance ${signedMoney(variance, currency)}`}`}
            accessibilityHint="Opens the shift reconciliation"
            onPress={() => router.push(`/shifts/${item.id}`)}
            style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}>
            <View style={styles.cardHead}>
              <Text style={styles.title}>{item.register.name}</Text>
              <Badge label={open ? 'Open' : 'Closed'} tone={open ? 'ok' : 'neutral'} />
            </View>
            <Text style={styles.meta}>
              {item.openedByName} · {dateTime(item.openedAt, outlet?.timezone)}
              {item.closedAt ? ` → ${dateTime(item.closedAt, outlet?.timezone)}` : ''}
            </Text>
            <View style={styles.cardHead}>
              <Text style={styles.meta}>Float {money(item.openingFloatMinor, currency)}</Text>
              {open ? null : (
                <Text style={[styles.variance, { color: variance < 0 ? colors.bad : variance > 0 ? colors.warn : colors.ok }]}>Variance {signedMoney(variance, currency)}</Text>
              )}
            </View>
          </Pressable>
        );
      }}
      ListEmptyComponent={
        query.isPending ? (
          <Loading label="Loading shifts" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} feature="cash shifts" />
        ) : (
          <Empty icon="cash-outline" title="No shifts yet" body="Shifts opened on the POS in this outlet appear here." />
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.canvas },
  content: { padding: space.lg, gap: space.md, paddingBottom: space.xxl },
  header: { gap: space.sm },
  caption: { fontSize: 13, color: colors.inkSoft },
  card: { minHeight: TOUCH, backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.sm },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm },
  title: { fontSize: 16, fontWeight: '700', color: colors.ink },
  meta: { fontSize: 13, color: colors.inkSoft, flexShrink: 1 },
  variance: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
