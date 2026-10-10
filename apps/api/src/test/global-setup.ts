import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import './env';

/** Brings the test database schema up to date once before the test run. */
export default function globalSetup(): void {
  const root = resolve(__dirname, '../../../..');
  execSync('pnpm exec prisma migrate deploy', { cwd: root, env: process.env, stdio: 'pipe' });
}
