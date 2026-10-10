import { beforeEach, describe, expect, it } from 'vitest';
import { formatAge, isAllergyNote, urgency } from './format';
import { loadSettings } from './settings';

describe('formatAge', () => {
  it('formats mm:ss, never negative, and keeps counting minutes past an hour', () => {
    expect(formatAge(0)).toBe('00:00');
    expect(formatAge(65_999)).toBe('01:05');
    expect(formatAge(-5000)).toBe('00:00'); // device clock behind the server
    expect(formatAge(125 * 60_000 + 3000)).toBe('125:03');
  });
});

describe('urgency', () => {
  it('switches exactly at the thresholds', () => {
    expect(urgency(8 * 60_000 - 1, 8, 15)).toBe('ok');
    expect(urgency(8 * 60_000, 8, 15)).toBe('late');
    expect(urgency(15 * 60_000, 8, 15)).toBe('overdue');
  });
});

describe('isAllergyNote', () => {
  it('spots allergy wording but not ordinary notes', () => {
    expect(isAllergyNote('Allergy: nuts')).toBe(true);
    expect(isAllergyNote('gluten free please')).toBe(true);
    expect(isAllergyNote('less sugar')).toBe(false);
    expect(isAllergyNote('extra donuts')).toBe(false);
  });
});

describe('loadSettings', () => {
  beforeEach(() => localStorage.clear());

  it('falls back to defaults for missing or corrupt values', () => {
    expect(loadSettings()).toEqual({ warnMinutes: 8, overdueMinutes: 15, soundWanted: false, stationId: 'ALL', orderType: 'ALL' });
    localStorage.setItem('serveos.kds.settings', '{not json');
    expect(loadSettings().warnMinutes).toBe(8);
    localStorage.setItem('serveos.kds.settings', JSON.stringify({ warnMinutes: 'soon', orderType: 'DRIVE_THRU', overdueMinutes: 20 }));
    expect(loadSettings()).toMatchObject({ warnMinutes: 8, overdueMinutes: 20, orderType: 'ALL' });
  });

  it('keeps overdue after late', () => {
    localStorage.setItem('serveos.kds.settings', JSON.stringify({ warnMinutes: 10, overdueMinutes: 5 }));
    expect(loadSettings()).toMatchObject({ warnMinutes: 10, overdueMinutes: 11 });
  });
});
