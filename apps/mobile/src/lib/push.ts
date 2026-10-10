/**
 * Push notifications: GUARDED SCAFFOLD ONLY. Push does not work today.
 *
 * What is missing before it can work:
 *  1. An EAS project (app.json -> expo.extra.eas.projectId) with FCM (Android) and APNs (iOS)
 *     credentials, and a development or production build (remote push is not available in Expo Go).
 *  2. An API endpoint that stores a device's push token against the signed-in user, and a
 *     server-side job that sends pushes. The ServeOS API has neither yet, so even when a token
 *     is obtained below there is nowhere to send it.
 *  3. EXPO_PUBLIC_PUSH_ENABLED=true in the app's environment.
 *
 * Until all of that exists this helper returns { status: 'disabled' } and touches nothing:
 * it does not load expo-notifications, does not ask for permission and makes no network call.
 * The Notifications screen in the app is an in-app feed computed from API data, not push.
 */
import Constants from 'expo-constants';
import { PUSH_ENABLED } from './config';

export type PushRegistration =
  | { status: 'disabled'; reason: string }
  | { status: 'denied' }
  | { status: 'unavailable'; reason: string }
  | { status: 'token'; token: string };

function easProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? null;
}

/** Why push is off, or null when the configuration needed to attempt registration is present. */
export function pushDisabledReason(): string | null {
  if (!PUSH_ENABLED) return 'Push notifications are not configured for this build.';
  if (!easProjectId()) return 'No EAS project id is configured, so a push token cannot be issued.';
  return null;
}

export async function registerForPushNotifications(): Promise<PushRegistration> {
  const reason = pushDisabledReason();
  if (reason) return { status: 'disabled', reason };

  try {
    // Loaded lazily so the native module is never touched while push is switched off.
    const Device = await import('expo-device');
    if (!Device.isDevice) return { status: 'unavailable', reason: 'Push needs a physical device.' };
    const Notifications = await import('expo-notifications');
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) return { status: 'denied' };
    const token = await Notifications.getExpoPushTokenAsync({ projectId: easProjectId()! });
    // TODO(api): send token.data to the API once a device-registration endpoint exists.
    return { status: 'token', token: token.data };
  } catch (err) {
    return { status: 'unavailable', reason: err instanceof Error ? err.message : 'Could not register for push.' };
  }
}
