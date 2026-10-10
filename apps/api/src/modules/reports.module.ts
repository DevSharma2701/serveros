import { Controller, Get, Header, Injectable, Module, Query, Res, ServiceUnavailableException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import { exportQuery, reportQuery } from '@serveos/shared';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Ctx, Public, RequirePermissions, type RequestContext } from '../common/context';
import { badRequest, forbidden, notFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AuditService, EmailService } from '../common/services';
import { csv, localDayRange } from '../common/util';
import { isProduction } from '../config/env';

class ReportQueryDto extends createZodDto(reportQuery) {}
class ExportQueryDto extends createZodDto(exportQuery) {}

/** How each headline number is calculated. Returned with the data so screens can explain themselves. */
export const METRIC_DEFINITIONS = {
  scope: 'Sales figures cover orders COMPLETED in the period (by completion time in each outlet\'s time zone), including ones refunded later. Cancelled and unfinished orders are excluded.',
  grossSales: 'Sum of item amounts at menu price (price + add-ons, times quantity) before any discount. If your menu prices include tax, this figure includes tax too.',
  discounts: 'Item-level plus order-level discounts given on those orders.',
  netSales: 'Taxable value of those orders: after discounts, before tax, including service and delivery charges.',
  taxes: 'Tax recorded on those orders, as shown on their bills.',
  totalBilled: 'Grand total of those orders: net sales + taxes + round-off.',
  averageOrderValue: 'Total billed divided by the number of completed orders.',
  collected: 'Successful payments received in the period, by method. A payment is counted once, when it succeeded.',
  refunds: 'Refunds issued in the period, counted on the day of the refund (not the day of the original sale). They are not subtracted from net sales.',
  netCollected: 'Collected minus refunds.',
  cancelledOrders: 'Orders that were placed and then cancelled in the period (by cancellation time). Discarded drafts are not counted.',
  openOrders: 'Orders placed but not yet completed or cancelled, right now. This figure ignores the date range.',
  cashVariance: 'Counted cash minus expected cash for shifts closed in the period. Negative means cash was short.',
} as const;

