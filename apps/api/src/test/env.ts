import { config } from 'dotenv';
import { resolve } from 'node:path';

// Runs in the Jest global setup and again before each test file; the second run is a no-op.
if (process.env.SERVEOS_TEST_ENV !== 'ready') {
  config({ path: resolve(__dirname, '../../../../.env'), quiet: true } as never);

  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set. Tests refuse to run against the development database.');
  if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) throw new Error('TEST_DATABASE_URL must be a different database from DATABASE_URL: tests wipe it.');

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DIRECT_URL = process.env.TEST_DATABASE_URL;
  process.env.PAYMENT_PROVIDER = 'dev';
  process.env.SERVEOS_TEST_ENV = 'ready';
}
