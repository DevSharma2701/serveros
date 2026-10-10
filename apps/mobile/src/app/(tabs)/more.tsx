import type { PermissionKey } from '@serveos/shared';
import { useRouter, type Href } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Badge, ListRow, styles as ui, type IconName } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { colors, space } from '../../theme';

interface Entry {
  title: string;
  subtitle: string;
  icon: IconName;
  href: Href;
  /** The user needs at least one of these; an empty list means everyone. */
  anyOf: PermissionKey[];
}

const ENTRIES: Entry[] = [
  { title: 'Product availability', subtitle: 'Mark items available or sold out', icon: 'fast-food-outline', href: '/availability', anyOf: ['menu.view'] },
  { title: 'Low-stock alerts', subtitle: 'Ingredients at or below their alert level', icon: 'warning-outline', href: '/low-stock', anyOf: ['inventory.view'] },
  { title: 'Inventory', subtitle: 'Stock on hand and its value', icon: 'cube-outline', href: '/inventory', anyOf: ['inventory.view'] },
  { title: 'Shift summaries', subtitle: 'Cash shifts and reconciliation', icon: 'cash-outline', href: '/shifts', anyOf: ['shift.operate'] },
  { title: 'Staff activity', subtitle: 'Audit log and attendance', icon: 'people-outline', href: '/staff', anyOf: [] },
  { title: 'Notifications', subtitle: 'In-app alerts from live data', icon: 'notifications-outline', href: '/notifications', anyOf: ['report.view', 'order.view'] },
  { title: 'Profile & settings', subtitle: 'Account, outlet, devices, sign out', icon: 'person-circle-outline', href: '/profile', anyOf: [] },
];

/** Entry point to the management tools. Items the user's role does not allow are disabled, not hidden, so it is clear they exist. */
export default function MoreScreen() {
  const router = useRouter();
  const { can } = useAuth();
  return (
    <ScrollView style={ui.screen} contentContainerStyle={styles.content}>
      <View style={styles.group}>
        {ENTRIES.map((entry) => {
          const allowed = entry.anyOf.length === 0 || entry.anyOf.some(can);
          return (
            <ListRow
              key={entry.title}
              testID={`more-${entry.title}`}
              icon={entry.icon}
              title={entry.title}
              subtitle={entry.subtitle}
              disabled={!allowed}
              accessibilityLabel={allowed ? `${entry.title}, ${entry.subtitle}` : `${entry.title}, not available for your role`}
              right={allowed ? undefined : <Badge label="No access" />}
              onPress={() => router.push(entry.href)}
            />
          );
        })}
      </View>
      <Text style={styles.note}>Billing and order taking happen on the ServeOS POS. This app is for keeping an eye on the business.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingVertical: space.lg, gap: space.lg },
  group: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  note: { fontSize: 13, color: colors.inkFaint, paddingHorizontal: space.lg },
});
