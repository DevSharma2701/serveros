import { Info } from 'lucide-react';
import { useId, useState } from 'react';
import { Card, cn } from '@/components/ui';
import { money } from '@/lib/format';
import type { DashboardResponse } from '../types';

interface Tile {
  key: string;
  label: string;
  value: string;
  /** How the number is calculated. Comes from the API's `definitions` wherever it provides one. */
  definition: string;
  /** A short plain-language reading of the value (never colour alone). */
  note?: string;
}

/** A headline number with its definition on hover, keyboard focus or tap of the info button. */
function KpiTile({ tile }: { tile: Tile }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const tipId = useId();
  const open = hovered || pinned;
  return (
    <Card className="relative flex min-w-0 flex-col gap-1 p-4">
      <div className="flex items-start justify-between gap-1">
        <p className="min-w-0 text-sm font-medium text-ink-soft">{tile.label}</p>
        <button
          type="button"
          aria-label={`How ${tile.label.toLowerCase()} is calculated`}
          aria-describedby={open ? tipId : undefined}
          aria-expanded={open}
          onClick={() => setPinned((v) => !v)}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocus={() => setHovered(true)}
          onBlur={() => {
            setHovered(false);
            setPinned(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setHovered(false);
              setPinned(false);
            }
          }}
          className="-mr-2 -mt-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-faint hover:bg-sunken hover:text-ink"
        >
          <Info className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {/* Proportional figures: tabular digits look loose at display size. */}
      <p className="break-words text-xl font-bold leading-tight text-ink sm:text-2xl">{tile.value}</p>
      {tile.note ? <p className="text-xs text-ink-soft">{tile.note}</p> : null}
      <div id={tipId} role="tooltip" hidden={!open} className={cn('absolute inset-x-0 top-full z-20 mt-1 rounded-control border border-line bg-surface px-3 py-2 text-xs leading-relaxed text-ink shadow-pop')}>
        {tile.definition}
      </div>
    </Card>
  );
}

// The API defines every money metric. These three counts have no entry in `definitions`,
// so they are described here from how reports.module.ts counts them.
const CANCELLED_DEFINITION = 'Orders cancelled in the period after they had been placed. Drafts that were discarded are not counted.';
const OPEN_DEFINITION = 'Orders that are placed, confirmed, being prepared or ready right now. This is a live count and ignores the date range.';

export function KpiTiles({ data, currency }: { data: DashboardResponse; currency: string }) {
  const s = data.summary;
  const d = data.definitions;
  const m = (minor: number) => money(minor, currency);
  const variance = s.cashVarianceMinor;
  const tiles: Tile[] = [
    { key: 'grossSales', label: 'Gross sales', value: m(s.grossSalesMinor), definition: d.grossSales ?? '' },
    { key: 'discounts', label: 'Discounts', value: m(s.discountsMinor), definition: d.discounts ?? '' },
    { key: 'netSales', label: 'Net sales', value: m(s.netSalesMinor), definition: d.netSales ?? '' },
    { key: 'taxes', label: 'Taxes', value: m(s.taxesMinor), definition: d.taxes ?? '' },
    { key: 'totalBilled', label: 'Total billed', value: m(s.totalBilledMinor), definition: d.totalBilled ?? '' },
    { key: 'orders', label: 'Completed orders', value: s.orders.toLocaleString('en-IN'), definition: d.scope ?? '' },
    { key: 'averageOrderValue', label: 'Average order value', value: m(s.averageOrderValueMinor), definition: d.averageOrderValue ?? '' },
    { key: 'collected', label: 'Collected', value: m(s.collectedMinor), definition: d.collected ?? '' },
    { key: 'refunds', label: 'Refunds', value: m(s.refundsMinor), definition: d.refunds ?? '' },
    { key: 'netCollected', label: 'Net collected', value: m(s.netCollectedMinor), definition: d.netCollected ?? '' },
    { key: 'cancelledOrders', label: 'Cancelled orders', value: s.cancelledOrders.toLocaleString('en-IN'), definition: CANCELLED_DEFINITION },
    { key: 'openOrders', label: 'Open orders', value: s.openOrders.toLocaleString('en-IN'), definition: OPEN_DEFINITION, note: 'Right now' },
    {
      key: 'cashVariance',
      label: 'Cash variance',
      value: `${variance > 0 ? '+' : variance < 0 ? '−' : ''}${m(Math.abs(variance))}`,
      definition: d.cashVariance ?? '',
      note: data.cashShifts.length === 0 ? 'No shifts closed in this period' : variance < 0 ? 'Cash was short' : variance > 0 ? 'Cash was over' : 'Cash matched',
    },
  ];
  return (
    <ul aria-label="Headline figures" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {tiles.map((t) => (
        <li key={t.key} className="min-w-0">
          <KpiTile tile={t} />
        </li>
      ))}
    </ul>
  );
}
