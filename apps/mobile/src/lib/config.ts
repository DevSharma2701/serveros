/**
 * Public runtime configuration. EXPO_PUBLIC_ variables are compiled into the app bundle and
 * can be read by anyone who has the app, so they must never hold secrets.
 *
 * EXPO_PUBLIC_API_URL: origin of the ServeOS API. "localhost" only works on an iOS simulator;
 * a physical phone needs the computer's LAN address (http://192.168.x.y:4000) and the
 * Android emulator needs http://10.0.2.2:4000.
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
export const API_BASE = `${API_URL}/api/v1`;

/** Push is a scaffold only: it stays off unless this flag is set AND an EAS project id exists. */
export const PUSH_ENABLED = process.env.EXPO_PUBLIC_PUSH_ENABLED === 'true';
