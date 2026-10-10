import { titleCase } from '@/lib/format';
import { daysBetween, hourLabel, shortDay } from '../dateRange';
import type { DashboardResponse } from '../types';
import { BarList, ChartCard, MiniTable, TrendChart, type TrendPoint } from './charts';

interface Props {
  data: DashboardResponse;
  /** Full money text, e.g. "₹1,234.50". */
  formatMoney: (minor: number) => string;
  /** Short money text for axis ticks, e.g. "₹1.2K". */
  formatAxis: (minor: number) => string;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

/** Trend over the period: one point per calendar day. Days without sales are real zeros, so they are plotted. */
export function DailyTrend({ data, formatMoney, formatAxis }: Props) {
  const byDay = new Map(data.daily.map((d) => [d.day, d]));
  const days = daysBetween(data.range.from, data.range.to);
  const points: TrendPoint[] = days.map((day) => {
    const d = byDay.get(day);
    return { key: day, tick: shortDay(day), title: shortDay(day), value: d?.totalMinor ?? 0, facts: [{ label: 'orders', value: (d?.orders ?? 0).toLocaleString('en-IN') }, { label: 'net sales', value: formatMoney(d?.netSalesMinor ?? 0) }] };
  });
  return (
    <ChartCard
      title="Daily trend"
      subtitle="Total billed per day"
      table={<MiniTable head={['Day', 'Orders', 'Net sales', 'Total billed']} rows={points.map((p) => ({ key: p.key, cells: [p.title, byDay.get(p.key)?.orders ?? 0, formatMoney(byDay.get(p.key)?.netSalesMinor ?? 0), formatMoney(p.value)] }))} />}
    >
      {/* A line needs a run of days to mean anything; one or two days read better as columns. */}
      <TrendChart points={points} kind={points.length >= 3 ? 'line' : 'columns'} formatValue={formatMoney} formatAxis={formatAxis} label="Total billed per day" />
    </ChartCard>
  );
}

/** When in the day sales happen: one column per hour between the first and last hour with sales. */
export function HourlyTrend({ data, formatMoney, formatAxis }: Props) {
  const byHour = new Map(data.hourly.map((h) => [h.hour, h]));
  const hours = data.hourly.map((h) => h.hour);
  const points: TrendPoint[] = [];
  if (hours.length) {
    for (let hour = Math.min(...hours); hour <= Math.max(...hours); hour++) {
      const h = byHour.get(hour);
      points.push({ key: String(hour), tick: hourLabel(hour), title: `${hourLabel(hour)} – ${hourLabel((hour + 1) % 24)}`, value: h?.totalMinor ?? 0, facts: [{ label: 'orders', value: (h?.orders ?? 0).toLocaleString('en-IN') }] });
    }
  }
  return (
    <ChartCard
      title="Hourly trend"
      subtitle="Total billed by hour of completion, all days in the period added together"
      table={<MiniTable head={['Hour', 'Orders', 'Total billed']} rows={points.map((p) => ({ key: p.key, cells: [p.title, byHour.get(Number(p.key))?.orders ?? 0, formatMoney(p.value)] }))} />}
    >
      <TrendChart points={points} kind="columns" formatValue={formatMoney} formatAxis={formatAxis} label="Total billed by hour of the day" />
    </ChartCard>
  );
}

export function PaymentMethods({ data, formatMoney }: Props) {
  // A method can have refunds in the period without any payment in it; the API lists only methods with payments.
  return (
    <ChartCard title="Sales by payment method" subtitle="Collected in the period, with refunds issued against each method">
      <BarList
        labelHeader="Method"
        valueHeader="Collected"
        rows={data.paymentsByMethod.map((p) => ({
          key: p.method,
          label: titleCase(p.method),
          value: p.amountMinor,
          valueLabel: formatMoney(p.amountMinor),
          detail: `${count(p.count, 'payment', 'payments')} · Refunded ${formatMoney(p.refundedMinor)} · Net ${formatMoney(p.amountMinor - p.refundedMinor)}`,
        }))}
      />
    </ChartCard>
  );
}

export function OrderTypes({ data, formatMoney }: Props) {
  const rows = [...data.salesByType].sort((a, b) => b.totalMinor - a.totalMinor);
  return (
    <ChartCard title="Sales by order type" subtitle="Total billed on completed orders">
      <BarList labelHeader="Order type" valueHeader="Total billed" rows={rows.map((t) => ({ key: t.type, label: titleCase(t.type), value: t.totalMinor, valueLabel: formatMoney(t.totalMinor), detail: count(t.orders, 'order', 'orders') }))} />
    </ChartCard>
  );
}

export function TopProducts({ data, formatMoney }: Props) {
  return (
    <ChartCard title="Top-selling products" subtitle="Ten best sellers by quantity sold">
      <BarList labelHeader="Product" valueHeader="Quantity" rows={data.topProducts.map((p) => ({ key: p.productId, label: p.name, value: p.quantity, valueLabel: p.quantity.toLocaleString('en-IN'), detail: `Net sales ${formatMoney(p.netSalesMinor)}` }))} />
    </ChartCard>
  );
}

export function Categories({ data, formatMoney }: Props) {
  return (
    <ChartCard title="Category performance" subtitle="Net sales of items in each menu category">
      <BarList labelHeader="Category" valueHeader="Net sales" rows={data.categories.map((c) => ({ key: c.name, label: c.name, value: c.netSalesMinor, valueLabel: formatMoney(c.netSalesMinor), detail: count(c.quantity, 'item sold', 'items sold') }))} />
    </ChartCard>
  );
}
