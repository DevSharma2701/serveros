import { useMemo, useState } from 'react';
import { SectionList, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Badge, Chip, ChipRow, Empty, ErrorState, Loading, NoAccess, Notice, refresher } from '../components/ui';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money } from '../lib/format';
import { useCatalog, useSetAvailability } from '../lib/queries';
import type { CatalogProduct } from '../lib/types';
import { colors, radius, space, TOUCH } from '../theme';

/** Mark products available / sold out in the selected outlet. Viewing needs menu.view; changing needs menu.availability. */
export default function AvailabilityScreen() {
  const { me, outlet, can } = useAuth();
  const canView = can('menu.view');
  const canToggle = can('menu.availability');
  const query = useCatalog(canView);
  const mutation = useSetAvailability();
  const [search, setSearch] = useState('');
  const [onlyOff, setOnlyOff] = useState(false);
  const currency = me?.restaurant?.currency ?? 'INR';

  const sections = useMemo(() => {
    const catalog = query.data;
    if (!catalog) return [];
    const term = search.trim().toLowerCase();
    const matches = (p: CatalogProduct) => (!term || p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term)) && (!onlyOff || !p.isAvailable);
    return [...catalog.categories]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((c) => ({ title: c.name, data: catalog.products.filter((p) => p.categoryId === c.id && matches(p)).sort((a, b) => a.name.localeCompare(b.name)) }))
      .filter((s) => s.data.length > 0);
  }, [query.data, search, onlyOff]);

  if (!canView) return <NoAccess feature="the menu" />;

  const unavailable = query.data?.products.filter((p) => !p.isAvailable).length ?? 0;
  const pendingId = mutation.isPending ? mutation.variables?.productId : undefined;

  return (
    <SectionList
      testID="availability"
      style={styles.list}
      contentContainerStyle={styles.content}
      sections={query.data ? sections : []}
      keyExtractor={(p) => p.id}
      stickySectionHeadersEnabled={false}
      keyboardShouldPersistTaps="handled"
      refreshControl={refresher(query.isRefetching, () => void query.refetch())}
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={styles.caption}>
            {outlet?.name} · {unavailable} unavailable
          </Text>
          {!canToggle ? <Notice tone="info" text="You can see availability but your role cannot change it." /> : null}
          {mutation.isError ? <Notice text={`Could not update: ${errorMessage(mutation.error)}`} /> : null}
          {query.isError && query.data ? <Notice text={`Could not refresh: ${errorMessage(query.error)}`} /> : null}
          <TextInput
            accessibilityLabel="Search products"
            placeholder="Search products"
            placeholderTextColor={colors.inkFaint}
            value={search}
            onChangeText={setSearch}
            autoCorrect={false}
            clearButtonMode="while-editing"
            style={styles.search}
          />
          <ChipRow>
            <Chip label="All products" selected={!onlyOff} onPress={() => setOnlyOff(false)} />
            <Chip label={`Unavailable (${unavailable})`} selected={onlyOff} onPress={() => setOnlyOff(true)} />
          </ChipRow>
        </View>
      }
      renderSectionHeader={({ section }) => <Text style={styles.section}>{section.title}</Text>}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.name}>{item.name}</Text>
            <Text style={styles.sub}>
              {item.sku}
              {item.variants[0] ? ` · ${money((item.variants.find((v) => v.isDefault) ?? item.variants[0]).priceMinor, currency)}` : ''}
            </Text>
          </View>
          {!item.isAvailable ? <Badge label="Unavailable" tone="bad" /> : null}
          <View style={styles.switchBox}>
            <Switch
              testID={`availability-${item.sku}`}
              accessibilityLabel={`${item.name} available`}
              accessibilityHint={canToggle ? 'Double tap to change availability in this outlet' : 'Your role cannot change availability'}
              value={item.isAvailable}
              disabled={!canToggle || pendingId === item.id}
              onValueChange={(isAvailable) => mutation.mutate({ productId: item.id, isAvailable })}
              trackColor={{ true: colors.ok, false: colors.lineStrong }}
            />
          </View>
        </View>
      )}
      ListEmptyComponent={
        query.isPending ? (
          <Loading label="Loading menu" />
        ) : query.isError && !query.data ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} feature="the menu" />
        ) : (
          <Empty icon="fast-food-outline" title={search || onlyOff ? 'No products match' : 'No products yet'} body={search || onlyOff ? 'Clear the search or filter to see everything.' : 'Products are created in the back office.'} />
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.canvas },
  content: { paddingBottom: space.xxl },
  header: { padding: space.lg, gap: space.md },
  caption: { fontSize: 13, color: colors.inkSoft },
  search: { minHeight: TOUCH + 4, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: radius.control, paddingHorizontal: space.md, fontSize: 16, color: colors.ink, backgroundColor: colors.surface },
  section: { fontSize: 13, fontWeight: '700', color: colors.inkSoft, textTransform: 'uppercase', paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm },
  row: { minHeight: TOUCH + 16, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowText: { flex: 1, gap: 2 },
  name: { fontSize: 16, color: colors.ink, fontWeight: '500' },
  sub: { fontSize: 13, color: colors.inkSoft },
  switchBox: { minWidth: TOUCH + 8, minHeight: TOUCH, alignItems: 'flex-end', justifyContent: 'center' },
});
