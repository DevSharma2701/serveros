import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../common/prisma.service';
import { createTestApp, loginAs, order, seedTenant, teaLine, type Client, type Fixture } from './harness';

let app: NestExpressApplication;
let prisma: PrismaService;
let f: Fixture;
let owner: Client;
let manager: Client;
let cashier: Client;
let kitchen: Client;
let stores: Client;

beforeAll(async () => {
  ({ app, prisma } = await createTestApp());
  f = await seedTenant(prisma, 'stock');
  owner = await loginAs(app, f.users.owner.email, f.outletId);
  manager = await loginAs(app, f.users.manager.email, f.outletId);
  cashier = await loginAs(app, f.users.cashier.email, f.outletId);
  kitchen = await loginAs(app, f.users.kitchen.email, f.outletId);
  stores = await loginAs(app, f.users.inventory.email, f.outletId);
});
afterAll(() => app.close());

const balance = async (ingredientId = f.milkId, outletId = f.outletId): Promise<number> =>
  Number((await prisma.inventoryBalance.findUnique({ where: { outletId_ingredientId: { outletId, ingredientId } } }))?.quantity ?? 0);
const setMilk = (quantity: number) => prisma.inventoryBalance.update({ where: { outletId_ingredientId: { outletId: f.outletId, ingredientId: f.milkId } }, data: { quantity } });
const movementsFor = (orderId: string) => prisma.inventoryMovement.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
const ticketOf = async (orderId: string) => (await prisma.kitchenTicket.findFirstOrThrow({ where: { orderId } })).id;
const policy = (inventoryPolicy: string, allowNegativeStock = false) => owner.patch('/restaurant', { inventoryPolicy, allowNegativeStock }).expect(200);

