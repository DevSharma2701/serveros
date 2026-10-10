/**
 * Jest setup: the device and the network are replaced by in-memory fakes.
 * - expo-secure-store -> a Map (so tests can assert exactly what was persisted)
 * - socket.io-client  -> an inert socket
 * - fetch             -> installed per test with mockApi() from ./api-mock
 */
import { secureStoreData } from './secure-store';

jest.mock('expo-secure-store', () => {
  const { secureStoreData: data } = jest.requireActual<typeof import('./secure-store')>('./secure-store');
  return {
    getItemAsync: jest.fn(async (key: string) => data.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => void data.set(key, value)),
    deleteItemAsync: jest.fn(async (key: string) => void data.delete(key)),
  };
});

jest.mock('socket.io-client', () => ({
  io: jest.fn(() => ({ on: jest.fn(), emit: jest.fn(), close: jest.fn() })),
}));

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => true),
  hideAsync: jest.fn(async () => undefined),
}));

afterEach(() => {
  secureStoreData.clear();
});
