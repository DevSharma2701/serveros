import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import { Prisma } from '@prisma/client';
import type { RoleKey } from '@serveos/shared';
import request from 'supertest';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { syncAccessCatalogue } from '../common/access-catalogue';
import { PrismaService } from '../common/prisma.service';

export const PASSWORD = 'Correct-Horse-42';
let passwordHash: Promise<string> | undefined;
const D = (v: number | string) => new Prisma.Decimal(v);

export async function createTestApp(): Promise<{ app: NestExpressApplication; prisma: PrismaService }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: false });
  configureApp(app);
  await app.init();
  const prisma = app.get(PrismaService);
  await resetDb(prisma);
  return { app, prisma };
}

/** Empties every table (the schema stays) and restores the built-in roles and permissions. */
export async function resetDb(prisma: PrismaService): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await syncAccessCatalogue(prisma);
}

export type Fixture = Awaited<ReturnType<typeof seedTenant>>;

/**
 * One small restaurant:
 *   Tea   100.00  (station BEVERAGE, recipe: 100 ml milk)
 *   Curry Half 200.00 / Full 300.00 (station HOT; "Spice" required: Mild/Hot; "Extras" optional max 2: Butter +20, Cheese +30)
 *   Tax 5% (CGST 2.5 + SGST 2.5), prices exclude tax, no round-off, stock deducted on confirm.
 */
