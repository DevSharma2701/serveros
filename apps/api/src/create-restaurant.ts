/**
 * Creates a real restaurant with its first outlet and its owner, in whatever database
 * DATABASE_URL points at. Use it once on a new production database instead of the demo seed.
 *
 *   pnpm --filter @serveos/api create-restaurant -- \
 *     --name "Saffron Table" --legal-name "Saffron Table Hospitality Pvt Ltd" \
 *     --owner-name "Meera Iyer" --owner-email meera@example.com \
 *     --outlet "Indiranagar" --code BLR1 --state 29 --city Bengaluru --timezone Asia/Kolkata
 *
 * The owner gets an invitation link to choose their own password (emailed when a real email
 * provider is configured, otherwise printed here). No password is ever passed on the command line.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createRestaurantSchema } from '@serveos/shared';
import { parseArgs } from 'node:util';
import { AppModule } from './app.module';
import type { RequestContext } from './common/context';
import { EmailService } from './common/services';
import { env } from './config/env';
import { SetupService } from './modules/setup.module';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      'legal-name': { type: 'string' },
      'owner-name': { type: 'string' },
      'owner-email': { type: 'string' },
      outlet: { type: 'string' },
      code: { type: 'string' },
      state: { type: 'string', default: '' },
      city: { type: 'string', default: '' },
      timezone: { type: 'string', default: 'Asia/Kolkata' },
    },
  });
  const input = createRestaurantSchema.safeParse({
    name: values.name,
    legalName: values['legal-name'] ?? values.name,
    ownerName: values['owner-name'],
    ownerEmail: values['owner-email'],
    outlet: { name: values.outlet, code: values.code, stateCode: values.state, city: values.city, timezone: values.timezone },
  });
  if (!input.success) {
    console.error('Cannot create the restaurant:');
    for (const issue of input.error.issues) console.error(`  --${issue.path.join('.')}: ${issue.message}`);
    console.error('\nRequired: --name, --owner-name, --owner-email, --outlet, --code (2-5 capital letters or digits).');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    // Acts as the platform: this is the only way a restaurant comes into existence.
    const platform: RequestContext = {
      userId: null as unknown as string, userName: 'Setup command', sessionId: '', restaurantId: '', isPlatformAdmin: true, roleKey: 'PLATFORM_ADMIN', roleRank: 100,
      permissions: new Set(['platform.manage']), outletPermissions: new Map(), outletIds: [], allOutlets: true, outletId: null, ip: '', correlationId: 'create-restaurant',
    };
    const created = await app.get(SetupService).createRestaurant(platform, input.data);
    console.log(`\nCreated "${created.name}" with outlet "${input.data.outlet.name}" (${input.data.outlet.code}).`);
    console.log('It starts with one kitchen station, one cash register and one dining area; add the rest in the back office.');
    if (env.EMAIL_PROVIDER === 'dev') {
      const link = /https?:\/\/\S+/.exec(app.get(EmailService).outbox[0]?.text ?? '')?.[0];
      console.log(`\nNo email provider is configured, so the invitation was not sent. Give this link to ${created.ownerEmail} (valid for 7 days):\n  ${link}\n`);
    } else {
      console.log(`\nAn invitation to set a password was emailed to ${created.ownerEmail}.\n`);
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