type Range = { gte: Date; lt: Date };
type OutletRef = { id: string; name: string; timezone: string };
const num = (v: bigint | number | null | undefined): number => Number(v ?? 0);

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The outlets a report may cover: those asked for, limited to the ones this user is assigned to. */
  private async outlets(ctx: RequestContext, requested: string | undefined): Promise<OutletRef[]> {
    let ids = ctx.outletIds;
    if (requested) {
      const parsed = z.array(z.uuid()).max(200).safeParse(requested.split(',').filter(Boolean));
      if (!parsed.success) throw badRequest('INVALID_OUTLETS', 'outletIds must be a comma separated list of ids');
      if (parsed.data.some((id) => !ctx.outletIds.includes(id))) throw forbidden('You are not assigned to one of these outlets');
      ids = parsed.data;
    }
    const outlets = await this.prisma.outlet.findMany({ where: { id: { in: ids }, restaurantId: ctx.restaurantId }, select: { id: true, name: true, timezone: true }, orderBy: { name: 'asc' } });
    if (outlets.length === 0) throw notFound('Outlet');
    return outlets;
  }

  private async outletReport(outlet: OutletRef, range: Range) {
    const sold: Prisma.OrderWhereInput = { outletId: outlet.id, status: { in: ['COMPLETED', 'REFUNDED'] }, completedAt: range };
    const [totals, byType, payments, refunds, products, categories, taxes, hourly, daily, cancelled, shifts, openOrders] = await Promise.all([
      this.prisma.order.aggregate({
        where: sold,
        _count: true,
        _sum: { subtotalMinor: true, itemDiscountMinor: true, orderDiscountMinor: true, serviceChargeMinor: true, deliveryChargeMinor: true, taxableMinor: true, taxMinor: true, roundOffMinor: true, totalMinor: true },
      }),
      this.prisma.order.groupBy({ by: ['type'], where: sold, _count: true, _sum: { totalMinor: true } }),
      this.prisma.payment.groupBy({ by: ['method'], where: { outletId: outlet.id, state: 'SUCCEEDED', succeededAt: range }, _count: true, _sum: { amountMinor: true } }),
      this.prisma.refund.findMany({ where: { outletId: outlet.id, createdAt: range }, select: { amountMinor: true, payment: { select: { method: true } } } }),
      this.prisma.orderItem.groupBy({ by: ['productId', 'productName'], where: { status: 'ACTIVE', order: sold }, _sum: { quantity: true, taxableMinor: true } }),
      this.prisma.orderItem.groupBy({ by: ['categoryName'], where: { status: 'ACTIVE', order: sold }, _sum: { quantity: true, taxableMinor: true } }),
      this.prisma.orderTaxLine.groupBy({ by: ['name', 'rateBps'], where: { order: sold }, _sum: { taxableMinor: true, amountMinor: true } }),
      this.prisma.$queryRaw<Array<{ hour: number; orders: number; total: bigint }>>`
        SELECT EXTRACT(HOUR FROM "completedAt" AT TIME ZONE ${outlet.timezone})::int AS hour, COUNT(*)::int AS orders, COALESCE(SUM("totalMinor"), 0)::bigint AS total
        FROM "Order"
        WHERE "outletId" = ${outlet.id}::uuid AND "status" IN ('COMPLETED', 'REFUNDED') AND "completedAt" >= ${range.gte} AND "completedAt" < ${range.lt}
        GROUP BY 1`,
      this.prisma.$queryRaw<Array<{ day: string; orders: number; total: bigint; net: bigint }>>`
        SELECT to_char("completedAt" AT TIME ZONE ${outlet.timezone}, 'YYYY-MM-DD') AS day, COUNT(*)::int AS orders,
               COALESCE(SUM("totalMinor"), 0)::bigint AS total, COALESCE(SUM("taxableMinor"), 0)::bigint AS net
        FROM "Order"
        WHERE "outletId" = ${outlet.id}::uuid AND "status" IN ('COMPLETED', 'REFUNDED') AND "completedAt" >= ${range.gte} AND "completedAt" < ${range.lt}
        GROUP BY 1`,
      this.prisma.order.count({ where: { outletId: outlet.id, status: 'CANCELLED', cancelledAt: range, placedAt: { not: null } } }),
      this.prisma.cashShift.findMany({
        where: { outletId: outlet.id, status: 'CLOSED', closedAt: range },
        orderBy: { closedAt: 'desc' },
        select: { id: true, openedByName: true, closedAt: true, expectedCashMinor: true, countedCashMinor: true, varianceMinor: true, register: { select: { name: true } } },
      }),
      this.prisma.order.count({ where: { outletId: outlet.id, status: { in: ['PLACED', 'CONFIRMED', 'PREPARING', 'READY'] } } }),
    ]);
    const s = totals._sum;
    return {
      outlet,
      orders: totals._count,
      grossSalesMinor: num(s.subtotalMinor),
      discountsMinor: num(s.itemDiscountMinor) + num(s.orderDiscountMinor),
      serviceChargeMinor: num(s.serviceChargeMinor),
      deliveryChargeMinor: num(s.deliveryChargeMinor),
      netSalesMinor: num(s.taxableMinor),
      taxesMinor: num(s.taxMinor),
      roundOffMinor: num(s.roundOffMinor),
      totalBilledMinor: num(s.totalMinor),
      cancelledOrders: cancelled,
      openOrders,
      byType: byType.map((t) => ({ type: t.type as string, orders: t._count, totalMinor: num(t._sum.totalMinor) })),
      payments: payments.map((p) => ({ method: p.method as string, count: p._count, amountMinor: num(p._sum.amountMinor) })),
      refunds: refunds.map((r) => ({ method: r.payment.method as string, amountMinor: r.amountMinor })),
      products: products.map((p) => ({ productId: p.productId, name: p.productName, quantity: num(p._sum.quantity), netSalesMinor: num(p._sum.taxableMinor) })),
      categories: categories.map((c) => ({ name: c.categoryName || 'Uncategorised', quantity: num(c._sum.quantity), netSalesMinor: num(c._sum.taxableMinor) })),
      taxes: taxes.map((t) => ({ name: t.name, rateBps: t.rateBps, taxableMinor: num(t._sum.taxableMinor), amountMinor: num(t._sum.amountMinor) })),
      hourly: hourly.map((h) => ({ hour: h.hour, orders: h.orders, totalMinor: num(h.total) })),
      daily: daily.map((d) => ({ day: d.day, orders: d.orders, totalMinor: num(d.total), netSalesMinor: num(d.net) })),
      shifts: shifts.map((sh) => ({ ...sh, register: sh.register.name, outlet: outlet.name })),
    };
  }

  private async lowStock(ctx: RequestContext, outlets: OutletRef[]) {
    const ingredients = await this.prisma.ingredient.findMany({
      where: { restaurantId: ctx.restaurantId, isActive: true, lowStockThreshold: { gt: 0 } },
      include: { balances: { where: { outletId: { in: outlets.map((o) => o.id) } } } },
    });
    const units = await this.prisma.unitOfMeasure.findMany({ where: { restaurantId: ctx.restaurantId }, select: { id: true, code: true } });
    const alerts: Array<{ outletId: string; outlet: string; ingredientId: string; name: string; quantity: string; threshold: string; unit: string }> = [];
    for (const outlet of outlets) {
      for (const i of ingredients) {
        const quantity = i.balances.find((b) => b.outletId === outlet.id)?.quantity;
        if (!quantity || quantity.lte(i.lowStockThreshold)) {
          alerts.push({ outletId: outlet.id, outlet: outlet.name, ingredientId: i.id, name: i.name, quantity: (quantity ?? 0).toString(), threshold: i.lowStockThreshold.toString(), unit: units.find((u) => u.id === i.baseUnitId)?.code ?? '' });
        }
      }
    }
    return alerts;
  }

  async dashboard(ctx: RequestContext, q: ReportQueryDto) {
    const outlets = await this.outlets(ctx, q.outletIds);
    const [reports, inventoryAlerts] = await Promise.all([
      Promise.all(outlets.map((o) => this.outletReport(o, localDayRange(q.from, q.to, o.timezone)))),
      this.lowStock(ctx, outlets),
    ]);
    const sum = (pick: (r: (typeof reports)[number]) => number) => reports.reduce((a, r) => a + pick(r), 0);
    /** Adds up rows that share a key across outlets. */
    const merge = <T extends Record<string, unknown>>(rows: T[], key: (row: T) => string, numeric: Array<keyof T>): T[] => {
      const out = new Map<string, T>();
      for (const row of rows) {
        const existing = out.get(key(row));
        if (!existing) out.set(key(row), { ...row });
        else for (const field of numeric) (existing[field] as number) += row[field] as number;
      }
      return [...out.values()];
    };

    const orders = sum((r) => r.orders);
    const totalBilledMinor = sum((r) => r.totalBilledMinor);
    const payments = merge(reports.flatMap((r) => r.payments), (p) => p.method, ['count', 'amountMinor']);
    const refundsByMethod = merge(reports.flatMap((r) => r.refunds), (p) => p.method, ['amountMinor']);
    const collectedMinor = payments.reduce((a, p) => a + p.amountMinor, 0);
    const refundsMinor = refundsByMethod.reduce((a, p) => a + p.amountMinor, 0);
    const shifts = reports.flatMap((r) => r.shifts);

    return {
      range: { from: q.from, to: q.to },
      outlets,
      definitions: METRIC_DEFINITIONS,
      summary: {
        orders,
        grossSalesMinor: sum((r) => r.grossSalesMinor),
        discountsMinor: sum((r) => r.discountsMinor),
        serviceChargeMinor: sum((r) => r.serviceChargeMinor),
        deliveryChargeMinor: sum((r) => r.deliveryChargeMinor),
        netSalesMinor: sum((r) => r.netSalesMinor),
        taxesMinor: sum((r) => r.taxesMinor),
        roundOffMinor: sum((r) => r.roundOffMinor),
        totalBilledMinor,
        averageOrderValueMinor: orders ? Math.round(totalBilledMinor / orders) : 0,
        collectedMinor,
        refundsMinor,
        netCollectedMinor: collectedMinor - refundsMinor,
        cancelledOrders: sum((r) => r.cancelledOrders),
        openOrders: sum((r) => r.openOrders),
        cashVarianceMinor: shifts.reduce((a, s) => a + (s.varianceMinor ?? 0), 0),
      },
      paymentsByMethod: payments.map((p) => ({ ...p, refundedMinor: refundsByMethod.find((r) => r.method === p.method)?.amountMinor ?? 0 })).sort((a, b) => b.amountMinor - a.amountMinor),
      salesByType: merge(reports.flatMap((r) => r.byType), (t) => t.type, ['orders', 'totalMinor']),
      topProducts: merge(reports.flatMap((r) => r.products), (p) => p.productId, ['quantity', 'netSalesMinor']).sort((a, b) => b.quantity - a.quantity).slice(0, 10),
      categories: merge(reports.flatMap((r) => r.categories), (c) => c.name, ['quantity', 'netSalesMinor']).sort((a, b) => b.netSalesMinor - a.netSalesMinor),
      taxes: merge(reports.flatMap((r) => r.taxes), (t) => `${t.name}|${t.rateBps}`, ['taxableMinor', 'amountMinor']),
      hourly: merge(reports.flatMap((r) => r.hourly), (h) => String(h.hour), ['orders', 'totalMinor']).sort((a, b) => a.hour - b.hour),
      daily: merge(reports.flatMap((r) => r.daily), (d) => d.day, ['orders', 'totalMinor', 'netSalesMinor']).sort((a, b) => a.day.localeCompare(b.day)),
      outletComparison: reports.map((r) => ({ outletId: r.outlet.id, outlet: r.outlet.name, orders: r.orders, netSalesMinor: r.netSalesMinor, totalBilledMinor: r.totalBilledMinor, cancelledOrders: r.cancelledOrders })),
      cashShifts: shifts,
      inventoryAlerts,
    };
  }

  async export(ctx: RequestContext, q: ExportQueryDto): Promise<string> {
    const outlets = await this.outlets(ctx, q.outletIds);
    const major = (minor: number) => (minor / 100).toFixed(2);
    const rows: Array<Array<string | number | null>> = [];
    for (const outlet of outlets) {
      const range = localDayRange(q.from, q.to, outlet.timezone);
      const local = (d: Date | null) => (d ? new Intl.DateTimeFormat('sv-SE', { timeZone: outlet.timezone, dateStyle: 'short', timeStyle: 'medium' }).format(d) : '');
      const sold: Prisma.OrderWhereInput = { outletId: outlet.id, status: { in: ['COMPLETED', 'REFUNDED'] }, completedAt: range };
      if (q.dataset === 'orders') {
        const orders = await this.prisma.order.findMany({ where: sold, orderBy: { completedAt: 'asc' }, include: { invoice: { select: { invoiceNumber: true } } } });
        for (const o of orders) {
          rows.push([outlet.name, o.orderNumber, o.invoice?.invoiceNumber ?? '', o.type, o.status, local(o.completedAt), major(o.subtotalMinor), major(o.itemDiscountMinor + o.orderDiscountMinor), major(o.serviceChargeMinor), major(o.deliveryChargeMinor), major(o.taxableMinor), major(o.taxMinor), major(o.roundOffMinor), major(o.totalMinor), major(o.paidMinor), major(o.refundedMinor)]);
        }
      } else if (q.dataset === 'items') {
        const items = await this.prisma.orderItem.findMany({ where: { status: 'ACTIVE', order: sold }, orderBy: { createdAt: 'asc' }, include: { order: { select: { orderNumber: true, completedAt: true } } } });
        for (const i of items) {
          rows.push([outlet.name, i.order.orderNumber, local(i.order.completedAt), i.categoryName, i.productName, i.variantName, i.sku, i.hsnSac, i.quantity, major(i.unitPriceMinor + i.modifiersMinor), major(i.lineSubtotalMinor), major(i.discountMinor + i.orderDiscountShareMinor), major(i.taxableMinor), major(i.taxMinor), major(i.totalMinor)]);
        }
      } else {
        const [payments, refunds] = await Promise.all([
          this.prisma.payment.findMany({ where: { outletId: outlet.id, state: 'SUCCEEDED', succeededAt: range }, orderBy: { succeededAt: 'asc' }, include: { order: { select: { orderNumber: true } } } }),
          this.prisma.refund.findMany({ where: { outletId: outlet.id, createdAt: range }, orderBy: { createdAt: 'asc' }, include: { order: { select: { orderNumber: true } }, payment: { select: { method: true } } } }),
        ]);
        for (const p of payments) rows.push([outlet.name, 'PAYMENT', p.order.orderNumber, local(p.succeededAt), p.method, p.verification, p.reference, major(p.amountMinor)]);
        for (const r of refunds) rows.push([outlet.name, 'REFUND', r.order.orderNumber, local(r.createdAt), r.payment.method, r.creditNoteNumber, r.reason, `-${major(r.amountMinor)}`]);
      }
    }
    const headers = {
      orders: ['Outlet', 'Order', 'Invoice', 'Type', 'Status', 'Completed (local)', 'Gross', 'Discounts', 'Service charge', 'Delivery charge', 'Net sales', 'Tax', 'Round off', 'Total', 'Paid', 'Refunded'],
      items: ['Outlet', 'Order', 'Completed (local)', 'Category', 'Item', 'Variant', 'SKU', 'HSN/SAC', 'Qty', 'Unit price', 'Gross', 'Discount', 'Net', 'Tax', 'Total'],
      payments: ['Outlet', 'Kind', 'Order', 'Time (local)', 'Method', 'Verification / credit note', 'Reference / reason', 'Amount'],
    }[q.dataset];
    await this.audit.log(ctx, 'report.export', 'Report', q.dataset, { from: q.from, to: q.to, outlets: outlets.length, rows: rows.length });
    return csv([headers, ...rows]);
  }
}

@ApiTags('Reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  @RequirePermissions('report.view')
  dashboard(@Ctx() ctx: RequestContext, @Query() q: ReportQueryDto) {
    return this.reports.dashboard(ctx, q);
  }

  @Get('export.csv')
  @RequirePermissions('report.export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async export(@Ctx() ctx: RequestContext, @Query() q: ExportQueryDto, @Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader('Content-Disposition', `attachment; filename="serveos-${q.dataset}-${q.from}-to-${q.to}.csv"`);
    return this.reports.export(ctx, q);
  }
}

@ApiTags('Health')
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  @Public()
  @Get('health')
  live() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  @Public()
  @Get('health/ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', database: 'up' };
    } catch {
      throw new ServiceUnavailableException('Database is not reachable');
    }
  }

  /** Development aid: shows emails the dev adapter "sent" (invitation and reset links). Never available in production. */
  @Public()
  @Get('dev/outbox')
  outbox() {
    if (isProduction) throw notFound('Page');
    return this.email.outbox;
  }
}

@Module({ controllers: [ReportsController, HealthController], providers: [ReportsService] })
export class ReportsModule {}
