import { Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { OrderPaymentStatus, Prisma } from '@prisma/client';
import { formatMoney, pageQuery } from '@serveos/shared';
import { createZodDto } from 'nestjs-zod';
import { Ctx, OutletScoped, RequirePermissions, type OutletContext } from '../common/context';
import { notFound } from '../common/errors';
import { PrismaService, type Tx } from '../common/prisma.service';
import { SequenceService } from '../common/services';
import { financialYear, paged, paginate } from '../common/util';

class PageDto extends createZodDto(pageQuery) {}

export function derivePaymentStatus(totalMinor: number, paidMinor: number, refundedMinor: number): OrderPaymentStatus {
  if (paidMinor === 0) return 'UNPAID';
  const net = paidMinor - refundedMinor;
  if (refundedMinor > 0) return net === 0 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  return net >= totalMinor ? 'PAID' : 'PARTIALLY_PAID';
}

const documentInclude = {
  items: { where: { status: 'ACTIVE' }, orderBy: { createdAt: 'asc' }, include: { modifiers: true } },
  taxLines: true,
  payments: { where: { state: 'SUCCEEDED' }, orderBy: { createdAt: 'asc' } },
  refunds: { orderBy: { createdAt: 'asc' } },
  customer: true,
  restaurant: true,
  outlet: true,
  invoice: true,
} satisfies Prisma.OrderInclude;
type DocumentOrder = Prisma.OrderGetPayload<{ include: typeof documentInclude }>;

/** Everything printed on a bill. Stored unchanged on the invoice so a reprint always matches the original. */
export interface BillDocument {
  seller: { legalName: string; tradeName: string; outlet: string; address: string; phone: string; gstin: string; fssaiNumber: string; stateCode: string };
  buyer: { name: string; gstin: string; stateCode: string } | null;
  orderNumber: string;
  orderType: string;
  tableLabel: string;
  currency: string;
  timezone: string;
  pricesIncludeTax: boolean;
  lines: Array<{ name: string; modifiers: string[]; hsnSac: string; quantity: number; unitMinor: number; amountMinor: number; discountMinor: number; taxableMinor: number; taxMinor: number }>;
  taxLines: Array<{ name: string; rateBps: number; taxableMinor: number; amountMinor: number }>;
  totals: { subtotalMinor: number; discountMinor: number; serviceChargeMinor: number; deliveryChargeMinor: number; taxableMinor: number; taxMinor: number; roundOffMinor: number; totalMinor: number };
  footer: string;
}

function buildDocument(order: DocumentOrder): BillDocument {
  const { restaurant: r, outlet: o } = order;
  return {
    seller: {
      legalName: r.legalName,
      tradeName: r.name,
      outlet: o.name,
      address: [o.addressLine1, o.city, o.postalCode].filter(Boolean).join(', '),
      phone: o.phone,
      gstin: o.gstin ?? r.gstin ?? '',
      fssaiNumber: o.fssaiNumber ?? '',
      stateCode: o.stateCode,
    },
    buyer: order.customer ? { name: order.customer.name, gstin: order.customer.gstin, stateCode: order.customer.stateCode } : null,
    orderNumber: order.orderNumber,
    orderType: order.type,
    tableLabel: order.tableLabel,
    currency: order.currency,
    timezone: o.timezone,
    pricesIncludeTax: order.pricesIncludeTax,
    lines: order.items.map((i) => ({
      name: i.variantName && i.variantName !== 'Regular' ? `${i.productName} (${i.variantName})` : i.productName,
      modifiers: i.modifiers.map((m) => m.optionName),
      hsnSac: i.hsnSac,
      quantity: i.quantity,
      unitMinor: i.unitPriceMinor + i.modifiersMinor,
      amountMinor: i.lineSubtotalMinor,
      discountMinor: i.discountMinor + i.orderDiscountShareMinor,
      taxableMinor: i.taxableMinor,
      taxMinor: i.taxMinor,
    })),
    taxLines: order.taxLines.map((t) => ({ name: t.name, rateBps: t.rateBps, taxableMinor: t.taxableMinor, amountMinor: t.amountMinor })),
    totals: {
      subtotalMinor: order.subtotalMinor,
      discountMinor: order.itemDiscountMinor + order.orderDiscountMinor,
      serviceChargeMinor: order.serviceChargeMinor,
      deliveryChargeMinor: order.deliveryChargeMinor,
      taxableMinor: order.taxableMinor,
      taxMinor: order.taxMinor,
      roundOffMinor: order.roundOffMinor,
      totalMinor: order.totalMinor,
    },
    footer: r.receiptFooter,
  };
}

const WIDTH = 42;
const row = (left: string, right: string): string => {
  const space = Math.max(1, WIDTH - left.length - right.length);
  return left.length + right.length + 1 > WIDTH ? `${left.slice(0, WIDTH - right.length - 1)} ${right}` : `${left}${' '.repeat(space)}${right}`;
};
const centre = (text: string): string => text.split('\n').map((l) => ' '.repeat(Math.max(0, Math.floor((WIDTH - l.length) / 2))) + l).join('\n');
const rule = '-'.repeat(WIDTH);

/**
 * Plain-text bill, 42 characters wide (a standard 80 mm thermal roll). A printer adapter can
 * send this as-is; no printer hardware has been integrated or tested yet.
 */
export function renderReceiptText(
  doc: BillDocument,
  meta: { invoiceNumber: string | null; issuedAt: Date; payments: Array<{ method: string; amountMinor: number; tenderedMinor: number | null; changeMinor: number }>; refundedMinor: number },
): string {
  const money = (minor: number) => formatMoney(minor, doc.currency).replace(/^\D+(?=\d|-)/, '');
  const when = new Intl.DateTimeFormat('en-IN', { timeZone: doc.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(meta.issuedAt);
  const out: string[] = [centre(doc.seller.tradeName.toUpperCase()), centre(doc.seller.legalName)];
  if (doc.seller.address) out.push(centre(doc.seller.address));
  if (doc.seller.phone) out.push(centre(`Ph: ${doc.seller.phone}`));
  if (doc.seller.gstin) out.push(centre(`GSTIN: ${doc.seller.gstin}`));
  if (doc.seller.fssaiNumber) out.push(centre(`FSSAI: ${doc.seller.fssaiNumber}`));
  out.push(rule, centre(meta.invoiceNumber ? 'TAX INVOICE' : 'BILL (NOT YET INVOICED)'));
  if (meta.invoiceNumber) out.push(row('Invoice', meta.invoiceNumber));
  out.push(row('Order', doc.orderNumber), row('Date', when), row('Type', doc.orderType.replace('_', ' ') + (doc.tableLabel ? ` / ${doc.tableLabel}` : '')));
  if (doc.buyer) out.push(row('Customer', doc.buyer.name), ...(doc.buyer.gstin ? [row('Cust. GSTIN', doc.buyer.gstin)] : []));
  out.push(rule);
  for (const l of doc.lines) {
    out.push(row(`${l.quantity} x ${l.name}`, money(l.amountMinor)));
    if (l.modifiers.length) out.push(`    + ${l.modifiers.join(', ')}`.slice(0, WIDTH));
  }
  out.push(rule, row('Subtotal', money(doc.totals.subtotalMinor)));
  if (doc.totals.discountMinor) out.push(row('Discount', `-${money(doc.totals.discountMinor)}`));
  if (doc.totals.serviceChargeMinor) out.push(row('Service charge', money(doc.totals.serviceChargeMinor)));
  if (doc.totals.deliveryChargeMinor) out.push(row('Delivery charge', money(doc.totals.deliveryChargeMinor)));
  for (const t of doc.taxLines) out.push(row(doc.pricesIncludeTax ? `${t.name} (incl.)` : t.name, money(t.amountMinor)));
  if (doc.totals.roundOffMinor) out.push(row('Round off', (doc.totals.roundOffMinor > 0 ? '+' : '-') + money(Math.abs(doc.totals.roundOffMinor))));
  out.push(rule, row('TOTAL', `${doc.currency} ${money(doc.totals.totalMinor)}`), rule);
  for (const p of meta.payments) {
    out.push(row(`Paid - ${p.method}`, money(p.amountMinor)));
    if (p.changeMinor) out.push(row('  Tendered / change', `${money(p.tenderedMinor ?? p.amountMinor)} / ${money(p.changeMinor)}`));
  }
  if (meta.refundedMinor) out.push(row('Refunded', `-${money(meta.refundedMinor)}`));
  if (doc.footer) out.push('', centre(doc.footer));
  return out.join('\n') + '\n';
}

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sequences: SequenceService,
  ) {}

  /**
   * Issues the invoice for an order if it does not have one yet. Numbers run per outlet and
   * financial year (e.g. BLR1/2627/00001, within the 16-character GST limit); the unique index
   * on (outlet, number) makes a duplicate impossible.
   */
  async ensureInvoice(tx: Tx, orderId: string): Promise<void> {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: documentInclude });
    if (order.invoice) return;
    const fy = financialYear(new Date(), order.outlet.timezone);
    const seq = await this.sequences.next(tx, order.outletId, 'INVOICE', fy);
    await tx.invoice.create({
      data: {
        restaurantId: order.restaurantId,
        outletId: order.outletId,
        orderId,
        invoiceNumber: `${order.outlet.code}/${fy}/${String(seq).padStart(5, '0')}`,
        totalMinor: order.totalMinor,
        snapshot: buildDocument(order) as unknown as Prisma.InputJsonObject,
      },
    });
    await tx.orderEvent.create({ data: { orderId, type: 'INVOICE_ISSUED', message: 'Invoice issued' } });
  }

  async nextCreditNoteNumber(tx: Tx, outlet: { id: string; code: string; timezone: string }): Promise<string> {
    const fy = financialYear(new Date(), outlet.timezone);
    const seq = await this.sequences.next(tx, outlet.id, 'CREDIT_NOTE', fy);
    return `${outlet.code}C${fy}/${String(seq).padStart(5, '0')}`;
  }

  /** The bill for an order: the stored invoice once issued, otherwise a live preview. */
  async receipt(ctx: OutletContext, orderId: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, restaurantId: ctx.restaurantId, outletId: ctx.outletId }, include: documentInclude });
    if (!order) throw notFound('Order');
    const document = order.invoice ? (order.invoice.snapshot as unknown as BillDocument) : buildDocument(order);
    const meta = {
      invoiceNumber: order.invoice?.invoiceNumber ?? null,
      issuedAt: order.invoice?.issuedAt ?? order.createdAt,
      payments: order.payments.map((p) => ({ method: p.method, amountMinor: p.amountMinor, tenderedMinor: p.tenderedMinor, changeMinor: p.changeMinor, reference: p.reference })),
      refunds: order.refunds.map((r) => ({ creditNoteNumber: r.creditNoteNumber, amountMinor: r.amountMinor, reason: r.reason, createdAt: r.createdAt })),
      refundedMinor: order.refundedMinor,
    };
    return { orderId, isInvoice: !!order.invoice, ...meta, document, text: renderReceiptText(document, meta) };
  }

  async invoices(ctx: OutletContext, q: PageDto) {
    const where = { restaurantId: ctx.restaurantId, outletId: ctx.outletId };
    const [items, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        ...paginate(q),
        select: { id: true, invoiceNumber: true, issuedAt: true, totalMinor: true, orderId: true, order: { select: { orderNumber: true, status: true, refundedMinor: true } } },
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return paged(items, total, q);
  }
}

@ApiTags('Invoices')
@ApiBearerAuth()
@OutletScoped()
@Controller()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('orders/:id/receipt')
  @RequirePermissions('order.view')
  receipt(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.receipt(ctx, id);
  }

  @Get('invoices')
  @RequirePermissions('report.view')
  invoices(@Ctx() ctx: OutletContext, @Query() q: PageDto) {
    return this.billing.invoices(ctx, q);
  }
}

@Module({ controllers: [BillingController], providers: [BillingService], exports: [BillingService] })
export class BillingModule {}
