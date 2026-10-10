/**
 * Development seed: a fictional restaurant with two outlets, a menu, recipes, stock and demo users.
 *
 *   pnpm db:seed
 *
 * Every demo user gets the password in SEED_DEMO_PASSWORD (.env). Nothing here is for production,
 * and the script refuses to run with NODE_ENV=production.
 */
import { hash } from '@node-rs/argon2';
import { Prisma, PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { syncAccessCatalogue } from '../apps/api/src/common/access-catalogue';

config({ path: resolve(__dirname, '../.env'), quiet: true } as never);

const prisma = new PrismaClient();
const D = (v: number | string) => new Prisma.Decimal(v);
const rupees = (v: number) => Math.round(v * 100);

type Tax = 'food' | 'packaged';
interface ProductSeed {
  category: string;
  name: string;
  sku: string;
  veg: boolean;
  station: string;
  tax?: Tax;
  favorite?: boolean;
  variants: Array<{ name: string; price: number; recipe?: Record<string, number> }>;
  modifiers?: string[];
  /** Recipe for every variant that has none of its own: ingredient sku -> quantity in base unit. */
  recipe?: Record<string, number>;
}

const INGREDIENTS: Array<[sku: string, name: string, unit: string, lowAt: number, costPerBasePaise: number]> = [
  ['PANEER', 'Paneer', 'g', 2000, 40],
  ['CHICKEN', 'Chicken (boneless)', 'g', 3000, 28],
  ['YOGURT', 'Yogurt', 'g', 2000, 8],
  ['SPICE', 'House spice mix', 'g', 500, 60],
  ['OIL', 'Cooking oil', 'ml', 2000, 15],
  ['MIXVEG', 'Mixed vegetables', 'g', 2000, 6],
  ['FLOUR', 'Wheat flour', 'g', 5000, 4.5],
  ['BUTTER', 'Butter', 'g', 1000, 55],
  ['TOMATO', 'Tomato', 'g', 3000, 4],
  ['CREAM', 'Fresh cream', 'ml', 1000, 25],
  ['LENTIL', 'Black lentils', 'g', 2000, 14],
  ['RICE', 'Basmati rice', 'g', 5000, 11],
  ['MILK', 'Milk', 'ml', 5000, 6],
  ['TEA', 'Tea leaves', 'g', 300, 50],
  ['COFFEE', 'Coffee powder', 'g', 300, 90],
  ['SUGAR', 'Sugar', 'g', 2000, 4.5],
  ['LIME', 'Lime', 'pc', 20, 500],
  ['SODA', 'Soda', 'ml', 2000, 2],
  ['MANGO', 'Mango pulp', 'g', 1000, 18],
  ['WATER1L', 'Mineral water 1 L bottle', 'pc', 24, 1200],
  ['JAMUN', 'Gulab jamun (piece)', 'pc', 30, 1500],
  ['KULFI', 'Kulfi (piece)', 'pc', 20, 3500],
];

const PRODUCTS: ProductSeed[] = [
  { category: 'Starters', name: 'Paneer Tikka', sku: 'STR-001', veg: true, station: 'GRILL', favorite: true, modifiers: ['Spice level'], variants: [{ name: 'Regular', price: 280 }], recipe: { PANEER: 180, YOGURT: 40, SPICE: 10, OIL: 10 } },
  { category: 'Starters', name: 'Chicken Tikka', sku: 'STR-002', veg: false, station: 'GRILL', modifiers: ['Spice level'], variants: [{ name: 'Regular', price: 320 }], recipe: { CHICKEN: 200, YOGURT: 40, SPICE: 10 } },
  { category: 'Starters', name: 'Veg Spring Rolls', sku: 'STR-003', veg: true, station: 'HOT', variants: [{ name: 'Regular', price: 220 }], recipe: { MIXVEG: 120, FLOUR: 60, OIL: 30 } },
  {
    category: 'Mains', name: 'Butter Chicken', sku: 'MAN-001', veg: false, station: 'HOT', favorite: true, modifiers: ['Spice level', 'Extras'],
    variants: [
      { name: 'Half', price: 260, recipe: { CHICKEN: 160, BUTTER: 20, TOMATO: 80, CREAM: 30 } },
      { name: 'Full', price: 420, recipe: { CHICKEN: 300, BUTTER: 40, TOMATO: 150, CREAM: 50 } },
    ],
  },
  { category: 'Mains', name: 'Paneer Butter Masala', sku: 'MAN-002', veg: true, station: 'HOT', modifiers: ['Spice level', 'Extras'], variants: [{ name: 'Regular', price: 300 }], recipe: { PANEER: 200, BUTTER: 30, TOMATO: 150, CREAM: 40 } },
  { category: 'Mains', name: 'Dal Makhani', sku: 'MAN-003', veg: true, station: 'HOT', modifiers: ['Extras'], variants: [{ name: 'Regular', price: 240 }], recipe: { LENTIL: 120, BUTTER: 30, CREAM: 30 } },
  { category: 'Breads', name: 'Butter Naan', sku: 'BRD-001', veg: true, station: 'GRILL', favorite: true, variants: [{ name: 'Regular', price: 60 }], recipe: { FLOUR: 90, BUTTER: 10 } },
  { category: 'Breads', name: 'Tandoori Roti', sku: 'BRD-002', veg: true, station: 'GRILL', variants: [{ name: 'Regular', price: 40 }], recipe: { FLOUR: 70 } },
  {
    category: 'Rice & Biryani', name: 'Chicken Biryani', sku: 'RIC-001', veg: false, station: 'HOT', favorite: true, modifiers: ['Spice level'],
    variants: [
      { name: 'Regular', price: 320, recipe: { RICE: 180, CHICKEN: 200, SPICE: 15, OIL: 20 } },
      { name: 'Family', price: 580, recipe: { RICE: 360, CHICKEN: 400, SPICE: 30, OIL: 40 } },
    ],
  },
  { category: 'Rice & Biryani', name: 'Veg Biryani', sku: 'RIC-002', veg: true, station: 'HOT', modifiers: ['Spice level'], variants: [{ name: 'Regular', price: 260 }], recipe: { RICE: 180, MIXVEG: 150, SPICE: 15 } },
  { category: 'Rice & Biryani', name: 'Steamed Rice', sku: 'RIC-003', veg: true, station: 'HOT', variants: [{ name: 'Regular', price: 120 }], recipe: { RICE: 150 } },
  { category: 'Beverages', name: 'Masala Chai', sku: 'BEV-001', veg: true, station: 'BEVERAGE', favorite: true, modifiers: ['Milk'], variants: [{ name: 'Regular', price: 60 }], recipe: { MILK: 100, TEA: 5, SUGAR: 10 } },
  { category: 'Beverages', name: 'Filter Coffee', sku: 'BEV-002', veg: true, station: 'BEVERAGE', modifiers: ['Milk'], variants: [{ name: 'Regular', price: 80 }], recipe: { MILK: 120, COFFEE: 10, SUGAR: 10 } },
  { category: 'Beverages', name: 'Fresh Lime Soda', sku: 'BEV-003', veg: true, station: 'BEVERAGE', variants: [{ name: 'Sweet', price: 90 }, { name: 'Salted', price: 90 }], recipe: { LIME: 1, SODA: 200, SUGAR: 15 } },
  { category: 'Beverages', name: 'Mango Lassi', sku: 'BEV-004', veg: true, station: 'BEVERAGE', variants: [{ name: 'Regular', price: 140 }], recipe: { YOGURT: 180, MANGO: 80, SUGAR: 15 } },
  { category: 'Beverages', name: 'Mineral Water 1 L', sku: 'BEV-005', veg: true, station: 'BEVERAGE', tax: 'packaged', variants: [{ name: 'Regular', price: 40 }], recipe: { WATER1L: 1 } },
  { category: 'Desserts', name: 'Gulab Jamun (2 pc)', sku: 'DES-001', veg: true, station: 'DESSERT', variants: [{ name: 'Regular', price: 120 }], recipe: { JAMUN: 2 } },
  { category: 'Desserts', name: 'Kulfi', sku: 'DES-002', veg: true, station: 'DESSERT', variants: [{ name: 'Regular', price: 140 }], recipe: { KULFI: 1 } },
];

const MODIFIER_GROUPS = [
  { name: 'Spice level', minSelect: 1, maxSelect: 1, options: [['Mild', 0], ['Medium', 0], ['Spicy', 0]] },
  { name: 'Extras', minSelect: 0, maxSelect: 3, options: [['Extra butter', 30], ['Extra gravy', 50], ['Extra paneer', 80]] },
  { name: 'Milk', minSelect: 0, maxSelect: 1, options: [['Less sugar', 0], ['No sugar', 0], ['Almond milk', 40]] },
] as const;

const STATIONS = [
  ['HOT', 'Hot kitchen', true],
  ['GRILL', 'Grill & tandoor', false],
  ['BEVERAGE', 'Beverages', false],
  ['DESSERT', 'Desserts', false],
  ['PACKING', 'Packing', false],
] as const;

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('The development seed must not run in production.');
  const password = process.env.SEED_DEMO_PASSWORD ?? '';
  if (password.length < 10) throw new Error('Set SEED_DEMO_PASSWORD (at least 10 characters) in .env before seeding.');
  if (await prisma.restaurant.findUnique({ where: { slug: 'saffron-table' } })) {
    console.log('Demo data already exists. Run "pnpm db:reset" first if you want a fresh copy.');
    return;
  }

  await syncAccessCatalogue(prisma);
  const roles = Object.fromEntries((await prisma.role.findMany({ where: { restaurantId: null } })).map((r) => [r.key, r.id]));
  const passwordHash = await hash(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });

  const restaurant = await prisma.restaurant.create({
    data: {
      name: 'Saffron Table', legalName: 'Saffron Table Hospitality Pvt Ltd (demo)', slug: 'saffron-table', gstin: '29ABCDE1234F1Z5',
      addressLine1: '12 Demo Street', city: 'Bengaluru', stateCode: '29', postalCode: '560038',
      receiptFooter: 'Thank you! Visit again.', loyaltyEnabled: true, serviceChargeBps: 500,
    },
  });
  const restaurantId = restaurant.id;

  const outlets = await Promise.all(
    [
      { name: 'Indiranagar', code: 'BLR1', addressLine1: '12 Demo Street, Indiranagar', postalCode: '560038', phone: '080-5550-0101', deliveryChargeMinor: rupees(40) },
      { name: 'Koramangala', code: 'BLR2', addressLine1: '48 Sample Road, Koramangala', postalCode: '560034', phone: '080-5550-0102', deliveryChargeMinor: rupees(50) },
    ].map((o) => prisma.outlet.create({ data: { ...o, restaurantId, city: 'Bengaluru', stateCode: '29', gstin: '29ABCDE1234F1Z5', fssaiNumber: '11200000000000', timezone: 'Asia/Kolkata' } })),
  );
  const [blr1, blr2] = outlets as [typeof outlets[number], typeof outlets[number]];

  // ── Users ──
  const user = (email: string, name: string, role: string, jobTitle: string, access: 'all' | string[], rid: string | null = restaurantId) =>
    prisma.user.create({
      data: {
        restaurantId: rid, roleId: roles[role]!, email, name, jobTitle, passwordHash, status: 'ACTIVE', allOutlets: access === 'all',
        assignments: access === 'all' ? undefined : { create: access.map((outletId) => ({ outletId })) },
      },
    });
  await user('platform@serveos.test', 'Platform Admin', 'PLATFORM_ADMIN', 'Platform', 'all', null);
  const owner = await user('owner@saffrontable.test', 'Meera Iyer', 'RESTAURANT_OWNER', 'Owner', 'all');
  await user('admin@saffrontable.test', 'Arjun Rao', 'RESTAURANT_ADMIN', 'Operations head', 'all');
  await user('manager@saffrontable.test', 'Kavya Nair', 'OUTLET_MANAGER', 'Outlet manager', [blr1.id]);
  await user('cashier@saffrontable.test', 'Rohan Das', 'CASHIER', 'Cashier', [blr1.id]);
  await user('waiter@saffrontable.test', 'Sana Khan', 'WAITER', 'Captain', [blr1.id]);
  await user('kitchen@saffrontable.test', 'Vikram Singh', 'KITCHEN_STAFF', 'Line cook', [blr1.id]);
  await user('inventory@saffrontable.test', 'Deepa Menon', 'INVENTORY_MANAGER', 'Stores', [blr1.id, blr2.id]);

  // ── Tax (illustrative rates only; confirm the correct treatment with a tax professional) ──
  const gst = (rate: number) => [
    { component: 'CGST' as const, name: `CGST ${rate / 2}%`, rateBps: (rate / 2) * 100, scope: 'INTRA_STATE' as const },
    { component: 'SGST' as const, name: `SGST ${rate / 2}%`, rateBps: (rate / 2) * 100, scope: 'INTRA_STATE' as const },
    { component: 'IGST' as const, name: `IGST ${rate}%`, rateBps: rate * 100, scope: 'INTER_STATE' as const },
  ];
  const taxFood = await prisma.taxCategory.create({ data: { restaurantId, name: 'Restaurant service 5%', hsnSac: '996331', rules: { create: gst(5) } } });
  const taxPackaged = await prisma.taxCategory.create({ data: { restaurantId, name: 'Packaged goods 18%', hsnSac: '2201', rules: { create: gst(18) } } });
  await prisma.restaurant.update({ where: { id: restaurantId }, data: { serviceChargeTaxCategoryId: taxFood.id, deliveryChargeTaxCategoryId: taxFood.id } });

  // ── Units, suppliers, ingredients and opening stock ──
  const unitSeeds = [
    ['g', 'Gram', 'MASS', 1], ['kg', 'Kilogram', 'MASS', 1000], ['ml', 'Millilitre', 'VOLUME', 1], ['l', 'Litre', 'VOLUME', 1000], ['pc', 'Piece', 'COUNT', 1], ['dozen', 'Dozen', 'COUNT', 12],
  ] as const;
  await prisma.unitOfMeasure.createMany({ data: unitSeeds.map(([code, name, dimension, factor]) => ({ restaurantId, code, name, dimension, toBaseFactor: D(factor) })) });
  const units = Object.fromEntries((await prisma.unitOfMeasure.findMany({ where: { restaurantId } })).map((u) => [u.code, u.id]));
  const supplier = await prisma.supplier.create({ data: { restaurantId, name: 'Fresh Farm Supplies (demo)', contactName: 'Imran', phone: '9000000001', address: 'KR Market, Bengaluru' } });
  await prisma.supplier.create({ data: { restaurantId, name: 'Metro Dry Goods (demo)', contactName: 'Latha', phone: '9000000002', address: 'Yeshwanthpur, Bengaluru' } });

  const ingredientId: Record<string, string> = {};
  for (const [sku, name, unit, lowAt, cost] of INGREDIENTS) {
    const ingredient = await prisma.ingredient.create({
      data: { restaurantId, sku, name, baseUnitId: units[unit]!, lowStockThreshold: D(lowAt), costPerBaseMinor: D(cost), supplierId: supplier.id },
    });
    ingredientId[sku] = ingredient.id;
    for (const outlet of outlets) {
      // Koramangala starts low on paneer so the low-stock alert has something to show.
      const quantity = D(outlet.id === blr2.id && sku === 'PANEER' ? lowAt * 0.75 : lowAt * 8);
      await prisma.inventoryBalance.create({ data: { outletId: outlet.id, ingredientId: ingredient.id, quantity } });
      await prisma.inventoryMovement.create({
        data: { restaurantId, outletId: outlet.id, ingredientId: ingredient.id, type: 'RECEIPT', quantityDelta: quantity, balanceAfter: quantity, unitCostMinor: D(cost), refType: 'SEED', refId: 'opening-stock', reason: 'Opening stock (demo)', createdById: owner.id },
      });
    }
  }

  // ── Menu ──
  const groupId: Record<string, string> = {};
  for (const g of MODIFIER_GROUPS) {
    const group = await prisma.modifierGroup.create({
      data: { restaurantId, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, options: { create: g.options.map(([name, price], sortOrder) => ({ name, priceMinor: rupees(price), sortOrder })) } },
    });
    groupId[g.name] = group.id;
  }
  const categoryId: Record<string, string> = {};
  for (const [sortOrder, name] of [...new Set(PRODUCTS.map((p) => p.category))].entries()) {
    categoryId[name] = (await prisma.category.create({ data: { restaurantId, name, sortOrder } })).id;
  }
  for (const [sortOrder, p] of PRODUCTS.entries()) {
    const product = await prisma.product.create({
      data: {
        restaurantId, categoryId: categoryId[p.category]!, taxCategoryId: p.tax === 'packaged' ? taxPackaged.id : taxFood.id, name: p.name, sku: p.sku, isVeg: p.veg,
        isFavorite: p.favorite ?? false, stationKey: p.station, sortOrder,
        variants: { create: p.variants.map((v, i) => ({ name: v.name, priceMinor: rupees(v.price), isDefault: i === 0, sortOrder: i })) },
        modifierGroups: { create: (p.modifiers ?? []).map((name, i) => ({ modifierGroupId: groupId[name]!, sortOrder: i })) },
      },
      include: { variants: true },
    });
    const recipes: Array<{ variantId: string | null; lines: Record<string, number> }> = [];
    if (p.recipe) recipes.push({ variantId: null, lines: p.recipe });
    for (const v of p.variants) if (v.recipe) recipes.push({ variantId: product.variants.find((x) => x.name === v.name)!.id, lines: v.recipe });
    for (const r of recipes) {
      await prisma.recipe.create({
        data: {
          restaurantId, productId: product.id, variantId: r.variantId, createdById: owner.id,
          ingredients: {
            create: Object.entries(r.lines).map(([sku, qty]) => {
              const unit = INGREDIENTS.find((i) => i[0] === sku)![2];
              return { ingredientId: ingredientId[sku]!, quantity: D(qty), unitId: units[unit]!, baseQuantity: D(qty) };
            }),
          },
        },
      });
    }
  }

  // ── Outlet set-up: stations, registers, floor ──
  for (const outlet of outlets) {
    await prisma.kitchenStation.createMany({ data: STATIONS.map(([key, name, isDefault], sortOrder) => ({ restaurantId, outletId: outlet.id, key, name, isDefault, sortOrder })) });
    await prisma.cashRegister.createMany({ data: ['Counter 1', 'Counter 2'].map((name) => ({ restaurantId, outletId: outlet.id, name })) });
    const hall = await prisma.diningArea.create({ data: { restaurantId, outletId: outlet.id, name: 'Main hall', sortOrder: 0 } });
    const patio = await prisma.diningArea.create({ data: { restaurantId, outletId: outlet.id, name: 'Patio', sortOrder: 1 } });
    await prisma.restaurantTable.createMany({
      data: [
        ...Array.from({ length: 8 }, (_, i) => ({ restaurantId, outletId: outlet.id, areaId: hall.id, name: `T${i + 1}`, capacity: i < 4 ? 2 : 4, posX: (i % 4) * 160, posY: Math.floor(i / 4) * 160, shape: i < 4 ? 'round' : 'square' })),
        ...Array.from({ length: 4 }, (_, i) => ({ restaurantId, outletId: outlet.id, areaId: patio.id, name: `P${i + 1}`, capacity: 6, posX: i * 180, posY: 0, shape: 'rect' })),
      ],
    });
  }

  // ── Customers and a coupon ──
  await prisma.customer.createMany({
    data: [
      { restaurantId, name: 'Ananya Sharma', phone: '9811100001', marketingSms: true, consentUpdatedAt: new Date() },
      { restaurantId, name: 'Rahul Verma', phone: '9811100002' },
      { restaurantId, name: 'Priya Pillai', phone: '9811100003', email: 'priya@example.test', marketingEmail: true, consentUpdatedAt: new Date() },
    ],
  });
  await prisma.discount.create({ data: { restaurantId, name: 'Welcome 10%', code: 'WELCOME10', type: 'PERCENT', value: 1000, maxDiscountMinor: rupees(150), minOrderMinor: rupees(300) } });

  // ── A second, unrelated restaurant: lets you see that tenants cannot reach each other's data ──
  const other = await prisma.restaurant.create({ data: { name: 'Blue Lotus Café', legalName: 'Blue Lotus Foods LLP (demo)', slug: 'blue-lotus', stateCode: '27', city: 'Pune' } });
  const otherOutlet = await prisma.outlet.create({ data: { restaurantId: other.id, name: 'Baner', code: 'PUN1', city: 'Pune', stateCode: '27' } });
  await prisma.kitchenStation.create({ data: { restaurantId: other.id, outletId: otherOutlet.id, key: 'MAIN', name: 'Main kitchen', isDefault: true } });
  await prisma.cashRegister.create({ data: { restaurantId: other.id, outletId: otherOutlet.id, name: 'Counter 1' } });
  await prisma.unitOfMeasure.createMany({ data: unitSeeds.map(([code, name, dimension, factor]) => ({ restaurantId: other.id, code, name, dimension, toBaseFactor: D(factor) })) });
  await user('owner@bluelotus.test', 'Neha Kulkarni', 'RESTAURANT_OWNER', 'Owner', 'all', other.id);

  console.log('\nServeOS demo data created.\n');
  console.log('  Restaurant : Saffron Table (outlets: Indiranagar, Koramangala)');
  console.log('  Sign in at : http://localhost:5173 with any of these emails');
  for (const [email, role] of [
    ['owner@saffrontable.test', 'Owner'], ['admin@saffrontable.test', 'Restaurant admin'], ['manager@saffrontable.test', 'Outlet manager'], ['cashier@saffrontable.test', 'Cashier'],
    ['waiter@saffrontable.test', 'Waiter'], ['kitchen@saffrontable.test', 'Kitchen staff'], ['inventory@saffrontable.test', 'Inventory manager'],
    ['owner@bluelotus.test', 'Owner of a different restaurant'], ['platform@serveos.test', 'Platform admin'],
  ]) console.log(`    ${email.padEnd(30)} ${role}`);
  console.log('  Password   : the value of SEED_DEMO_PASSWORD in your .env file');
  console.log('\n  Next: "pnpm db:seed:orders" adds a few days of sample orders.\n');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
