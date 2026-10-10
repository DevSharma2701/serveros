/** Offset (ms) of a time zone from UTC at a given instant: positive east of Greenwich. */
function zoneOffset(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(instant));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(instant / 1000) * 1000;
}

/**
 * Turns what a `datetime-local` input holds ("2026-10-12T09:30") into a UTC ISO string, reading
 * it as wall-clock time in the outlet's time zone rather than in this computer's zone.
 * Returns null for text that is not a date and time.
 */
export function zonedToIso(local: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const wall = new Date(`${local}:00Z`).getTime();
  if (Number.isNaN(wall)) return null;
  // Two passes settle the offset on days when the clocks change.
  let instant = wall - zoneOffset(wall, timeZone);
  instant = wall - zoneOffset(instant, timeZone);
  return new Date(instant).toISOString();
}

/** "3 h 20 min" between two instants. */
export function duration(fromIso: string, toIso: string): string {
  const minutes = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}