describe('stock consumed by sales (each tea uses 100 ml of milk)', () => {
  beforeEach(() => setMilk(10_000));

  it('deducts once when the order is confirmed and never again as it moves on', async () => {
    const placed = await order(cashier, [teaLine(f, 2)]).expect(201);
    expect(await balance()).toBe(9_800);
    await kitchen.patch(`/kitchen/tickets/${await ticketOf(placed.body.id)}`, { status: 'PREPARING' }).expect(200);
    await kitchen.patch(`/kitchen/tickets/${await ticketOf(placed.body.id)}`, { status: 'READY' }).expect(200);
    await cashier.post(`/orders/${placed.body.id}/payments`, { tenders: [{ method: 'UPI', amountMinor: 21_000 }] }, { 'Idempotency-Key': `pay-${placed.body.id}` }).expect(201);
    await cashier.post(`/orders/${placed.body.id}/complete`).expect(200);
    expect(await balance()).toBe(9_800);
    const movements = await movementsFor(placed.body.id);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ type: 'SALE', refType: 'ORDER_ITEM', ingredientId: f.milkId });
    expect(Number(movements[0]!.quantityDelta)).toBe(-200);
    expect(Number(movements[0]!.balanceAfter)).toBe(9_800);
  });

  it('deducts only the new lines when items are added later', async () => {
    const placed = await order(cashier, [teaLine(f)]).expect(201);
    await cashier.post(`/orders/${placed.body.id}/items`, { items: [teaLine(f, 3)] }).expect(200);
    expect(await balance()).toBe(9_600);
    expect(await movementsFor(placed.body.id)).toHaveLength(2);
  });

  it('follows the configured policy: on completion, or not at all', async () => {
    await policy('ON_COMPLETE');
    const placed = await order(cashier, [teaLine(f)]).expect(201);
    expect(await balance()).toBe(10_000);
    await cashier.post(`/orders/${placed.body.id}/payments`, { tenders: [{ method: 'UPI', amountMinor: 10_500 }] }, { 'Idempotency-Key': `pay-${placed.body.id}` }).expect(201);
    await cashier.post(`/orders/${placed.body.id}/complete`).expect(200);
    expect(await balance()).toBe(9_900);

    await policy('NONE');
    const untracked = await order(cashier, [teaLine(f)]).expect(201);
    await cashier.post(`/orders/${untracked.body.id}/payments`, { tenders: [{ method: 'UPI', amountMinor: 10_500 }] }, { 'Idempotency-Key': `pay-${untracked.body.id}` }).expect(201);
    await cashier.post(`/orders/${untracked.body.id}/complete`).expect(200);
    expect(await balance()).toBe(9_900);
    await policy('ON_CONFIRM');
  });

  it('puts stock back when an order is cancelled before cooking starts, but not after', async () => {
    const early = await order(cashier, [teaLine(f, 2)]).expect(201);
    expect(await balance()).toBe(9_800);
    await manager.post(`/orders/${early.body.id}/cancel`, { reason: 'guest changed mind' }).expect(200);
    expect(await balance()).toBe(10_000);
    expect((await movementsFor(early.body.id)).map((m) => m.type)).toEqual(['SALE', 'SALE_REVERSAL']);

    const late = await order(cashier, [teaLine(f, 2)]).expect(201);
    await kitchen.patch(`/kitchen/tickets/${await ticketOf(late.body.id)}`, { status: 'PREPARING' }).expect(200);
    await manager.post(`/orders/${late.body.id}/cancel`, { reason: 'guest left' }).expect(200);
    expect(await balance()).toBe(9_800); // already made: the milk is gone
    expect((await movementsFor(late.body.id)).map((m) => m.type)).toEqual(['SALE']);
  });

  it('puts stock back when an item is voided before cooking starts', async () => {
    const placed = await order(cashier, [teaLine(f, 2), teaLine(f, 1)]).expect(201);
    expect(await balance()).toBe(9_700);
    await manager.post(`/orders/${placed.body.id}/items/${placed.body.items[0].id}/void`, { reason: 'ordered twice' }).expect(200);
    expect(await balance()).toBe(9_900);
  });

  it('blocks a sale that would take stock below zero and leaves no trace of it', async () => {
    await setMilk(250);
    const ordersBefore = await prisma.order.count();
    const res = await order(cashier, [teaLine(f, 3)]).expect(409);
    expect(res.body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { ingredient: 'Milk', available: '250', required: '300' } });
    expect(await prisma.order.count()).toBe(ordersBefore);
    expect(await balance()).toBe(250);
    await order(cashier, [teaLine(f, 2)]).expect(201);
    expect(await balance()).toBe(50);
  });

  it('never oversells when many orders compete for the last units', async () => {
    await setMilk(300); // enough for exactly three teas
    const results = await Promise.all(Array.from({ length: 10 }, () => order(cashier, [teaLine(f)])));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === 'INSUFFICIENT_STOCK')).toHaveLength(7);
    expect(await balance()).toBe(0);
    const ids = results.filter((r) => r.status === 201).map((r) => r.body.id);
    const sold = await prisma.inventoryMovement.aggregate({ where: { orderId: { in: ids } }, _sum: { quantityDelta: true } });
    expect(Number(sold._sum.quantityDelta)).toBe(-300);
  });

  it('allows negative stock only when the restaurant explicitly turns it on', async () => {
    await setMilk(50);
    await order(cashier, [teaLine(f)]).expect(409);
    await policy('ON_CONFIRM', true);
    await order(cashier, [teaLine(f)]).expect(201);
    expect(await balance()).toBe(-50);
    await policy('ON_CONFIRM', false);
  });
});

describe('recipes', () => {
  it('saving a recipe keeps the old version as history and uses the new one for sales', async () => {
    await setMilk(10_000);
    const saved = await stores.put('/recipes', { productId: f.tea.id, ingredients: [{ ingredientId: f.milkId, quantity: '0.15', unitId: f.units.l }], note: 'Bigger cup' }).expect(200);
    expect(saved.body.version).toBe(2);
    expect(Number(saved.body.ingredients[0].baseQuantity)).toBe(150); // 0.15 l -> 150 ml
    const history = (await stores.get(`/recipes?productId=${f.tea.id}`).expect(200)).body;
    expect(history.map((r: { version: number; isActive: boolean }) => [r.version, r.isActive])).toEqual([[2, true], [1, false]]);
    expect(history[0].costMinor).toBe(900); // 150 ml x 6 paise

    await order(cashier, [teaLine(f)]).expect(201);
    expect(await balance()).toBe(9_850);
    await cashier.put('/recipes', { productId: f.tea.id, ingredients: [{ ingredientId: f.milkId, quantity: '1', unitId: f.units.ml }] }).expect(403);
    await stores.put('/recipes', { productId: f.tea.id, ingredients: [{ ingredientId: f.milkId, quantity: '1', unitId: f.units.kg }] }).expect(400); // kg is not a volume
    await stores.put('/recipes', { productId: f.tea.id, ingredients: [{ ingredientId: f.milkId, quantity: '100', unitId: f.units.ml }] }).expect(200);
  });
});

