import { describe, expect, it } from 'vitest';
import { zonedToIso } from '../people/time';
import { settingsFormSchema, toForm, toPatch } from './settingsForm';
import type { Restaurant } from './types';

const saved: Restaurant = {
  id: 'r1',
  name: 'Saffron Table',
  legalName: 'Saffron Table Hospitality Pvt Ltd',
  gstin: '29ABCDE1234F1Z5',
  currency: 'INR',
  addressLine1: '12 Demo Street',
  city: 'Bengaluru',
  stateCode: '29',
  postalCode: '560038',
  pricesIncludeTax: false,
  serviceChargeBps: 500,
  serviceChargeTaxCategoryId: '01a124d4-d7be-7290-9c80-7be6bf7e5c83',
  deliveryChargeTaxCategoryId: null,
  roundOffMode: 'NEAREST_UNIT',
  receiptFooter: 'Thank you! Visit again.',
  discountApprovalThresholdBps: 1500,
  cashVarianceApprovalThresholdMinor: 50000,
  allowPartialPayment: false,
  inventoryPolicy: 'ON_CONFIRM',
  allowNegativeStock: false,
  loyaltyEnabled: true,
  loyaltyEarnPointsPer100: 1,
  loyaltyPointValueMinor: 100,
  loyaltyMinRedeemPoints: 50,
};

describe('settings form conversion', () => {
  it('produces an empty patch when nothing was changed', () => {
    const form = settingsFormSchema.parse(toForm(saved));
    expect(toPatch(form, saved)).toEqual({});
  });

  it('sends only the changed fields, in the API units', () => {
    const form = settingsFormSchema.parse({ ...toForm(saved), serviceChargePercent: '7.5', cashVarianceThreshold: '1,250.50', gstin: '', loyaltyPointValue: '0.50' });
    expect(toPatch(form, saved)).toEqual({ serviceChargeBps: 750, cashVarianceApprovalThresholdMinor: 125050, gstin: null, loyaltyPointValueMinor: 50 });
  });

  it('rejects percentages above 100 and a zero point value', () => {
    const result = settingsFormSchema.safeParse({ ...toForm(saved), discountApprovalPercent: '120', loyaltyPointValue: '0' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0]).sort()).toEqual(['discountApprovalPercent', 'loyaltyPointValue']);
  });
});

describe('zonedToIso', () => {
  it('reads a wall-clock time in the outlet time zone, not the computer one', () => {
    expect(zonedToIso('2026-10-12T09:30', 'Asia/Kolkata')).toBe('2026-10-12T04:00:00.000Z');
    expect(zonedToIso('2026-01-15T09:30', 'America/New_York')).toBe('2026-01-15T14:30:00.000Z');
    expect(zonedToIso('not a date', 'Asia/Kolkata')).toBeNull();
  });
});
