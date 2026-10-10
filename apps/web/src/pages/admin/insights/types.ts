/** Shape of GET /reports/dashboard (apps/api/src/modules/reports.module.ts). */
export interface DashboardSummary {
  orders: number;
  grossSalesMinor: number;
  discountsMinor: number;
  serviceChargeMinor: number;
  deliveryChargeMinor: number;
  netSalesMinor: number;
  taxesMinor: number;
  roundOffMinor: number;
  totalBilledMinor: number;
  averageOrderValueMinor: number;
  collectedMinor: number;
  refundsMinor: number;
  netCollectedMinor: number;
  cancelledOrders: number;
  openOrders: number;
  cashVarianceMinor: number;
}

export interface DashboardCashShift {
  id: string;
  openedByName: string;
  closedAt: string | null;
  expectedCashMinor: number | null;
  countedCashMinor: number | null;
  varianceMinor: number | null;
  register: string;
  outlet: string;
}

export interface InventoryAlert {
  outletId: string;
  outlet: string;
  ingredientId: string;
  name: string;
  quantity: string;
  threshold: string;
  unit: string;
}

export interface DashboardResponse {
  range: { from: string; to: string };
  outlets: Array<{ id: string; name: string; timezone: string }>;
  /** How each headline number is calculated, written by the API. */
  definitions: Record<string, string>;
  summary: DashboardSummary;
  paymentsByMethod: Array<{ method: string; count: number; amountMinor: number; refundedMinor: number }>;
  salesByType: Array<{ type: string; orders: number; totalMinor: number }>;
  topProducts: Array<{ productId: string; name: string; quantity: number; netSalesMinor: number }>;
  categories: Array<{ name: string; quantity: number; netSalesMinor: number }>;
  taxes: Array<{ name: string; rateBps: number; taxableMinor: number; amountMinor: number }>;
  hourly: Array<{ hour: number; orders: number; totalMinor: number }>;
  daily: Array<{ day: string; orders: number; totalMinor: number; netSalesMinor: number }>;
  outletComparison: Array<{ outletId: string; outlet: string; orders: number; netSalesMinor: number; totalBilledMinor: number; cancelledOrders: number }>;
  cashShifts: DashboardCashShift[];
  inventoryAlerts: InventoryAlert[];
}

export type ExportDataset = 'orders' | 'items' | 'payments';
