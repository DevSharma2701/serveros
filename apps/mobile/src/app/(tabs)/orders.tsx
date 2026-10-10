import type { OrderStatus } from '@serveos/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { OrderStatusBadge, orderTypeLabel, PaymentStatusBadge } from '../../components/order-bits';
import { Chip, ChipRow, Empty, ErrorState, Loading, NoAccess, Notice, refresher } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { LONG_OPEN_MINUTES } from '../../lib/feed';
import { ageLabel, minutesSince, money, timeOnly, titleCase } from '../../lib/format';
import { LIVE_STATUSES, useLiveOrders } from '../../lib/queries';
import { useRealtimeConnected } from '../../lib/realtime';
import type { OrderSummary } from '../../lib/types';
import { colors, radius, space, TOUCH } from '../../theme';

type Filter = 'ALL' | OrderStatus;

/** Orders the kitchen currently has. Refreshes on realtime events; polls while the socket is down. */
export default function LiveOrdersScreen() {
  const router = useRouter();
  const { me, outlet, can } = useAuth();
  const allowed = can('order.view');
  const live = useRealtimeConnected();
  const query = useLiveOrders(allowed, { pollMs: live ? false : 30_000 });
  const [filter, setFilter] = useState<Filter>('ALL');
  const currency = me?.restaurant?.currency ?? 'INR';

  if (!allowed) return <NoAccess feature="orders" />;

  const all = query.data?.items ?? [];
  const shown = filter === 'ALL' ? all : all.filter((o) => o.status === filter);
  const count = (status: OrderStatus) => all.filter((o) => o.status === status).length;

  const renderItem = ({ item }: { item: OrderSummary }) => {
    const minutes = minutesSince(item.placedAt ?? item.createdAt);
    const late = minutes >= LONG_OPEN_MINUTES;
    return (
      <Pressable
        testID={`order-${item.orderNumber}`}
        accessibilityRole="button"
        accessibilityLabel={`Order ${item.orderNumber}, ${titleCase(item.status)}, ${orderTypeLabel(item.type)}${item.tableLabel ? `, table ${item.tableLabel}` : ''}, ${money(item.totalMinor, currency)}, open for ${ageLabel(minutes)}`}
        accessibilityHint="Opens the order details"
        onPress={() => router.push(`/orders/${item.id}`)}
        style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}>
        <View style={styles.cardHead}>
          <Text style={styles.number}>#{item.orderNumber}</Text>
          <OrderStatusBadge status={item.status} />
        </View>
        <Text style={styles.meta}>
          {orderTypeLabel(item.type)}
          {item.tableLabel ? ` · Table ${item.tableLabel}` : ''}
          {item.customer ? ` · ${item.customer.name}` : ''} · {item._count.items} item{item._count.items === 1 ? '' : 's'}
        </Text>
        <View style={styles.cardFoot}>
          <Text style={[styles.age, late && { color: colors.bad }]}>
            {timeOnly(item.placedAt ?? item.createdAt, outlet?.timezone)} · open {ageLabel(minutes)}
          </Text>
          <View style={styles.totalBox}>
            <PaymentStatusBadge status={item.paymentStatus} />
            <Text style={styles.total}>{money(item.totalMinor, currency)}</Text>
          </View>
        </View>
      </Pressable>
    );
  };

  return (
    <FlatList
      testID="live-orders"
      style={styles.list}
      contentContainerStyle={styles.content}
      data={query.isPending || (query.isError && !query.data) ? [] : shown}
      keyExtractor={(o) => o.id}
      renderItem={renderItem}
      refreshControl={refresher(query.isRefetching, () => void query.refetch())}
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.liveRow} accessible accessibilityLabel={live ? 'Live updates connected' : 'Live updates reconnecting, refreshing every 30 seconds'}>
            <View style={[styles.dot, { backgroundColor: live ? colors.ok : colors.warn }]} />
            <Text style={styles.liveText}>{live ? 'Live' : 'Reconnecting · refreshing every 30 s'}</Text>
            {query.data && query.data.total > all.length ? <Text style={styles.liveText}> · showing {all.length} of {query.data.total}</Text> : null}
          </View>
          <ChipRow>
            <Chip label={`All (${all.length})`} selected={filter === 'ALL'} onPress={() => setFilter('ALL')} />
            {LIVE_STATUSES.map((s) => (
              <Chip key={s} label={`${titleCase(s)} (${count(s)})`} selected={filter === s} onPress={() => setFilter(s)} />
            ))}
          </ChipRow>
          {query.isError && query.data ? <Notice text={`Could not refresh: ${errorMessage(query.error)}`} /> : null}
        </View>
      }
      ListEmptyComponent={
        query.isPending ? (
          <Loading label="Loading orders" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} feature="orders" />
        ) : (
          <Empty icon="receipt-outline" title={filter === 'ALL' ? 'No open orders' : `No ${titleCase(filter).toLowerCase()} orders`} body="Orders appear here as soon as they are sent to the kitchen." />
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.canvas },
  content: { padding: space.lg, gap: space.md, paddingBottom: space.xxl },
  header: { gap: space.md },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  liveText: { fontSize: 13, color: colors.inkSoft },
  card: { minHeight: TOUCH, backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.sm },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  number: { fontSize: 17, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] },
  meta: { fontSize: 14, color: colors.inkSoft },
  cardFoot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm },
  age: { fontSize: 13, color: colors.inkSoft, flexShrink: 1 },
  totalBox: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  total: { fontSize: 16, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] },
});
