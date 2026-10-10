import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PrismaService } from '../common/prisma.service';
import { EmailService } from '../common/services';
import { client, createTestApp, key, loginAs, order, PASSWORD, seedTenant, teaLine, type Fixture } from './harness';

let app: NestExpressApplication;
let prisma: PrismaService;
let a: Fixture;
let b: Fixture;

beforeAll(async () => {
  ({ app, prisma } = await createTestApp());
  a = await seedTenant(prisma, 'alpha');
  b = await seedTenant(prisma, 'bravo');
});
afterAll(() => app.close());

const http = () => request(app.getHttpServer());
const tokenFromEmail = (to: string): string => {
  const mail = app.get(EmailService).outbox.find((m) => m.to === to);
  return /token=([\w-]+)/.exec(mail?.text ?? '')![1]!;
};

describe('authentication', () => {
  it('rejects requests without a token and unknown credentials', async () => {
    await client(app).get('/auth/me').expect(401);
    await http().post('/api/v1/auth/login').send({ email: a.users.cashier.email, password: 'wrong-password' }).expect(401);
    const unknown = await http().post('/api/v1/auth/login').send({ email: 'nobody@alpha.test', password: PASSWORD }).expect(401);
    expect(unknown.body.error.message).toBe('Incorrect email or password');
  });

  it('signs in, returns the profile, and never exposes the password hash', async () => {
    const c = await loginAs(app, a.users.cashier.email);
    const me = await c.get('/auth/me').expect(200);
    expect(me.body.user.role.key).toBe('CASHIER');
    expect(me.body.outlets.map((o: { id: string }) => o.id)).toEqual([a.outletId]);
    expect(me.body.permissions).toContain('order.create');
    expect(me.body.permissions).not.toContain('payment.refund');
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|argon2/);
  });

  it('web login keeps the refresh token in an httpOnly cookie, out of reach of scripts', async () => {
    const res = await http().post('/api/v1/auth/login').send({ email: a.users.cashier.email, password: PASSWORD }).expect(200);
    expect(res.body.refreshToken).toBeUndefined();
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/serveos_rt=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const refreshed = await http().post('/api/v1/auth/refresh').set('Cookie', cookie.split(';')[0]!).send({}).expect(200);
    expect(refreshed.body.accessToken).toBeTruthy();
  });

  it('rotates refresh tokens so an old one stops working', async () => {
    const login = await http().post('/api/v1/auth/login').send({ email: a.users.waiter.email, password: PASSWORD, client: 'mobile' }).expect(200);
    const first = await http().post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200);
    expect(first.body.refreshToken).not.toBe(login.body.refreshToken);
    await http().post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(401);
    await http().post('/api/v1/auth/refresh').send({ refreshToken: first.body.refreshToken }).expect(200);
  });

  it('logout and session revocation take effect immediately', async () => {
    const c = await loginAs(app, a.users.waiter.email);
    await c.get('/auth/me').expect(200);
    await c.post('/auth/logout').expect(204);
    await c.get('/auth/me').expect(401);

    const one = await loginAs(app, a.users.waiter.email);
    const two = await loginAs(app, a.users.waiter.email);
    const sessions = await one.get('/auth/sessions').expect(200);
    const other = sessions.body.find((s: { current: boolean }) => !s.current);
    await one.delete(`/auth/sessions/${other.id}`).expect(204);
    await two.get('/auth/me').expect(401);
    await one.get('/auth/me').expect(200);
  });

  it('locks the account after repeated wrong passwords', async () => {
    const email = a.users.inventory.email;
    for (let i = 0; i < 5; i++) await http().post('/api/v1/auth/login').send({ email, password: 'nope-nope-nope' }).expect(401);
    const locked = await http().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(401);
    expect(locked.body.error.message).toMatch(/Too many failed attempts/);
    await prisma.user.update({ where: { email }, data: { lockedUntil: null } });
    await loginAs(app, email);
  });

  it('resets a password with a single-use token and signs out existing sessions', async () => {
    const email = a.users.kitchen.email;
    const before = await loginAs(app, email);
    await http().post('/api/v1/auth/password/forgot').send({ email }).expect(204);
    await http().post('/api/v1/auth/password/forgot').send({ email: 'ghost@alpha.test' }).expect(204); // no account enumeration
    const token = tokenFromEmail(email);
    await http().post('/api/v1/auth/password/reset').send({ token, password: 'short' }).expect(400);
    await http().post('/api/v1/auth/password/reset').send({ token, password: 'A-brand-new-pass-1' }).expect(204);
    await http().post('/api/v1/auth/password/reset').send({ token, password: 'Another-pass-123' }).expect(400);
    await before.get('/auth/me').expect(401);
    await http().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(401);
    await http().post('/api/v1/auth/login').send({ email, password: 'A-brand-new-pass-1' }).expect(200);
    await prisma.user.update({ where: { email }, data: { passwordHash: (await prisma.user.findUniqueOrThrow({ where: { email: a.users.owner.email } })).passwordHash } });
  });

  it('invited staff cannot sign in until they accept the invitation', async () => {
    const owner = await loginAs(app, a.users.owner.email);
    const invited = await owner.post('/staff', { name: 'New Waiter', email: 'new.waiter@alpha.test', roleId: a.roles.WAITER, outletIds: [a.outletId] }).expect(201);
    expect(invited.body.status).toBe('INVITED');
    expect(invited.body.passwordHash).toBeUndefined();
    await http().post('/api/v1/auth/login').send({ email: 'new.waiter@alpha.test', password: PASSWORD }).expect(401);
    await http().post('/api/v1/auth/password/reset').send({ token: tokenFromEmail('new.waiter@alpha.test'), password: PASSWORD }).expect(204);
    const c = await loginAs(app, 'new.waiter@alpha.test', a.outletId);
    await c.get('/floor').expect(200);
  });
});

