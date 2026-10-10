import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { colors, space } from '../theme';
import { Button, Empty, ListRow, Notice, refresher } from './ui';

/**
 * Restaurant and outlet selector. A ServeOS account belongs to exactly one restaurant, so the
 * restaurant is shown as context and the choice is the outlet. Pull down to re-read the
 * outlets assigned to you.
 */
export function OutletPicker({ onPicked }: { onPicked?: () => void }) {
  const { me, outlet, selectOutlet, reloadProfile, logout } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await reloadProfile();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.content}
      data={me?.outlets ?? []}
      keyExtractor={(o) => o.id}
      refreshControl={refresher(refreshing, () => void refresh())}
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={styles.caption}>Restaurant</Text>
          <Text style={styles.restaurant} accessibilityRole="header">
            {me?.restaurant?.name ?? 'No restaurant'}
          </Text>
          <Text style={styles.caption}>Signed in as {me?.user.name} · {me?.user.role.name}</Text>
          {error ? <Notice text={error} /> : null}
          <Text style={styles.prompt}>Which outlet do you want to look at?</Text>
        </View>
      }
      renderItem={({ item }) => {
        const current = item.id === outlet?.id;
        return (
          <ListRow
            testID={`outlet-${item.code}`}
            icon="storefront-outline"
            title={item.name}
            subtitle={`${item.code} · ${item.city}`}
            accessibilityLabel={`${item.name}, ${item.city}${current ? ', currently selected' : ''}`}
            accessibilityHint="Shows this outlet's data"
            right={current ? <Ionicons name="checkmark-circle" size={22} color={colors.ok} /> : undefined}
            onPress={() => {
              selectOutlet(item.id);
              onPicked?.();
            }}
          />
        );
      }}
      ListEmptyComponent={<Empty icon="storefront-outline" title="No outlets assigned" body="Your account is not assigned to any outlet yet. Ask an owner to assign you, then pull down to refresh." />}
      ListFooterComponent={
        outlet ? null : (
          <View style={styles.footer}>
            <Button label="Sign out" variant="secondary" onPress={() => void logout()} />
          </View>
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.canvas },
  content: { paddingBottom: space.xxl },
  header: { padding: space.lg, gap: space.xs },
  caption: { fontSize: 13, color: colors.inkSoft },
  restaurant: { fontSize: 24, fontWeight: '700', color: colors.ink },
  prompt: { fontSize: 15, color: colors.ink, marginTop: space.md, fontWeight: '600' },
  footer: { padding: space.lg },
});
