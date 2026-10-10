/** Fixtures shaped exactly like the real API responses (captured from the dev API, values simplified). */
import type { Dashboard, Me, OutletRef } from '../src/lib/types';

export const INDIRANAGAR: OutletRef = { id: '01a124d4-d72b-7ba1-8b66-5b3526cee83f', name: 'Indiranagar', code: 'BLR1', timezone: 'Asia/Kolkata', city: 'Bengaluru', stateCode: '29' };
export const KORAMANGALA: OutletRef = { id: '01a124d4-d7a7-7cc1-9e76-386ca6b78d00', name: 'Koramangala', code: 'BLR2', timezone: 'Asia/Kolkata', city: 'Bengaluru', stateCode: '29' };

const restaurant = { id: 'r1', name: 'Saffron Table', currency: 'INR' };

export const OWNER: Me = {
  user: { id: 'u-owner', name: 'Meera Iyer', email: 'owner@saffrontable.test', role: { key: 'RESTAURANT_OWNER', name: 'Restaurant owner', rank: 90 } },
  restaurant,
  outlets: [INDIRANAGAR, KORAMANGALA],
  permissions: ['audit.view', 'inventory.view', 'menu.availability', 'menu.view', 'order.view', 'report.view', 'shift.operate', 'shift.view_all', 'staff.view'],
  outletPermissions: {},
};

export const MANAGER: Me = {
  user: { id: 'u-manager', name: 'Arjun Rao', email: 'manager@saffrontable.test', role: { key: 'OUTLET_MANAGER', name: 'Outlet manager', rank: 60 } },
  restaurant,
  outlets: [INDIRANAGAR],
  permissions: ['audit.view', 'inventory.view', 'menu.availability', 'menu.view', 'order.view', 'report.view', 'shift.operate', 'shift.view_all', 'staff.view'],
  outletPermissions: {},
};

export const CASHIER: Me = {
  user: { id: 'u-cashier', name: 'Rohan Das', email: 'cashier@saffrontable.test', role: { key: 'CASHIER', name: 'Cashier', rank: 30 } },
  restaurant,
  outlets: [INDIRANAGAR],
  permissions: ['menu.view', 'order.view', 'shift.operate'],
  outletPermissions: {},
};

export const TOKENS = { accessToken: 'access-1', expiresIn: 900, refreshToken: 'refresh-1' };

export const DASHBOARD: Dashboard = {
  range: { from: '2026-10-10', to: '2026-10-10' },
  outlets: [{ id: INDIRANAGAR.id, name: 'Indiranagar', timezone: 'Asia/Kolkata' }],
  definitions: { scope: 'Sales figures cover orders COMPLETED in the period.' },
  summary: {
    orders: 8,
    grossSalesMinor: 674000,
    discountsMinor: 0,
    serviceChargeMinor: 0,
    deliveryChargeMinor: 8000,
    netSalesMinor: 682000,
    taxesMinor: 34100,
    roundOffMinor: 0,
    totalBilledMinor: 716100,
    averageOrderValueMinor: 89513,
    collectedMinor: 716100,
    refundsMinor: 0,
    netCollectedMinor: 716100,
    cancelledOrders: 1,
    openOrders: 2,
    cashVarianceMinor: -2000,
  },
  paymentsByMethod: [
    { method: 'UPI', count: 5, amountMinor: 424200, refundedMinor: 0 },
    { method: 'CASH', count: 2, amountMinor: 155400, refundedMinor: 0 },
  ],
  salesByType: [{ type: 'DINE_IN', orders: 2, totalMinor: 182700 }],
  topProducts: [{ productId: 'p1', name: 'Paneer Butter Masala', quantity: 5, netSalesMinor: 164000 }],
  categories: [{ name: 'Mains', quantity: 9, netSalesMinor: 300000 }],
  hourly: [{ hour: 13, orders: 8, totalMinor: 716100 }],
  daily: [{ day: '2026-10-10', orders: 8, totalMinor: 716100, netSalesMinor: 682000 }],
  outletComparison: [{ outletId: INDIRANAGAR.id, outlet: 'Indiranagar', orders: 8, netSalesMinor: 682000, totalBilledMinor: 716100, cancelledOrders: 1 }],
  cashShifts: [{ id: 's1', openedByName: 'Meera Iyer', closedAt: '2026-10-10T08:01:55.608Z', expectedCashMinor: 1645400, countedCashMinor: 1643400, varianceMinor: -2000, register: 'Counter 2', outlet: 'Indiranagar' }],
  inventoryAlerts: [{ outletId: INDIRANAGAR.id, outlet: 'Indiranagar', ingredientId: 'i1', name: 'Paneer', quantity: '1500', threshold: '2000', unit: 'g' }],
};
