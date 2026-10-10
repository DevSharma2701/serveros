/**
 * Development helper: creates a week of sample orders for the demo restaurant by calling the
 * real services (pricing, kitchen, payments, stock, invoices), then back-dates them so the
 * reports have history to show.
 *
 *   pnpm --filter @serveos/api seed:orders
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { OutletContext } from './common/context';
import { PrismaService } from './common/prisma.service';
import { env } from './config/env';
import { AppModule } from './app.module';
import { CashService } from './modules/cash.module';
import { KitchenService } from './modules/kitchen.module';
import { OrdersService } from './modules/orders.module';
import { PaymentsService } from './modules/payments.module';

// Small deterministic generator so every run produces the same demo data.
let state = 20261010;
const random = (): number => {
  state = (state * 1103515245 + 12345) % 2147483648;
  return state / 2147483648;
};
const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;

async function main(): Promise<void> {
  if (env.NODE_ENV === 'production') throw new Error('Sample orders must not be created in production.');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const orders = app.get(OrdersService);
  const payments = app.get(PaymentsService);
  const kitchen = app.get(KitchenService);
  const cash = app.get(CashService);

  try {
    const outlet = await prisma.outlet.findFirst({ where: { code: 'BLR1', restaurant: { slug: 'saffron-table' } } });
    if (!outlet) throw new Error('Demo restaurant not found. Run "pnpm db:seed" first.');
    if ((await prisma.order.count({ where: { outletId: outlet.id } })) > 0) {
      console.log('This outlet already has orders; nothing to do.');
      return;
    }
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: 'owner@saffrontable.test' }, include: { role: { include: { permissions: true } } } });
    const ctx: OutletContext = {
      userId: owner.id, userName: owner.name, sessionId: 'seed', restaurantId: outlet.restaurantId, isPlatformAdmin: false, roleKey: owner.role.key, roleRank: owner.role.rank,
      permissions: new Set(owner.role.permissions.map((p) => p.permissionKey)), outletPermissions: new Map(), outletIds: [outlet.id], allOutlets: true, outletId: outlet.id, ip: '', correlationId: 'seed',
    };

    const products = await prisma.product.findMany({ where: { restaurantId: outlet.restaurantId }, include: { variants: true, modifierGroups: { include: { group: { include: { options: true } } } } } });
    const customers = await prisma.customer.findMany({ where: { restaurantId: outlet.restaurantId } });
    const tables = await prisma.restaurantTable.findMany({ where: { outletId: outlet.id }, orderBy: { name: 'asc' } });
    const register = await prisma.cashRegister.findFirstOrThrow({ where: { outletId: outlet.id, name: 'Counter 2' } });

    const line = (n: number) => {
      const product = pick(products);
      const modifierOptionIds = product.modifierGroups.flatMap((g) => (g.group.minSelect > 0 || random() < 0.3 ? [pick(g.group.options).id] : []));
      return { clientLineId: `seed-${n}-${Math.floor(random() * 1e9)}`, productId: product.id, variantId: pick(product.variants).id, quantity: 1 + Math.floor(random() * 2), modifierOptionIds, notes: '', discount: null };
    };
    const cart = (n: number, type: 'DINE_IN' | 'TAKEAWAY' | 'PICKUP' | 'DELIVERY', tableId: string | null) => ({
      type, tableId, customerId: random() < 0.4 ? pick(customers).id : null, guestCount: type === 'DINE_IN' ? 2 : 1, notes: '',
      deliveryName: type === 'DELIVERY' ? 'Demo Customer' : '', deliveryPhone: type === 'DELIVERY' ? '9811100009' : '', deliveryAddress: type === 'DELIVERY' ? '7 Example Lane, Indiranagar' : '',
      placeOfSupplyStateCode: null, items: Array.from({ length: 1 + Math.floor(random() * 4) }, () => line(n)), orderDiscount: null, couponCode: null,
      action: 'PLACE' as const, source: 'POS' as const,
    });

    await cash.open(ctx, { registerId: register.id, openingFloatMinor: 200_000 });
    let created = 0;
    for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
      const count = 5 + Math.floor(random() * 4);
      for (let i = 0; i < count; i++) {
        const n = ++created;
        const type = pick<'DINE_IN' | 'TAKEAWAY' | 'PICKUP' | 'DELIVERY'>(['DINE_IN', 'DINE_IN', 'TAKEAWAY', 'TAKEAWAY', 'PICKUP', 'DELIVERY']);
        const order = await orders.create(ctx, cart(n, type, type === 'DINE_IN' ? tables[0]!.id : null), `seed-order-${n}`);
        const method = pick<'CASH' | 'UPI' | 'CARD'>(['CASH', 'CASH', 'UPI', 'UPI', 'CARD']);
        await payments.record(ctx, order.id, { tenders: [{ method, amountMinor: order.totalMinor, mode: 'MANUAL', reference: method === 'CASH' ? '' : `DEMO${1000 + n}` }] }, `seed-pay-${n}`);
        for (const ticket of await prisma.kitchenTicket.findMany({ where: { orderId: order.id } })) await kitchen.setStatus(ctx, ticket.id, 'READY');
        await orders.complete(ctx, order.id);

        // Back-date to a plausible time of day (11:00-22:00 local, i.e. 05:30-16:30 UTC for India).
        const at = new Date();
        at.setUTCDate(at.getUTCDate() - daysAgo);
        at.setUTCHours(5, 30 + Math.floor(random() * 660), 0, 0);
        if (at > new Date()) at.setTime(Date.now() - (count - i) * 4 * 60_000);
        const done = new Date(at.getTime() + 18 * 60_000);
        await prisma.order.update({ where: { id: order.id }, data: { createdAt: at, placedAt: at, completedAt: done } });
        await prisma.payment.updateMany({ where: { orderId: order.id }, data: { createdAt: done, succeededAt: done } });
        await prisma.invoice.updateMany({ where: { orderId: order.id }, data: { issuedAt: done } });
        await prisma.kitchenTicket.updateMany({ where: { orderId: order.id }, data: { firedAt: at, startedAt: at, readyAt: done } });
      }
    }
    const shift = await cash.current(ctx);
    // Count ₹20 short so the cash variance report has something to show.
    await cash.close(ctx, shift!.shift.id, { countedCashMinor: shift!.cash.expectedCashMinor - 2000, note: 'Demo shift' });

    // Two live orders so the floor plan, order list and kitchen display are not empty.
    const dineIn = await orders.create(ctx, cart(900, 'DINE_IN', tables[1]!.id), 'seed-live-dinein');
    const takeaway = await orders.create(ctx, cart(901, 'TAKEAWAY', null), 'seed-live-takeaway');
    console.log(`Created ${created} completed orders plus 2 open ones (${dineIn.orderNumber} on ${dineIn.tableLabel}, ${takeaway.orderNumber} takeaway).`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
