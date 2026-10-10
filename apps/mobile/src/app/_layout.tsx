import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { ReportFiltersProvider } from '../components/filters';
import { Button, ErrorState, Loading } from '../components/ui';
import { ApiError } from '../lib/api';
import { AuthProvider, useAuth } from '../lib/auth';
import { API_URL } from '../lib/config';
import { RealtimeProvider } from '../lib/realtime';
import { colors, space } from '../theme';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

/** Retry transient failures a little; never retry answers that will not change (4xx). */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: (failureCount, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failureCount < 2,
      },
      mutations: { retry: false },
    },
  });
}

const headerOptions = {
  headerStyle: { backgroundColor: colors.chrome },
  headerTintColor: colors.chromeInk,
  headerTitleStyle: { fontWeight: '600' as const },
  contentStyle: { backgroundColor: colors.canvas },
  headerBackButtonDisplayMode: 'minimal' as const,
};

function RootNavigator() {
  const { status, outlet, retry, logout } = useAuth();

  useEffect(() => {
    if (status !== 'loading') void SplashScreen.hideAsync().catch(() => undefined);
  }, [status]);

  if (status === 'loading') {
    return (
      <View style={styles.center}>
        <Loading label="Starting ServeOS" />
      </View>
    );
  }
  if (status === 'unreachable') {
    return (
      <View style={styles.center}>
        <ErrorState error={new ApiError(0, 'NETWORK', `Cannot reach the ServeOS server at ${API_URL}. Check your connection and try again.`)} onRetry={retry} />
        <Button label="Sign out" variant="secondary" onPress={() => void logout()} />
      </View>
    );
  }

  const signedIn = status === 'authenticated';
  return (
    <Stack screenOptions={headerOptions}>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="login" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && !outlet}>
        <Stack.Screen name="select-outlet" options={{ title: 'Choose an outlet' }} />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && !!outlet}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="orders/[id]" options={{ title: 'Order' }} />
        <Stack.Screen name="availability" options={{ title: 'Product availability' }} />
        <Stack.Screen name="low-stock" options={{ title: 'Low-stock alerts' }} />
        <Stack.Screen name="inventory" options={{ title: 'Inventory' }} />
        <Stack.Screen name="staff" options={{ title: 'Staff activity' }} />
        <Stack.Screen name="shifts/index" options={{ title: 'Shift summaries' }} />
        <Stack.Screen name="shifts/[id]" options={{ title: 'Shift' }} />
        <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
        <Stack.Screen name="profile" options={{ title: 'Profile & settings' }} />
        <Stack.Screen name="outlets" options={{ title: 'Switch outlet', presentation: 'modal' }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const [queryClient] = useState(createQueryClient);

  // Refetch stale data when the app returns to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => focusManager.setFocused(state === 'active'));
    return () => sub.remove();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RealtimeProvider>
          <ReportFiltersProvider>
            <StatusBar style="light" />
            <RootNavigator />
          </ReportFiltersProvider>
        </RealtimeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', backgroundColor: colors.canvas, padding: space.lg, gap: space.md },
});
