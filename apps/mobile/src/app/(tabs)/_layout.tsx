import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useAuth } from '../../lib/auth';
import { colors, space, TOUCH } from '../../theme';

/** The selected outlet, shown in every tab header; tapping it opens the outlet switcher. */
function OutletButton() {
  const router = useRouter();
  const { me, outlet } = useAuth();
  const canSwitch = (me?.outlets.length ?? 0) > 1;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Outlet: ${outlet?.name ?? 'none'}`}
      accessibilityHint={canSwitch ? 'Switches to another outlet' : undefined}
      disabled={!canSwitch}
      onPress={() => router.push('/outlets')}
      style={({ pressed }) => [styles.outlet, pressed && { opacity: 0.7 }]}>
      <Ionicons name="storefront-outline" size={16} color={colors.brandBright} />
      <Text style={styles.outletText} numberOfLines={1}>
        {outlet?.name}
      </Text>
      {canSwitch ? <Ionicons name="chevron-down" size={14} color={colors.chromeFaint} /> : null}
    </Pressable>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.chrome },
        headerTintColor: colors.chromeInk,
        headerTitleAlign: 'left',
        headerRight: () => <OutletButton />,
        tabBarStyle: { backgroundColor: colors.chrome, borderTopColor: colors.chromeRaised },
        tabBarActiveTintColor: colors.brandBright,
        tabBarInactiveTintColor: colors.chromeFaint,
        sceneStyle: { backgroundColor: colors.canvas },
      }}>
      <Tabs.Screen name="index" options={{ title: 'Dashboard', tabBarIcon: ({ color, size }) => <Ionicons name="speedometer-outline" size={size} color={color} /> }} />
      <Tabs.Screen name="orders" options={{ title: 'Live orders', tabBarIcon: ({ color, size }) => <Ionicons name="receipt-outline" size={size} color={color} /> }} />
      <Tabs.Screen name="reports" options={{ title: 'Sales', tabBarIcon: ({ color, size }) => <Ionicons name="bar-chart-outline" size={size} color={color} /> }} />
      <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: ({ color, size }) => <Ionicons name="grid-outline" size={size} color={color} /> }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  outlet: { minHeight: TOUCH, minWidth: TOUCH, maxWidth: 190, flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.md, marginRight: space.sm },
  outletText: { color: colors.chromeInk, fontSize: 14, fontWeight: '600', flexShrink: 1 },
});
