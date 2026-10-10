import { renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { fireEvent } from '@testing-library/react-native';
import { onSessionExpired, setAccessToken, setApiOutlet } from '../src/lib/api';
import { OUTLET_KEY, REFRESH_KEY, secureStoreData } from './secure-store';

/** Forget everything the API client holds in memory, as a freshly started app would. */
export function resetClient(): void {
  setAccessToken(null);
  setApiOutlet(null);
  onSessionExpired(null);
}

/** Pretend this device already has a session (and optionally a chosen outlet). */
export function seedSession(refreshToken = 'refresh-stored', outletId?: string): void {
  secureStoreData.set(REFRESH_KEY, refreshToken);
  if (outletId) secureStoreData.set(OUTLET_KEY, outletId);
}

/** Renders the real route tree in src/app with Expo Router's test renderer. */
export async function renderApp(initialUrl = '/'): Promise<void> {
  await renderRouter('./src/app', { initialUrl });
}

export async function signIn(email: string, password: string): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('login-email')).toBeTruthy());
  await fireEvent.changeText(screen.getByTestId('login-email'), email);
  await fireEvent.changeText(screen.getByTestId('login-password'), password);
  await fireEvent.press(screen.getByTestId('login-submit'));
}

export { screen, waitFor, fireEvent };
