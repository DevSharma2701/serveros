import { ORDER_TYPES } from '@serveos/shared';
import { useCallback, useState } from 'react';
import { z } from 'zod';

const KEY = 'serveos.kds.settings';

/**
 * Per-device preferences: a grill screen and a dessert screen in the same kitchen keep their
 * own filters and thresholds. Every field falls back to its default if the stored value is bad.
 */
const schema = z.object({
  /** Minutes after which a ticket is flagged "late" (amber) and "overdue" (red). */
  warnMinutes: z.number().int().min(1).max(240).catch(8),
  overdueMinutes: z.number().int().min(2).max(480).catch(15),
  /** The user asked for sound. Whether the browser actually allows it is tracked in sound.ts. */
  soundWanted: z.boolean().catch(false),
  stationId: z.string().min(1).catch('ALL'),
  orderType: z.enum(['ALL', ...ORDER_TYPES]).catch('ALL'),
});

export type Settings = z.infer<typeof schema>;

export function loadSettings(): Settings {
  let raw: unknown = {};
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    // Unreadable or blocked storage: use defaults.
  }
  const settings = schema.parse(typeof raw === 'object' && raw !== null ? raw : {});
  // "Overdue" must come after "late", whatever was stored.
  if (settings.overdueMinutes <= settings.warnMinutes) settings.overdueMinutes = settings.warnMinutes + 1;
  return settings;
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState(loadSettings);
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Storage blocked: the setting still applies until reload.
      }
      return next;
    });
  }, []);
  return [settings, update];
}
