/**
 * Hand-built charts for the reports dashboard (no chart library is installed).
 *
 * Every chart here plots ONE series, so one colour is used throughout and the card title says
 * what is plotted (no legend needed). Values are never reachable by hover alone: bar lists print
 * every value, and trend charts have a "View as table" twin plus keyboard arrow-key reading.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Card, cn } from '@/components/ui';

/** Series colour: checked with the dataviz palette validator against the white card surface (contrast >= 3:1). */
const SERIES = '#2a78d6';
const GRID = 'var(--color-line)';
const BASELINE = 'var(--color-line-strong)';
const AXIS_TEXT = 'var(--color-ink-faint)';
const SURFACE = 'var(--color-surface)';

// ───────────── Card with a table-view twin ─────────────

export function ChartCard({ title, subtitle, children, table, className }: { title: string; subtitle?: string; children: ReactNode; /** The same data as a table, for people who cannot or would rather not read the chart. */ table?: ReactNode; className?: string }) {
  const [asTable, setAsTable] = useState(false);
  const headingId = useId();
  return (
    <Card className={cn('flex min-w-0 flex-col', className)}>
      <section aria-labelledby={headingId} className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-start justify-between gap-2 px-4 pt-4">
          <div className="min-w-0">
            <h2 id={headingId} className="text-base font-semibold text-ink">
              {title}
            </h2>
            {subtitle ? <p className="mt-0.5 text-sm text-ink-soft">{subtitle}</p> : null}
          </div>
          {table ? (
            <button type="button" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)} className="rounded-control px-2 py-1 text-sm font-medium text-ink-soft hover:bg-sunken hover:text-ink">
              {asTable ? 'View as chart' : 'View as table'}
            </button>
          ) : null}
        </div>
        <div className="min-w-0 flex-1 pb-3 pt-2">{asTable && table ? table : children}</div>
      </section>
    </Card>
  );
}

