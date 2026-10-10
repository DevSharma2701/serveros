import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter, type Href } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Empty, ErrorState, Loading, NoAccess, Notice, refresher, type IconName } from '../components/ui';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { buildFeed, LONG_OPEN_MINUTES, type FeedItem, type FeedKind } from '../lib/feed';
import { dateTime, dayIn } from '../lib/format';
import { pushDisabledReason } from '../lib/push';
import { useCancelledOrders, useDashboard, useLiveOrders } from '../lib/queries';
import { colors, radius, space, toneColors, TOUCH } from '../theme';

const ICONS: Record<FeedKind, IconName> = {
  'low-stock': 'warning-outline',
  'cash-variance': 'cash-outline',
  'cancelled-order': 'close-circle-outline',
  'long-open-order': 'time-outline',
};

/**
 * In-app feed for the selected outlet, computed from live API data each time it is opened or
 * refreshed. It is not push: nothing arrives while the app is closed, and nothing is stored.
 */
export default function NotificationsScreen() {
  const router = useRouter();
  const { me, outlet, can } = useAuth();
  const canReports = can('report.view');
  const canOrders = can('order.view');
  const today = dayIn(outlet?.timezone);

  const dashboard = useDashboard({ from: today, to: today, outletIds: outlet ? [outlet.id] : [] }, canReports);
  const live = useLiveOrders(canOrders);
  const cancelled = useCancelledOrders(today, canOrders);

  if (!canReports && !canOrders) return <NoAccess feature="notifications" body="Notifications are built from reports and orders, and your role can see neither." />;

  const sources = [...(canReports ? [dashboard] : []), ...(canOrders ? [live, cancelled] : [])];
  const loading = sources.some((q) => q.isPending);
  const failed = sources.filter((q) => q.isError);
  const allFailed = failed.length === sources.length;
  const refreshing = sources.some((q) => q.isRefetching);
  const refresh = () => sources.forEach((q) => void q.refetch());

  const items = buildFeed({
    inventoryAlerts: dashboard.data?.inventoryAlerts,
    cashShifts: dashboard.data?.cashShifts,
    cancelledOrders: cancelled.data?.items,
    liveOrders: live.data?.items,
    currency: me?.restaurant?.currency,
  });

  return (
    <FlatList
      testID="notifications"
      style={styles.list}
      contentContainerStyle={styles.content}
      data={loading || allFailed ? [] : items}
      keyExtractor={(i) => i.id}
      refreshControl={refresher(refreshing, refresh)}
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={styles.caption}>
            In-app feed for {outlet?.name}, today. Built from live data when you open or refresh this screen: low stock, cash variance on shifts closed today, today's orders that were cancelled after being sent to the kitchen, and orders open longer than {LONG_OPEN_MINUTES} minutes.
          </Text>
          <Text style={styles.caption}>Push notifications: off. {pushDisabledReason() ?? 'Configured, but this server has no push sender yet.'}</Text>
          {!canReports ? <Notice tone="info" text="Stock and cash alerts are hidden: your role cannot view reports." /> : null}
          {!canOrders ? <Notice tone="info" text="Order alerts are hidden: your role cannot view orders." /> : null}
          {!allFailed && failed.length > 0 ? <Notice text={`Some alerts could not be loaded: ${errorMessage(failed[0]!.error)}`} /> : null}
        </View>
      }
      renderItem={({ item }: { item: FeedItem }) => {
        const tone = toneColors[item.tone];
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.title}. ${item.body}`}
            accessibilityHint={item.href ? 'Opens the details' : undefined}
            disabled={!item.href}
            onPress={() => item.href && router.push(item.href as Href)}
            style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}>
            <View style={[styles.icon, { backgroundColor: tone.bg }]}>
              <Ionicons name={ICONS[item.kind]} size={20} color={tone.fg} />
            </View>
            <View style={styles.text}>
              <Text style={styles.title}>{item.title}</Text>
              <Text style={styles.body}>{item.body}</Text>
              {item.at ? <Text style={styles.time}>{dateTime(item.at, outlet?.timezone)}</Text> : null}
            </View>
          </Pressable>
        );
      }}
      ListEmptyComponent={
        loading ? (
          <Loading label="Checking for alerts" />
        ) : allFailed ? (
          <ErrorState error={failed[0]!.error} onRetry={refresh} feature="notifications" />
        ) : (
          <Empty icon="checkmark-circle-outline" title="All clear" body="Nothing needs your attention right now." />
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
  card: { minHeight: TOUCH + 12, flexDirection: 'row', gap: space.md, backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.line, padding: space.md, alignItems: 'flex-start' },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, gap: 2 },
  title: { fontSize: 15, fontWeight: '600', color: colors.ink },
  body: { fontSize: 13, color: colors.inkSoft },
  time: { fontSize: 12, color: colors.inkFaint },
});