describe('tenant isolation', () => {
  let ownerA: Awaited<ReturnType<typeof loginAs>>;
  let ownerB: Awaited<ReturnType<typeof loginAs>>;
  let orderA: string;

  beforeAll(async () => {
    ownerA = await loginAs(app, a.users.owner.email, a.outletId);
    ownerB = await loginAs(app, b.users.owner.email, b.outletId);
    orderA = (await order(ownerA, [teaLine(a)]).expect(201)).body.id;
  });

  it("cannot select another restaurant's outlet", async () => {
    const res = await client(app, ownerB.token, a.outletId).get('/orders').expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it("cannot read or change another restaurant's records by guessing ids", async () => {
    await ownerB.get(`/orders/${orderA}`).expect(404);
    await ownerB.post(`/orders/${orderA}/cancel`, { reason: 'not mine' }).expect(404);
    await ownerB.get(`/orders/${orderA}/receipt`).expect(404);
    await ownerB.get(`/menu/products/${a.tea.id}`).expect(404);
    await ownerB.patch(`/menu/products/${a.tea.id}`, { name: 'Hacked' }).expect(404);
    await ownerB.get(`/customers/${a.customerId}`).expect(404);
    await ownerB.patch(`/staff/${a.users.cashier.id}`, { name: 'Hacked' }).expect(404);
    await ownerB.patch(`/outlets/${a.outletId}`, { name: 'Hacked' }).expect(404);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: a.tea.id } })).name).toBe('Tea');
  });

  it("cannot put another restaurant's product, table or customer on its own order", async () => {
    await order(ownerB, [teaLine(a)]).expect(404);
    await order(ownerB, [teaLine(b)], { customerId: a.customerId }).expect(404);
    await order(ownerB, [teaLine(b)], { type: 'DINE_IN', tableId: a.tables[0] }).expect(404);
  });

  it('lists only its own data', async () => {
    const orders = await ownerB.get('/orders').expect(200);
    expect(orders.body.total).toBe(0);
    const staff = await ownerB.get('/staff').expect(200);
    expect(staff.body.every((u: { email: string }) => u.email.endsWith('@bravo.test'))).toBe(true);
    const customers = await ownerB.get('/customers').expect(200);
    expect(customers.body.items.map((c: { id: string }) => c.id)).not.toContain(a.customerId);
  });

  it('reports refuse outlets the user is not assigned to', async () => {
    await ownerB.get(`/reports/dashboard?from=2026-01-01&to=2026-12-31&outletIds=${a.outletId}`).expect(403);
    const manager = await loginAs(app, a.users.manager.email);
    await manager.get(`/reports/dashboard?from=2026-01-01&to=2026-12-31&outletIds=${a.outlet2Id}`).expect(403);
  });

  it('staff are confined to their assigned outlets', async () => {
    const cashier = await loginAs(app, a.users.cashier.email);
    await client(app, cashier.token, a.outlet2Id).get('/orders').expect(403);
    await client(app, cashier.token).get('/orders').expect(400); // outlet must be selected
    await client(app, cashier.token, 'not-a-uuid').get('/orders').expect(400);
  });

  it('ignores server-owned fields smuggled into a request body', async () => {
    await ownerA.patch(`/menu/products/${a.tea.id}`, { name: 'Masala Tea', restaurantId: b.restaurantId, id: b.tea.id }).expect(200);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: a.tea.id } });
    expect(product.restaurantId).toBe(a.restaurantId);
    expect(product.name).toBe('Masala Tea');

    const res = await ownerA
      .post('/orders', { type: 'TAKEAWAY', items: [teaLine(a)], totalMinor: 1, paidMinor: 999999, paymentStatus: 'PAID', status: 'COMPLETED', restaurantId: b.restaurantId }, { 'Idempotency-Key': key() })
      .expect(201);
    expect(res.body).toMatchObject({ totalMinor: 10_500, paidMinor: 0, paymentStatus: 'UNPAID', status: 'CONFIRMED', restaurantId: a.restaurantId });
  });

  it('platform admins cannot reach restaurant data', async () => {
    const admin = await prisma.user.create({
      data: { email: 'platform@serveos.test', name: 'Platform', roleId: a.roles.PLATFORM_ADMIN, status: 'ACTIVE', allOutlets: true, passwordHash: (await prisma.user.findUniqueOrThrow({ where: { email: a.users.owner.email } })).passwordHash },
    });
    const c = await loginAs(app, admin.email);
    await c.get('/platform/restaurants').expect(200);
    await c.get('/staff').expect(403);
    await c.get('/menu/products').expect(403);
    await ownerA.get('/platform/restaurants').expect(403);
  });
});