describe('stock control', () => {
  it('records wastage and adjustments with a reason, converting units', async () => {
    await setMilk(1_000);
    await stores.post('/inventory/adjustments', { ingredientId: f.milkId, type: 'WASTAGE', quantity: '0.25', unitId: f.units.l, reason: 'Spilled a jug' }).expect(201);
    expect(await balance()).toBe(750);
    await stores.post('/inventory/adjustments', { ingredientId: f.milkId, type: 'ADJUSTMENT', direction: 'IN', quantity: '50', unitId: f.units.ml, reason: 'Found an unopened pack' }).expect(201);
    expect(await balance()).toBe(800);

    expect((await stores.post('/inventory/adjustments', { ingredientId: f.milkId, type: 'WASTAGE', quantity: '2', unitId: f.units.l, reason: 'More than we have' }).expect(409)).body.error.code).toBe('INSUFFICIENT_STOCK');
    await stores.post('/inventory/adjustments', { ingredientId: f.milkId, type: 'WASTAGE', quantity: '1', unitId: f.units.ml }).expect(400); // reason required
    await stores.post('/inventory/adjustments', { ingredientId: f.milkId, type: 'WASTAGE', quantity: '1', unitId: f.units.kg, reason: 'wrong unit' }).expect(400);
    await stores.post('/inventory/adjustments', { ingredientId: f.milkId, type: 'WASTAGE', quantity: '-5', unitId: f.units.ml, reason: 'negative' }).expect(400);
    await cashier.post('/inventory/adjustments', { ingredientId: f.milkId, type: 'ADJUSTMENT', direction: 'IN', quantity: '999', unitId: f.units.l, reason: 'free milk' }).expect(403);
    expect(await balance()).toBe(800);

    const log = (await stores.get(`/inventory/movements?ingredientId=${f.milkId}&type=WASTAGE`).expect(200)).body;
    expect(log.items[0]).toMatchObject({ type: 'WASTAGE', reason: 'Spilled a jug', ingredientName: 'Milk', createdById: f.users.inventory.id });
  });

  it('receives goods, converts purchase units and updates weighted average cost', async () => {
    const supplier = (await stores.post('/suppliers', { name: 'Grain Co' }).expect(201)).body;
    const receive = (unitCostMinor: number) =>
      stores.post('/goods-receipts', { supplierId: supplier.id, invoiceNumber: 'INV-77', items: [{ ingredientId: f.riceId, quantity: '10', unitId: f.units.kg, unitCostMinor }] }).expect(201);
    const first = await receive(5_000); // 10 kg at 50.00/kg
    expect(first.body.grnNumber).toMatch(/^GRN-\d{4}-0001$/);
    expect(await balance(f.riceId)).toBe(10_000);
    expect(Number((await prisma.ingredient.findUniqueOrThrow({ where: { id: f.riceId } })).costPerBaseMinor)).toBe(5); // 5 paise per gram
    await receive(7_000); // another 10 kg at 70.00/kg
    expect(await balance(f.riceId)).toBe(20_000);
    expect(Number((await prisma.ingredient.findUniqueOrThrow({ where: { id: f.riceId } })).costPerBaseMinor)).toBe(6); // average of 50 and 70 per kg

    const stock = (await stores.get('/inventory/stock').expect(200)).body;
    const rice = stock.find((s: { name: string }) => s.name === 'Rice');
    expect(rice).toMatchObject({ unit: 'g', isLow: false, valueMinor: 120_000 });
  });

  it('runs a purchase order from draft to fully received', async () => {
    const supplier = (await stores.post('/suppliers', { name: 'Dairy Fresh' }).expect(201)).body;
    const po = (await stores.post('/purchase-orders', { supplierId: supplier.id, items: [{ ingredientId: f.milkId, quantity: '10', unitId: f.units.l, unitCostMinor: 6_000 }] }).expect(201)).body;
    expect(po).toMatchObject({ status: 'DRAFT' });
    const line = { purchaseOrderItemId: po.items[0].id, ingredientId: f.milkId, unitId: f.units.l, unitCostMinor: 6_000 };
    expect((await stores.post('/goods-receipts', { purchaseOrderId: po.id, items: [{ ...line, quantity: '4' }] }).expect(409)).body.error.code).toBe('INVALID_STATE');
    await stores.post(`/purchase-orders/${po.id}/send`).expect(200);
    await setMilk(0);
    await stores.post('/goods-receipts', { purchaseOrderId: po.id, items: [{ ...line, quantity: '4' }] }).expect(201);
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe('PARTIALLY_RECEIVED');
    await stores.post('/goods-receipts', { purchaseOrderId: po.id, items: [{ ...line, quantity: '6' }] }).expect(201);
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe('RECEIVED');
    expect(await balance()).toBe(10_000);
    await stores.post(`/purchase-orders/${po.id}/cancel`).expect(409);
    await cashier.post('/purchase-orders', { supplierId: supplier.id, items: [{ ingredientId: f.milkId, quantity: '1', unitId: f.units.l, unitCostMinor: 1 }] }).expect(403);
  });

  it('a physical count records theoretical stock, the variance, and corrects the balance', async () => {
    const before = await balance(f.riceId); // 20,000 g
    const count = (await stores.post('/inventory/counts', { note: 'Month end', lines: [{ ingredientId: f.riceId, countedQty: '19.5', unitId: f.units.kg }] }).expect(201)).body;
    expect(count.status).toBe('DRAFT');
    expect(await balance(f.riceId)).toBe(before); // nothing changes until it is posted
    const posted = (await stores.post(`/inventory/counts/${count.id}/post`).expect(200)).body;
    expect(posted.status).toBe('POSTED');
    expect(Number(posted.lines[0].theoreticalQty)).toBe(20_000);
    expect(Number(posted.lines[0].countedQty)).toBe(19_500);
    expect(Number(posted.lines[0].varianceQty)).toBe(-500);
    expect(await balance(f.riceId)).toBe(19_500);
    const correction = await prisma.inventoryMovement.findFirstOrThrow({ where: { refType: 'COUNT', refId: count.id } });
    expect(correction.type).toBe('COUNT_CORRECTION');
    await stores.post(`/inventory/counts/${count.id}/post`).expect(409); // cannot be posted twice
  });

  it('transfers stock between outlets as a matched pair of movements', async () => {
    const res = await stores.post('/inventory/transfers', { toOutletId: f.outlet2Id, lines: [{ ingredientId: f.riceId, quantity: '2', unitId: f.units.kg }] }).expect(201);
    expect(await balance(f.riceId)).toBe(17_500);
    expect(await balance(f.riceId, f.outlet2Id)).toBe(2_000);
    const pair = await prisma.inventoryMovement.findMany({ where: { refType: 'TRANSFER', refId: res.body.transferId }, orderBy: { type: 'asc' } });
    expect(pair.map((m) => [m.type, Number(m.quantityDelta), m.outletId])).toEqual([['TRANSFER_OUT', -2_000, f.outletId], ['TRANSFER_IN', 2_000, f.outlet2Id]]);
    expect((await stores.post('/inventory/transfers', { toOutletId: f.outlet2Id, lines: [{ ingredientId: f.riceId, quantity: '500', unitId: f.units.kg }] }).expect(409)).body.error.code).toBe('INSUFFICIENT_STOCK');
    await stores.post('/inventory/transfers', { toOutletId: f.outletId, lines: [{ ingredientId: f.riceId, quantity: '1', unitId: f.units.kg }] }).expect(400);
    expect(await balance(f.riceId)).toBe(17_500);
  });

  it('flags low stock', async () => {
    await setMilk(400); // threshold is 500
    const stock = (await stores.get('/inventory/stock').expect(200)).body;
    expect(stock.find((s: { name: string }) => s.name === 'Milk').isLow).toBe(true);
    const dashboard = (await owner.get('/reports/dashboard?from=2026-01-01&to=2026-12-31').expect(200)).body;
    expect(dashboard.inventoryAlerts.some((a: { name: string; outletId: string }) => a.name === 'Milk' && a.outletId === f.outletId)).toBe(true);
  });
});
