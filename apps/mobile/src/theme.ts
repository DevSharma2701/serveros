/**
 * ServeOS visual language, mirrored from packages/config/tokens.css (the web design tokens):
 * warm off-white canvas, charcoal navigation chrome, burnt-orange accent and
 * green / amber / red status colours.
 */
export const colors = {
  canvas: '#faf8f5',
  surface: '#ffffff',
  sunken: '#f3efe9',
  line: '#e6e0d7',
  lineStrong: '#cfc7bb',

  ink: '#1f1c19',
  inkSoft: '#5c554c',
  inkFaint: '#857d73',

  chrome: '#211e1b',
  chromeRaised: '#302b27',
  chromeInk: '#ede8e1',
  chromeFaint: '#a39a8f',

  brand: '#c2410c',
  brandStrong: '#9a3412',
  brandSoft: '#ffedd5',
  brandBright: '#fb923c',

  ok: '#15803d',
  okSoft: '#dcfce7',
  warn: '#b45309',
  warnSoft: '#fef3c7',
  bad: '#b91c1c',
  badSoft: '#fee2e2',
  info: '#1d4ed8',
  infoSoft: '#dbeafe',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { control: 8, card: 12, pill: 999 } as const;
/** Minimum touch target (points), per platform accessibility guidance. */
export const TOUCH = 44;

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'brand';

export const toneColors: Record<Tone, { fg: string; bg: string }> = {
  neutral: { fg: colors.inkSoft, bg: colors.sunken },
  ok: { fg: colors.ok, bg: colors.okSoft },
  warn: { fg: colors.warn, bg: colors.warnSoft },
  bad: { fg: colors.bad, bg: colors.badSoft },
  info: { fg: colors.info, bg: colors.infoSoft },
  brand: { fg: colors.brandStrong, bg: colors.brandSoft },
};
