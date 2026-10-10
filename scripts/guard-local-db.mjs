// Stops development-only commands (reset, seed) from ever running against a real database.
// They may only touch a database on this computer.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let url = process.env.DATABASE_URL;
if (!url) {
  try {
    url = /^DATABASE_URL=(.*)$/m.exec(readFileSync(resolve(root, '.env'), 'utf8'))?.[1]?.trim();
  } catch {
    /* no .env file */
  }
}

let host = '';
try {
  host = new URL(url ?? '').hostname;
} catch {
  /* handled below */
}

if (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error(`\nRefused: "${process.argv[2] ?? 'this command'}" erases or fills data and may only run against a database on this computer.`);
  console.error(`DATABASE_URL points at "${host || 'an unreadable address'}"${process.env.NODE_ENV === 'production' ? ' and NODE_ENV is production' : ''}. Nothing was changed.\n`);
  process.exit(1);
}