/** Plain table used as the accessible twin of a chart. */
export function MiniTable({ head, rows }: { head: string[]; rows: Array<{ key: string; cells: ReactNode[] }> }) {
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line">
            {head.map((h, i) => (
              <th key={h} scope="col" className={cn('px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-faint', i === 0 ? 'text-left' : 'text-right')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-line last:border-0">
              {r.cells.map((c, i) => (
                <td key={i} className={cn('px-4 py-2 text-ink', i === 0 ? 'text-left' : 'tabular text-right')}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ───────────── Horizontal bar list ─────────────

export interface BarRow {
  key: string;
  label: string;
  /** The number the bar length encodes. */
  value: number;
  /** The value as text, printed at the end of the row. */
  valueLabel: string;
  /** Secondary facts for the row (counts, refunds...). */
  detail?: string;
}

/**
 * Compares magnitudes across named categories. Each row prints its own value, so the list is
 * readable without hovering and needs no separate table view.
 */
export function BarList({ rows, valueHeader, labelHeader }: { rows: BarRow[]; labelHeader: string; valueHeader: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <div className="px-4">
      <div className="flex justify-between gap-3 border-b border-line pb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        <span>{labelHeader}</span>
        <span>{valueHeader}</span>
      </div>
      <ul className="flex flex-col">
        {rows.map((r) => {
          const share = max > 0 ? Math.max(0, r.value) / max : 0;
          return (
            <li key={r.key} className="border-b border-line py-2 last:border-0">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate font-medium text-ink" title={r.label}>
                  {r.label}
                </span>
                <span className="tabular shrink-0 font-semibold text-ink">{r.valueLabel}</span>
              </div>
              {/* The bar is decoration for the printed value, so it is hidden from screen readers. */}
              <div aria-hidden className="mt-1.5 h-2.5">
                <div className="h-full rounded-r-[4px]" style={{ width: `${share * 100}%`, minWidth: r.value > 0 ? 2 : 0, background: SERIES }} />
              </div>
              {r.detail ? <p className="mt-1 text-xs text-ink-soft">{r.detail}</p> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ───────────── Trend chart (columns or line) ─────────────

export interface TrendPoint {
  key: string;
  /** Short label under the axis. */
  tick: string;
  /** Full label for the tooltip and screen readers. */
  title: string;
  value: number;
  /** Other facts shown under the value in the tooltip. */
  facts: Array<{ label: string; value: string }>;
}

/** Rounds a maximum up to a clean axis top and returns evenly spaced ticks from zero. */
export function niceTicks(max: number, target = 4): number[] {
  if (max <= 0) return [0];
  const rough = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let v = 0; v < max + step - 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

function useWidth(fallback = 640): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(Math.round(w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

const HEIGHT = 220;
const MARGIN = { top: 12, right: 12, bottom: 26, left: 52 };

/**
 * One series over an ordered axis: `columns` for buckets that stand alone (hours of the day),
 * `line` for a continuous run of days. Hover or focus + arrow keys shows the reading for one position.
 */
export function TrendChart({ points, kind, formatValue, formatAxis, label }: { points: TrendPoint[]; kind: 'columns' | 'line'; formatValue: (value: number) => string; formatAxis: (value: number) => string; /** What is plotted, for screen readers. */ label: string }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const clipId = useId();

  const plotW = Math.max(40, width - MARGIN.left - MARGIN.right);
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const ticks = useMemo(() => niceTicks(Math.max(0, ...points.map((p) => p.value))), [points]);
  const top = ticks[ticks.length - 1] || 1;
  const band = plotW / Math.max(1, points.length);
  const x = (i: number) => MARGIN.left + band * (i + 0.5);
  const y = (v: number) => MARGIN.top + plotH - (Math.max(0, v) / top) * plotH;
  const baseY = MARGIN.top + plotH;

  // Print only as many axis labels as fit without touching each other.
  const every = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / 52))));
  const current = active != null ? points[active] : undefined;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (points.length === 0) return;
    const move = (to: number) => {
      e.preventDefault();
      setActive(Math.min(points.length - 1, Math.max(0, to)));
    };
    if (e.key === 'ArrowRight') move((active ?? -1) + 1);
    else if (e.key === 'ArrowLeft') move((active ?? points.length) - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(points.length - 1);
    else if (e.key === 'Escape') setActive(null);
  };

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const areaPath = points.length ? `${linePath} L${x(points.length - 1).toFixed(1)},${baseY} L${x(0).toFixed(1)},${baseY} Z` : '';
  const barW = Math.min(24, Math.max(2, band - 2));
  const last = points.length - 1;

  // Keep the tooltip inside the card: anchor it left or right of the reading depending on the side.
  const tipLeft = active != null && x(active) > width / 2;

  return (
    <div className="px-2">
      <div
        ref={ref}
        role="group"
        tabIndex={0}
        aria-label={`${label}. Use the left and right arrow keys to read each value.`}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        className="relative w-full rounded-control"
      >
        <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} className="block max-w-full" aria-hidden>
          <defs>
            <clipPath id={clipId}>
              <rect x={MARGIN.left} y={0} width={plotW} height={baseY} />
            </clipPath>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? BASELINE : GRID} strokeWidth={1} />
              <text x={MARGIN.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={AXIS_TEXT} style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatAxis(t)}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            i % every === 0 ? (
              <text key={p.key} x={x(i)} y={HEIGHT - 8} textAnchor="middle" fontSize={11} fill={AXIS_TEXT}>
                {p.tick}
              </text>
            ) : null,
          )}

          {current && active != null && kind === 'line' ? <line x1={x(active)} x2={x(active)} y1={MARGIN.top} y2={baseY} stroke={BASELINE} strokeWidth={1} /> : null}

          {kind === 'columns' ? (
            points.map((p, i) => {
              const h = baseY - y(p.value);
              if (h <= 0) return null;
              const r = Math.min(4, h, barW / 2);
              const left = x(i) - barW / 2;
              // Rounded at the data end, square on the baseline.
              const d = `M${left},${baseY} V${baseY - h + r} Q${left},${baseY - h} ${left + r},${baseY - h} H${left + barW - r} Q${left + barW},${baseY - h} ${left + barW},${baseY - h + r} V${baseY} Z`;
              return <path key={p.key} d={d} fill={SERIES} opacity={active == null || active === i ? 1 : 0.55} />;
            })
          ) : (
            <g clipPath={`url(#${clipId})`}>
              <path d={areaPath} fill={SERIES} opacity={0.1} />
              <path d={linePath} fill="none" stroke={SERIES} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          )}
          {kind === 'line' && last >= 0 ? (
            <>
              {/* End marker, plus the reading under the pointer; a surface ring keeps them clear of the line. */}
              <circle cx={x(last)} cy={y(points[last]!.value)} r={4} fill={SERIES} stroke={SURFACE} strokeWidth={2} />
              {current && active != null && active !== last ? <circle cx={x(active)} cy={y(current.value)} r={4} fill={SERIES} stroke={SURFACE} strokeWidth={2} /> : null}
            </>
          ) : null}

          {/* Hit areas span the whole band and the full plot height, so the pointer never has to land on a mark. */}
          {points.map((p, i) => (
            <rect key={p.key} x={MARGIN.left + band * i} y={MARGIN.top} width={band} height={plotH} fill="transparent" onPointerEnter={() => setActive(i)} onPointerMove={() => setActive(i)} onPointerDown={() => setActive(i)} />
          ))}
        </svg>

        {current && active != null ? (
          <div
            className="pointer-events-none absolute z-10 w-max max-w-[14rem] rounded-control border border-line bg-surface px-3 py-2 text-xs shadow-pop"
            style={tipLeft ? { right: width - x(active) + 10, top: MARGIN.top } : { left: x(active) + 10, top: MARGIN.top }}
          >
            <p className="text-ink-soft">{current.title}</p>
            <p className="text-sm font-bold text-ink">{formatValue(current.value)}</p>
            {current.facts.map((f) => (
              <p key={f.label} className="text-ink-soft">
                <span className="font-semibold text-ink">{f.value}</span> {f.label}
              </p>
            ))}
          </div>
        ) : null}
        <p aria-live="polite" className="sr-only">
          {current ? `${current.title}: ${formatValue(current.value)}${current.facts.map((f) => `, ${f.value} ${f.label}`).join('')}` : ''}
        </p>
      </div>
    </div>
  );
}
