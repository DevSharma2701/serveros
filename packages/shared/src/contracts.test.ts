import { describe, expect, it } from 'vitest';
import { cartSchema, outletSchema, updateOutletSchema, updateProductSchema } from './contracts';

describe('update contracts', () => {
  it('create schemas fill in defaults', () => {
    expect(outletSchema.parse({ name: 'Main', code: 'MAIN' }).timezone).toBe('Asia/Kolkata');
  });

  it('partial updates never invent values for fields that were not sent', () => {
    expect(updateOutletSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
    expect(updateProductSchema.parse({ isActive: false })).toEqual({ isActive: false });
  });

  it('strips unknown fields so clients cannot set server-owned columns', () => {
    const parsed = cartSchema.parse({ type: 'TAKEAWAY', items: [], totalMinor: 1, restaurantId: 'x', status: 'COMPLETED' });
    expect(parsed).not.toHaveProperty('totalMinor');
    expect(parsed).not.toHaveProperty('restaurantId');
    expect(parsed).not.toHaveProperty('status');
  });
});
