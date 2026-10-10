// Writes a full backup of the database in DATABASE_URL to backups/<name>-<timestamp>.dump
// (PostgreSQL custom format). Restore with:
//   pg_restore --clean --if-exists --no-owner -d "<connection string>" backups/<file>.dump
// Works for the local database and for a hosted one (set DATABASE_URL to its DIRECT connection string).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fromFile = (name) => {
  try {
    return new RegExp(`^${name}=(.*)$`, 'm').exec(readFileSync(resolve(root, '.env'), 'utf8'))?.[1]?.trim();
  } catch {
    return undefined;
  }
};
const url = process.env.DIRECT_URL || process.env.DATABASE_URL || fromFile('DIRECT_URL') || fromFile('DATABASE_URL');
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

function findPgDump() {
  if (process.env.PG_BIN) return join(process.env.PG_BIN, process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump');
  if (process.platform === 'win32') {
    const base = 'C:\\Program Files\\PostgreSQL';
    if (existsSync(base)) {
      const versions = readdirSync(base).sort((a, b) => Number(b) - Number(a));
      for (const v of versions) if (existsSync(join(base, v, 'bin', 'pg_dump.exe'))) return join(base, v, 'bin', 'pg_dump.exe');
    }
  }
  return 'pg_dump';
}

const target = new URL(url);
const dir = resolve(root, 'backups');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const file = join(dir, `${target.pathname.replace(/^\//, '') || 'database'}-${stamp}.dump`);

// Prisma's "?schema=public" is not a libpq option, so it is dropped; the password travels in the environment, not on the command line.
const clean = new URL(url);
clean.search = '';
const password = decodeURIComponent(clean.password);
clean.password = '';
const result = spawnSync(findPgDump(), ['--format=custom', '--no-owner', '--file', file, clean.toString()], { stdio: 'inherit', env: { ...process.env, PGPASSWORD: password } });
if (result.error || result.status !== 0) {
  console.error(result.error ? `Could not run pg_dump (${result.error.message}). Install the PostgreSQL client tools or set PG_BIN.` : 'Backup failed.');
  process.exit(1);
}
console.log(`Backup of "${target.hostname}${target.pathname}" written to ${file} (${Math.round(statSync(file).size / 1024)} KB).`);
