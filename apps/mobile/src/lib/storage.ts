/**
 * Device storage. The refresh token is a long-lived credential, so it goes ONLY into
 * Expo SecureStore (Keychain on iOS, Keystore-encrypted preferences on Android).
 * The access token is never stored: it lives in memory in api.ts.
 */
import * as SecureStore from 'expo-secure-store';

const REFRESH_KEY = 'serveos.refreshToken';
const OUTLET_KEY = 'serveos.outletId';

const read = (key: string): Promise<string | null> => SecureStore.getItemAsync(key).catch(() => null);
const remove = (key: string): Promise<void> => SecureStore.deleteItemAsync(key).catch(() => undefined);

export const getRefreshToken = (): Promise<string | null> => read(REFRESH_KEY);
export const saveRefreshToken = (token: string): Promise<void> => SecureStore.setItemAsync(REFRESH_KEY, token);
export const clearRefreshToken = (): Promise<void> => remove(REFRESH_KEY);

/** The last outlet the user worked in. Not a secret; kept here to avoid a second storage library. */
export const getStoredOutlet = (): Promise<string | null> => read(OUTLET_KEY);
export const saveStoredOutlet = (id: string): Promise<void> => SecureStore.setItemAsync(OUTLET_KEY, id).catch(() => undefined);
export const clearStoredOutlet = (): Promise<void> => remove(OUTLET_KEY);
