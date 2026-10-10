import { useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { Badge, Chip, ChipRow, Empty, ErrorState, Loading, NoAccess, Notice, refresher } from '../components/ui';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ageLabel, dateTime, money, titleCase } from '../lib/format';
import { useAttendance, useAuditEvents } from '../lib/queries';
import type { Attendance, AuditEvent } from '../lib/types';
import { colors, space, TOUCH } from '../theme';

type Tab = 'audit' | 'attendance';

/** A short, honest description of the audit metadata: only simple values, money formatted. */
function describe(metadata: AuditEvent['metadata'], currency: string): string {
  if (!metadata) return '';
  return Object.entries(metadata)
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) && v !== '')
    .slice(0, 4)
    .map(([k, v]) => `${titleCase(k.replace(/Minor$/, '').replace(/([A-Z])/g, ' $1')).toLowerCase()}: ${k.endsWith('Minor') && typeof v === 'number' ? money(v, currency) : String(v)}`)
    .join(' · ');
}

/** Staff activity: the audit log (needs audit.view) and attendance in the selected outlet. */
export default function StaffActivityScreen() {
  const { me, outlet, can } = useAuth();
  const canAudit = can('audit.view');
  const [tab, setTab] = useState<Tab>(canAudit ? 'audit' : 'attendance');
  const audit = useAuditEvents(canAudit && tab === 'audit');
  const attendance = useAttendance(tab === 'attendance');
  const currency = me?.restaurant?.currency ?? 'INR';
  const tz = outlet?.timezone;
  const outletName = (id: string | null) => me?.outlets.find((o) => o.id === id)?.name;

  const header = (
    <View style={styles.header}>
      <ChipRow>
        <Chip label="Audit log" selected={tab === 'audit'} onPress={() => setTab('audit')} />
        <Chip label="Attendance" selected={tab === 'attendance'} onPress={() => setTab('attendance')} />
      </ChipRow>
      {tab === 'attendance' ? <Text style={styles.caption}>{outlet?.name} · {can('staff.view') ? 'all staff' : 'your own records'}</Text> : <Text style={styles.caption}>Whole restaurant, newest first</Text>}
    </View>
  );

  if (tab === 'audit') {
    if (!canAudit) {
      return (
        <View style={styles.list}>
          {header}
          <NoAccess feature="the audit log" />
        </View>
      );
    }
    const events = audit.data?.pages.flatMap((p) => p.items) ?? [];
    return (
      <FlatList
        testID="audit-list"
        style={styles.list}
        contentContainerStyle={styles.content}
        data={events}
        keyExtractor={(e) => e.id}
        refreshControl={refresher(audit.isRefetching && !audit.isFetchingNextPage, () => void audit.refetch())}
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (audit.hasNextPage && !audit.isFetchingNextPage) void audit.fetchNextPage();
        }}
        ListHeaderComponent={
          <>
            {header}
            {audit.isError && audit.data ? <Notice text={`Could not refresh: ${errorMessage(audit.error)}`} /> : null}
          </>
        }
        renderItem={({ item }: { item: AuditEvent }) => {
          const detail = describe(item.metadata, currency);
          return (
            <View style={styles.row} accessible accessibilityLabel={`${item.actorName || 'System'}: ${titleCase(item.action)}, ${dateTime(item.createdAt, tz)}`}>
              <View style={styles.rowHead}>
                <Text style={styles.title}>{titleCase(item.action)}</Text>
                <Text style={styles.time}>{dateTime(item.createdAt, tz)}</Text>
              </View>
              <Text style={styles.sub}>
                {item.actorName || 'System'}
                {outletName(item.outletId) ? ` · ${outletName(item.outletId)}` : ''} · {item.entityType}
              </Text>
              {detail ? <Text style={styles.detail}>{detail}</Text> : null}
            </View>
          );
        }}
        ListEmptyComponent={
          audit.isPending ? <Loading label="Loading activity" /> : audit.isError ? <ErrorState error={audit.error} onRetry={() => void audit.refetch()} feature="the audit log" /> : <Empty icon="people-outline" title="No activity recorded yet" />
        }
        ListFooterComponent={audit.isFetchingNextPage ? <Loading label="Loading more" /> : events.length > 0 && !audit.hasNextPage ? <Text style={styles.end}>End of the log · {events.length} events</Text> : null}
      />
    );
  }

  return (
    <FlatList
      testID="attendance-list"
      style={styles.list}
      contentContainerStyle={styles.content}
      data={attendance.data ?? []}
      keyExtractor={(a) => a.id}
      refreshControl={refresher(attendance.isRefetching, () => void attendance.refetch())}
      ListHeaderComponent={
        <>
          {header}
          {attendance.isError && attendance.data ? <Notice text={`Could not refresh: ${errorMessage(attendance.error)}`} /> : null}
        </>
      }
      renderItem={({ item }: { item: Attendance }) => {
        const minutes = Math.max(0, Math.floor(((item.clockOutAt ? Date.parse(item.clockOutAt) : Date.now()) - Date.parse(item.clockInAt)) / 60_000));
        return (
          <View style={styles.row} accessible accessibilityLabel={`${item.user.name}, clocked in ${dateTime(item.clockInAt, tz)}, ${item.clockOutAt ? `clocked out ${dateTime(item.clockOutAt, tz)}` : 'still on shift'}`}>
            <View style={styles.rowHead}>
              <Text style={styles.title}>{item.user.name}</Text>
              {item.clockOutAt ? <Text style={styles.time}>{ageLabel(minutes)}</Text> : <Badge label="On shift" tone="ok" />}
            </View>
            <Text style={styles.sub}>
              In {dateTime(item.clockInAt, tz)}
              {item.clockOutAt ? ` · Out ${dateTime(item.clockOutAt, tz)}` : ` · ${ageLabel(minutes)} so far`}
            </Text>
          </View>
        );
      }}
      ListEmptyComponent={
        attendance.isPending ? (
          <Loading label="Loading attendance" />
        ) : attendance.isError ? (
          <ErrorState error={attendance.error} onRetry={() => void attendance.refetch()} feature="attendance" />
        ) : (
          <Empty icon="time-outline" title="No attendance records" body="Clock-ins made on the POS in this outlet appear here." />
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.canvas },
  content: { paddingBottom: space.xxl },
  header: { padding: space.lg, gap: space.sm },
  caption: { fontSize: 13, color: colors.inkSoft },
  row: { minHeight: TOUCH + 12, gap: 2, paddingHorizontal: space.lg, paddingVertical: space.md, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm },
  title: { fontSize: 15, fontWeight: '600', color: colors.ink, flexShrink: 1 },
  time: { fontSize: 12, color: colors.inkFaint },
  sub: { fontSize: 13, color: colors.inkSoft },
  detail: { fontSize: 12, color: colors.inkFaint },
  end: { textAlign: 'center', fontSize: 12, color: colors.inkFaint, padding: space.lg },
});
