import './production-env';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PrismaService } from '../common/prisma.service';
import { createTestApp, loginAs, seedTenant, type Client, type Fixture } from './harness';

let app: NestExpressApplication;
let prisma: PrismaService;
let f: Fixture;
let other: Fixture;
let owner: Client;
let cashier: Client;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not-a-real-picture-but-has-the-png-signature')]);

beforeAll(async () => {
  ({ app, prisma } = await createTestApp());
  f = await seedTenant(prisma, 'prod');
  other = await seedTenant(prisma, 'prodother');
  owner = await loginAs(app, f.users.owner.email, f.outletId);
  cashier = await loginAs(app, f.users.cashier.email, f.outletId);
});
afterAll(() => app.close());

const http = () => request(app.getHttpServer());
const upload = (c: Client, file: Buffer, name = 'photo.png') => http().post('/api/v1/uploads/product-image').set('Authorization', `Bearer ${c.token}`).attach('file', file, name);

describe('product images stored in the database', () => {
  it('keeps the image in the database and serves it publicly under a random name', async () => {
    const res = await upload(owner, PNG, '../../etc/passwd.png').expect(201);
    expect(res.body.url).toMatch(/^\/api\/v1\/files\/[0-9a-f]{32}\.png$/); // nothing from the uploaded file name is used
    const stored = await prisma.storedFile.findFirstOrThrow({ where: { restaurantId: f.restaurantId } });
    expect(stored).toMatchObject({ contentType: 'image/png', size: PNG.length });

    const served = await http().get(res.body.url).expect(200); // no login: the guest menu shows these
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['cache-control']).toMatch(/immutable/);
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(served.body, PNG)).toBe(0);
  });

  it('refuses files that are not really images, oversized files, and people without permission', async () => {
    expect((await upload(owner, Buffer.from('<script>alert(1)</script>'), 'evil.png').expect(400)).body.error.code).toBe('UNSUPPORTED_FILE');
    expect((await upload(owner, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.svg').expect(400)).body.error.code).toBe('UNSUPPORTED_FILE');
    await upload(owner, Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)])).expect(413);
    await upload(cashier, PNG).expect(403);
    await http().post('/api/v1/uploads/product-image').attach('file', PNG, 'a.png').expect(401);
  });

  it('answers "not found" for anything that is not a stored file name', async () => {
    await http().get(`/api/v1/files/${'a'.repeat(32)}.png`).expect(404);
    await http().get('/api/v1/files/..%2F..%2F.env').expect(404);
    await http().get('/api/v1/files/passwd').expect(404);
  });
});

describe('go-live checklist', () => {
  it('tells the owner what is not ready, without revealing any secret', async () => {
    const res = await owner.get('/system/status').expect(200);
    const item = (key: string) => res.body.items.find((i: { key: string }) => i.key === key);
    expect(item('environment').state).toBe('attention'); // tests do not run in production mode
    expect(item('storage').state).toBe('ready');
    expect(item('payments')).toMatchObject({ state: 'not_set' });
    expect(item('payments').detail).toMatch(/simulator/);
    expect(item('email').state).toBe('not_set');
    expect(item('address').state).toBe('attention'); // still localhost
    expect(item('menu').state).toBe('ready');
    expect(item('tax').state).toBe('ready');
    expect(res.body.total).toBe(res.body.items.length);
    const text = JSON.stringify(res.body);
    for (const secret of [process.env.JWT_ACCESS_SECRET!, process.env.JWT_REFRESH_SECRET!, process.env.PAYMENT_WEBHOOK_SECRET!, 'postgresql://']) expect(text).not.toContain(secret);
  });

  it('notices products that would be billed without tax', async () => {
    await prisma.product.update({ where: { id: f.tea.id }, data: { taxCategoryId: null } });
    const res = await owner.get('/system/status').expect(200);
    expect(res.body.items.find((i: { key: string }) => i.key === 'tax')).toMatchObject({ state: 'attention', detail: expect.stringContaining('1 active product') });
    // Another restaurant's untaxed product must not show up here.
    await prisma.product.update({ where: { id: other.tea.id }, data: { taxCategoryId: null } });
    expect((await owner.get('/system/status')).body.items.find((i: { key: string }) => i.key === 'tax').detail).toContain('1 active product');
  });

  it('is for people who manage the restaurant only', async () => {
    await cashier.get('/system/status').expect(403);
    await http().get('/api/v1/system/status').expect(401);
  });
});

describe('server hardening', () => {
  it('does not publish the API reference when it is switched off', async () => {
    await http().get('/api/docs').expect(404);
    await http().get('/api/docs-json').expect(404);
  });

  it('sends security headers and hides what the server is built with', async () => {
    const res = await http().get('/api/v1/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeTruthy();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('only answers browsers on the allowed origins', async () => {
    const allowed = await http().get('/api/v1/health').set('Origin', 'http://localhost:5173').expect(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const stranger = await http().get('/api/v1/health').set('Origin', 'https://evil.example').expect(200);
    expect(stranger.headers['access-control-allow-origin']).toBeUndefined();
  });
});