export async function seedTenant(prisma: PrismaService, slug: string) {
  passwordHash ??= hash(PASSWORD, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  const roles = Object.fromEntries((await prisma.role.findMany({ where: { restaurantId: null } })).map((r) => [r.key, r.id])) as Record<RoleKey, string>;
  const restaurant = await prisma.restaurant.create({
    data: { name: `Test ${slug}`, legalName: `Test ${slug} Pvt Ltd`, slug, stateCode: '29', roundOffMode: 'NONE', loyaltyEnabled: true, loyaltyEarnPointsPer100: 10, loyaltyPointValueMinor: 100, loyaltyMinRedeemPoints: 10 },
  });
  const restaurantId = restaurant.id;
  const mkOutlet = (name: string, code: string) => prisma.outlet.create({ data: { restaurantId, name, code, stateCode: '29', timezone: 'Asia/Kolkata' } });
  const outlet = await mkOutlet('Main', 'MAIN');
  const outlet2 = await mkOutlet('Second', 'SEC');

  const tax = await prisma.taxCategory.create({
    data: {
      restaurantId, name: 'GST 5%', hsnSac: '996331',
      rules: {
        create: [
          { component: 'CGST', name: 'CGST 2.5%', rateBps: 250, scope: 'INTRA_STATE' },
          { component: 'SGST', name: 'SGST 2.5%', rateBps: 250, scope: 'INTRA_STATE' },
          { component: 'IGST', name: 'IGST 5%', rateBps: 500, scope: 'INTER_STATE' },
        ],
      },
    },
  });

  await prisma.unitOfMeasure.createMany({
    data: [['g', 'MASS', 1], ['kg', 'MASS', 1000], ['ml', 'VOLUME', 1], ['l', 'VOLUME', 1000], ['pc', 'COUNT', 1]].map(([code, dimension, factor]) => ({
      restaurantId, code: code as string, name: code as string, dimension: dimension as 'MASS', toBaseFactor: D(factor as number),
    })),
  });
  const units = Object.fromEntries((await prisma.unitOfMeasure.findMany({ where: { restaurantId } })).map((u) => [u.code, u.id])) as Record<'g' | 'kg' | 'ml' | 'l' | 'pc', string>;
  const milk = await prisma.ingredient.create({ data: { restaurantId, name: 'Milk', sku: 'MILK', baseUnitId: units.ml, lowStockThreshold: D(500), costPerBaseMinor: D(6) } });
  const riceIng = await prisma.ingredient.create({ data: { restaurantId, name: 'Rice', sku: 'RICE', baseUnitId: units.g, lowStockThreshold: D(1000) } });

  const spice = await prisma.modifierGroup.create({ data: { restaurantId, name: 'Spice', minSelect: 1, maxSelect: 1, options: { create: [{ name: 'Mild' }, { name: 'Hot', sortOrder: 1 }] } }, include: { options: true } });
  const extras = await prisma.modifierGroup.create({
    data: { restaurantId, name: 'Extras', minSelect: 0, maxSelect: 2, options: { create: [{ name: 'Butter', priceMinor: 2000 }, { name: 'Cheese', priceMinor: 3000, sortOrder: 1 }, { name: 'Egg', priceMinor: 1500, sortOrder: 2 }] } },
    include: { options: true },
  });
  const category = await prisma.category.create({ data: { restaurantId, name: 'Food' } });
  const tea = await prisma.product.create({
    data: { restaurantId, categoryId: category.id, taxCategoryId: tax.id, name: 'Tea', sku: 'TEA', stationKey: 'BEVERAGE', variants: { create: [{ name: 'Regular', priceMinor: 10_000, isDefault: true }] } },
    include: { variants: true },
  });
  const curry = await prisma.product.create({
    data: {
      restaurantId, categoryId: category.id, taxCategoryId: tax.id, name: 'Curry', sku: 'CURRY', stationKey: 'HOT',
      variants: { create: [{ name: 'Half', priceMinor: 20_000, isDefault: true }, { name: 'Full', priceMinor: 30_000, sortOrder: 1 }] },
      modifierGroups: { create: [{ modifierGroupId: spice.id }, { modifierGroupId: extras.id, sortOrder: 1 }] },
    },
    include: { variants: true },
  });
  await prisma.recipe.create({ data: { restaurantId, productId: tea.id, createdById: restaurantId, ingredients: { create: [{ ingredientId: milk.id, quantity: D(100), unitId: units.ml, baseQuantity: D(100) }] } } });

  const registers: string[] = [];
  const tables: string[] = [];
  for (const o of [outlet, outlet2]) {
    await prisma.kitchenStation.createMany({ data: [{ restaurantId, outletId: o.id, key: 'HOT', name: 'Hot kitchen', isDefault: true }, { restaurantId, outletId: o.id, key: 'BEVERAGE', name: 'Beverages' }] });
    for (const name of ['Counter 1', 'Counter 2']) registers.push((await prisma.cashRegister.create({ data: { restaurantId, outletId: o.id, name } })).id);
    const area = await prisma.diningArea.create({ data: { restaurantId, outletId: o.id, name: 'Hall' } });
    for (const name of ['T1', 'T2', 'T3']) tables.push((await prisma.restaurantTable.create({ data: { restaurantId, outletId: o.id, areaId: area.id, name } })).id);
    await prisma.inventoryBalance.create({ data: { outletId: o.id, ingredientId: milk.id, quantity: D(10_000) } });
  }

  const mkUser = async (role: RoleKey, access: 'all' | string[]) => {
    const email = `${role.toLowerCase()}@${slug}.test`;
    const user = await prisma.user.create({
      data: {
        restaurantId, roleId: roles[role], email, name: `${role} ${slug}`, passwordHash: await passwordHash!, status: 'ACTIVE', allOutlets: access === 'all',
        assignments: access === 'all' ? undefined : { create: access.map((outletId) => ({ outletId })) },
      },
    });
    return { id: user.id, email };
  };
  const users = {
    owner: await mkUser('RESTAURANT_OWNER', 'all'),
    admin: await mkUser('RESTAURANT_ADMIN', 'all'),
    manager: await mkUser('OUTLET_MANAGER', [outlet.id]),
    cashier: await mkUser('CASHIER', [outlet.id]),
    waiter: await mkUser('WAITER', [outlet.id]),
    kitchen: await mkUser('KITCHEN_STAFF', [outlet.id]),
    inventory: await mkUser('INVENTORY_MANAGER', [outlet.id]),
  };
  const customer = await prisma.customer.create({ data: { restaurantId, name: 'Asha Rao', phone: '9876543210', email: 'asha@example.test', notes: 'Allergic to nuts' } });

  const opt = (group: typeof spice, name: string) => group.options.find((o) => o.name === name)!.id;
  return {
    restaurantId, outletId: outlet.id, outlet2Id: outlet2.id, roles, users, units, taxCategoryId: tax.id, categoryId: category.id, customerId: customer.id,
    milkId: milk.id, riceId: riceIng.id,
    registerId: registers[0]!, register2Id: registers[1]!, tables: tables.slice(0, 3), outlet2Tables: tables.slice(3),
    tea: { id: tea.id, variantId: tea.variants[0]!.id },
    curry: { id: curry.id, half: curry.variants.find((v) => v.name === 'Half')!.id, full: curry.variants.find((v) => v.name === 'Full')!.id },
    mods: { spiceGroupId: spice.id, extrasGroupId: extras.id, mild: opt(spice, 'Mild'), hot: opt(spice, 'Hot'), butter: opt(extras, 'Butter'), cheese: opt(extras, 'Cheese'), egg: opt(extras, 'Egg') },
  };
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** A tiny HTTP client bound to one user and (optionally) one outlet. */
export function client(app: NestExpressApplication, token?: string, outletId?: string) {
  const call = (method: Method, path: string, body?: object, headers: Record<string, string> = {}) => {
    let req = request(app.getHttpServer())[method](`/api/v1${path}`);
    if (token) req = req.set('Authorization', `Bearer ${token}`);
    if (outletId) req = req.set('X-Outlet-Id', outletId);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return body === undefined ? req : req.send(body);
  };
  return {
    token,
    get: (path: string, headers?: Record<string, string>) => call('get', path, undefined, headers),
    post: (path: string, body: object = {}, headers?: Record<string, string>) => call('post', path, body, headers),
    put: (path: string, body: object = {}) => call('put', path, body),
    patch: (path: string, body: object = {}) => call('patch', path, body),
    delete: (path: string) => call('delete', path),
  };
}
export type Client = ReturnType<typeof client>;

export async function loginAs(app: NestExpressApplication, email: string, outletId?: string): Promise<Client> {
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: PASSWORD, client: 'mobile' });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return client(app, res.body.accessToken, outletId);
}

let counter = 0;
export const key = (prefix = 'k'): string => `${prefix}-${Date.now()}-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
export const lineId = (): string => `line-${++counter}`;

export const teaLine = (f: Fixture, quantity = 1, extra: object = {}) => ({ clientLineId: lineId(), productId: f.tea.id, variantId: f.tea.variantId, quantity, ...extra });
export const curryLine = (f: Fixture, variant: 'half' | 'full' = 'full', modifierOptionIds?: string[], extra: object = {}) => ({
  clientLineId: lineId(), productId: f.curry.id, variantId: f.curry[variant], quantity: 1, modifierOptionIds: modifierOptionIds ?? [f.mods.mild], ...extra,
});

/** Creates a takeaway order (placed by default) and returns the response. */
export const order = (c: Client, items: object[], extra: object = {}, idempotencyKey = key('ord')) =>
  c.post('/orders', { type: 'TAKEAWAY', items, ...extra }, { 'Idempotency-Key': idempotencyKey });

export const pay = (c: Client, orderId: string, tenders: object[], idempotencyKey = key('pay')) =>
  c.post(`/orders/${orderId}/payments`, { tenders }, { 'Idempotency-Key': idempotencyKey });

export const openShift = (c: Client, registerId: string, openingFloatMinor = 100_000) => c.post('/shifts/open', { registerId, openingFloatMinor });