describe('roles and privilege escalation', () => {
  it('a cashier cannot manage staff, menu, settings or refunds', async () => {
    const cashier = await loginAs(app, a.users.cashier.email, a.outletId);
    await cashier.get('/staff').expect(403);
    await cashier.post('/staff', { name: 'X', email: 'x@alpha.test', roleId: a.roles.CASHIER }).expect(403);
    await cashier.patch(`/staff/${a.users.cashier.id}`, { roleId: a.roles.RESTAURANT_OWNER }).expect(403);
    await cashier.post(`/staff/${a.users.cashier.id}/grants`, { permissionKey: 'payment.refund' }).expect(403);
    await cashier.patch('/restaurant', { allowNegativeStock: true }).expect(403);
    await cashier.post('/menu/products', { name: 'Free', sku: 'FREE', categoryId: a.categoryId, variants: [{ name: 'Regular', priceMinor: 0 }] }).expect(403);
    await cashier.get('/audit-events').expect(403);
    await cashier.get('/reports/dashboard?from=2026-01-01&to=2026-12-31').expect(403);
  });

  it('a manager can only hand out roles, outlets and permissions below their own', async () => {
    const manager = await loginAs(app, a.users.manager.email, a.outletId);
    const invite = (roleId: string, extra: object = {}) => manager.post('/staff', { name: 'Hire', email: `hire-${key()}@alpha.test`, roleId, outletIds: [a.outletId], ...extra });
    await invite(a.roles.RESTAURANT_OWNER).expect(403);
    await invite(a.roles.OUTLET_MANAGER).expect(403); // same rank
    await invite(a.roles.CASHIER, { outletIds: [a.outlet2Id] }).expect(403); // an outlet the manager lacks
    await invite(a.roles.CASHIER, { allOutlets: true }).expect(403);
    await invite(a.roles.CASHIER, { outletIds: [b.outletId] }).expect(403);
    await invite(b.roles.CASHIER).expect(201); // system roles are shared; the user still lands in the manager's own restaurant

    await manager.patch(`/staff/${a.users.owner.id}`, { status: 'DISABLED' }).expect(403);
    await manager.patch(`/staff/${a.users.manager.id}`, { roleId: a.roles.RESTAURANT_ADMIN }).expect(403); // own account
    await manager.post(`/staff/${a.users.cashier.id}/grants`, { permissionKey: 'restaurant.manage' }).expect(403); // not held by a manager
    await manager.post(`/staff/${a.users.cashier.id}/grants`, { permissionKey: 'platform.manage' }).expect(403);
  });

  it('a granted permission works only in the outlet it was granted for, and is audited', async () => {
    const owner = await loginAs(app, a.users.owner.email);
    const grant = await owner.post(`/staff/${a.users.waiter.id}/grants`, { permissionKey: 'order.cancel', outletId: a.outletId }).expect(201);
    const waiter = await loginAs(app, a.users.waiter.email, a.outletId);
    const placed = await order(waiter, [teaLine(a)]).expect(201);
    await waiter.post(`/orders/${placed.body.id}/cancel`, { reason: 'guest left' }).expect(200);

    await owner.delete(`/staff/${a.users.waiter.id}/grants/${grant.body.id}`).expect(204);
    const second = await order(waiter, [teaLine(a)]).expect(201);
    await waiter.post(`/orders/${second.body.id}/cancel`, { reason: 'guest left' }).expect(403);

    const audit = await owner.get('/audit-events?action=staff.permission').expect(200);
    expect(audit.body.items.map((e: { action: string }) => e.action)).toEqual(['staff.permission_revoke', 'staff.permission_grant']);
  });

  it('changing a role or disabling a user ends their sessions', async () => {
    const owner = await loginAs(app, a.users.owner.email);
    const waiter = await loginAs(app, a.users.waiter.email, a.outletId);
    await owner.patch(`/staff/${a.users.waiter.id}`, { status: 'DISABLED' }).expect(200);
    await waiter.get('/auth/me').expect(401);
    await http().post('/api/v1/auth/login').send({ email: a.users.waiter.email, password: PASSWORD }).expect(401);
    await owner.patch(`/staff/${a.users.waiter.id}`, { status: 'ACTIVE' }).expect(200);
    await loginAs(app, a.users.waiter.email);
  });

  it('the audit log of an outlet-limited manager excludes other outlets', async () => {
    const owner2 = await loginAs(app, a.users.owner.email, a.outlet2Id);
    await owner2.post('/kitchen/stations', { key: 'AUDITX', name: 'Audit probe' }).expect(201);
    await prisma.auditEvent.create({ data: { restaurantId: a.restaurantId, outletId: a.outlet2Id, action: 'probe.other_outlet', entityType: 'Probe' } });
    await prisma.auditEvent.create({ data: { restaurantId: a.restaurantId, outletId: a.outletId, action: 'probe.own_outlet', entityType: 'Probe' } });
    const manager = await loginAs(app, a.users.manager.email);
    const seen = (await manager.get('/audit-events?action=probe').expect(200)).body.items.map((e: { action: string }) => e.action);
    expect(seen).toEqual(['probe.own_outlet']);
    const all = (await owner2.get('/audit-events?action=probe').expect(200)).body.items.map((e: { action: string }) => e.action).sort();
    expect(all).toEqual(['probe.other_outlet', 'probe.own_outlet']);
  });

  it('errors carry a correlation id and never a stack trace', async () => {
    const res = await client(app).get('/orders').set('X-Request-Id', 'test-correlation-1').expect(401);
    expect(res.body.error.correlationId).toBe('test-correlation-1');
    expect(res.headers['x-request-id']).toBe('test-correlation-1');
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts|node_modules|prisma/i);
    await http().get('/api/v1/health').expect(200);
    await http().get('/api/v1/health/ready').expect(200);
  });
});
