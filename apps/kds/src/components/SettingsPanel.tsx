import { X } from 'lucide-react';
import type { Settings } from '../lib/settings';

interface Props {
  settings: Settings;
  onChange(patch: Partial<Settings>): void;
  /** Plays the alert now, or null if sound is not enabled (the toolbar button enables it). */
  onTestSound: (() => void) | null;
  onClose(): void;
}

const FIELD = 'min-h-14 w-28 rounded-control border-2 border-kds-line bg-kds-bg px-3 text-2xl font-bold text-kds-ink';

/** Per-device thresholds. Stored in localStorage; nothing here is sent to the server. */
export function SettingsPanel({ settings, onChange, onTestSound, onClose }: Props) {
  const minutes = (value: string, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(Number(value)) || min));
  return (
    <section id="kds-settings" aria-label="Display settings" className="flex flex-wrap items-end gap-6 border-b-2 border-kds-line bg-kds-raised px-4 py-4 text-lg">
      <label className="flex flex-col gap-1 font-semibold">
        Late after (minutes)
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={240}
          value={settings.warnMinutes}
          className={FIELD}
          onChange={(e) => {
            const warnMinutes = minutes(e.target.value, 1, 240);
            // Keep "overdue" strictly after "late".
            onChange({ warnMinutes, overdueMinutes: Math.max(settings.overdueMinutes, warnMinutes + 1) });
          }}
        />
      </label>
      <label className="flex flex-col gap-1 font-semibold">
        Overdue after (minutes)
        <input
          type="number"
          inputMode="numeric"
          min={settings.warnMinutes + 1}
          max={480}
          value={settings.overdueMinutes}
          className={FIELD}
          onChange={(e) => onChange({ overdueMinutes: minutes(e.target.value, settings.warnMinutes + 1, 480) })}
        />
      </label>
      <button type="button" disabled={!onTestSound} onClick={() => onTestSound?.()} title={onTestSound ? undefined : 'Turn sound on first'} className="min-h-14 rounded-control border-2 border-kds-line bg-kds-card px-4 font-bold hover:bg-kds-line">
        Test sound
      </button>
      <p className="max-w-md text-base text-kds-faint">Saved on this screen only, so each station can use its own timings.</p>
      <button type="button" onClick={onClose} className="ml-auto flex min-h-14 items-center gap-2 rounded-control border-2 border-kds-line bg-kds-card px-4 font-bold hover:bg-kds-line">
        <X aria-hidden className="size-6" /> Close
      </button>
    </section>
  );
}
