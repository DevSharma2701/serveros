import { useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, quantity } from '../lib/format';
import { useStock } from '../lib/queries';
import type { StockRow } from '../lib/types';
import { colors, radius, space, TOUCH } from '../theme';
import { Badge, Empty, ErrorState, Loading, NoAccess, Notice, refresher, StatGrid, StatTile } from './ui';

const isOut = (row: StockRow): boolean => Number(row.quantity) <= 0;

/**
 * Stock on hand for the selected outlet. `lowOnly` turns it into the low-stock alert list
 * (ingredients the API flags with isLow), worst first.
 */
export function StockList({ lowOnly }: { lowOnly: boolean }) {
  const { me, outlet, can } = useAuth();
  const allowed = can('inventory.view');
  const query = useStock(allowed);
  const [search, setSearch] = useState('');
  const currency = me?.restaurant?.currency ?? 'INR';

  if (!allowed) return <NoAccess feature="inventory" />;

  const rows = query.data ?? [];
  const low = rows.filter((r) => r.isLow);
  const term = search.trim().toLowerCase();
  const shown = (lowOnly ? low : rows)
    .filter((r) => !term || r.name.toLowerCase().includes(term) || r.sku.toLowerCase().includes(term))
    .sort((a, b) => (lowOnly ? ratio(a) - ratio(b) : Number(b.isLow) - Number(a.isLow)) || a.name.localeCompare(b.name));
  const totalValue = rows.reduce((sum, r) => sum + r.valueMinor, 0);

  return (
    <FlatList
      testID={lowOnly ? 'low-stock' : 'inventory'}
      style={styles.list}
      contentContainerStyle={styles.content}
      data={query.data ? shown : []}
      keyExtractor={(r) => r.ingredientId}
      keyboardShouldPersistTaps="handled"
      refreshControl={refresher(query.isRefetching, () => void query.refetch())}
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={styles.caption}>{outlet?.name}</Text>
          {query.isError && query.data ? <Notice text={`Could not refresh: ${errorMessage(query.error)}`} /> : null}
          {query.data ? (
            <>
              <StatGrid>
                {lowOnly ? (
                  <>
                    <StatTile label="Low or out" value={String(low.length)} tone={low.length ? 'warn' : 'ok'} />
                    <StatTile label="Out of stock" value={String(low.filter(isOut).length)} tone={low.some(isOut) ? 'bad' : 'ok'} />
                  </>
                ) : (
                  <>
                    <StatTile label="Ingredients" value={String(rows.length)} />
                    <StatTile label="Stock value" value={money(totalValue, currency)} hint="At current cost" />
                    <StatTile label="Low or out" value={String(low.length)} tone={low.length ? 'warn' : 'ok'} />
                  </>
                )}
              </StatGrid>
              <TextInput
                accessibilityLabel="Search ingredients"
                placeholder="Search ingredients"
                placeholderTextColor={colors.inkFaint}
                value={search}
                onChangeText={setSearch}
                autoCorrect={false}
                clearButtonMode="while-editing"
                style={styles.search}
              />
            </>
          ) : null}
        </View>
      }
      renderItem={({ item }) => {
        const out = isOut(item);
        const hasThreshold = Number(item.lowStockThreshold) > 0;
        return (
          <View
            style={styles.row}
            accessible
            accessibilityLabel={`${item.name}: ${quantity(item.quantity)} ${item.unit}${out ? ', out of stock' : item.isLow ? ', low stock' : ''}${hasThreshold ? `, alert level ${quantity(item.lowStockThreshold)} ${item.unit}` : ''}`}>
            <View style={styles.rowText}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.sub}>
                {hasThreshold ? `Alert at ${quantity(item.lowStockThreshold)} ${item.unit}` : 'No alert level set'}
                {lowOnly ? '' : ` · ${money(item.valueMinor, currency)}`}
              </Text>
            </View>
            <View style={styles.right}>
              <Text style={[styles.qty, out ? { color: colors.bad } : item.isLow ? { color: colors.warn } : null]}>
                {quantity(item.quantity)} {item.unit}
              </Text>
              {out ? <Badge label="Out" tone="bad" /> : item.isLow ? <Badge label="Low" tone="warn" /> : null}
            </View>
          </View>
        );
      }}
      ListEmptyComponent={
        query.isPending ? (
          <Loading label="Loading stock" />
        ) : query.isError && !query.data ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} feature="inventory" />
        ) : term ? (
          <Empty title="No ingredients match" body="Clear the search to see everything." />
        ) : lowOnly ? (
          <Empty icon="checkmark-circle-outline" title="Nothing is running low" body="Every ingredient with an alert level is above it." />
        ) : (
          <Empty icon="cube-outline" title="No ingredients yet" body="Ingredients are set up in the back office." />
        )
      }
    />
  );
}

/** How far below its alert level an ingredient is (0 = empty, 1 = exactly at the level). */
function ratio(row: StockRow): number {
  const threshold = Number(row.lowStockThreshold);
  return threshold > 0 ? Number(row.quantity) / threshold : 1;
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.canvas },
  content: { paddingBottom: space.xxl },
  header: { padding: space.lg, gap: space.md },
  caption: { fontSize: 13, color: colors.inkSoft },
  search: { minHeight: TOUCH + 4, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: radius.control, paddingHorizontal: space.md, fontSize: 16, color: colors.ink, backgroundColor: colors.surface },
  row: { minHeight: TOUCH + 12, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowText: { flex: 1, gap: 2 },
  name: { fontSize: 16, color: colors.ink, fontWeight: '500' },
  sub: { fontSize: 13, color: colors.inkSoft },
  right: { alignItems: 'flex-end', gap: 4 },
  qty: { fontSize: 15, fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'] },
});
