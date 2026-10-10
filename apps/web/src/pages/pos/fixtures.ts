import type { Catalog } from '@/lib/types';

/** A small menu used by the POS tests. */
export const catalog: Catalog = {
  generatedAt: '2026-10-10T00:00:00.000Z',
  settings: {
    currency: 'INR', pricesIncludeTax: false, roundOffMode: 'NONE', serviceChargeBps: 1000,
    serviceChargeTaxRules: [], deliveryChargeMinor: 4000, deliveryChargeTaxRules: [], discountApprovalThresholdBps: 1500, outletStateCode: '29',
  },
  categories: [{ id: 'c-food', name: 'Food', parentId: null, sortOrder: 0 }, { id: 'c-drinks', name: 'Drinks', parentId: null, sortOrder: 1 }],
  products: [
    { id: 'tea', name: 'Masala Chai', sku: 'BEV-001', categoryId: 'c-drinks', description: '', imageUrl: null, isVeg: true, isFavorite: true, isAvailable: true, taxCategoryId: 'gst5', variants: [{ id: 'tea-r', name: 'Regular', priceMinor: 10_000, isDefault: true }], modifierGroupIds: [] },
    { id: 'curry', name: 'Butter Chicken', sku: 'MAN-001', categoryId: 'c-food', description: '', imageUrl: null, isVeg: false, isFavorite: false, isAvailable: true, taxCategoryId: 'gst5', variants: [{ id: 'curry-h', name: 'Half', priceMinor: 20_000, isDefault: true }, { id: 'curry-f', name: 'Full', priceMinor: 30_000, isDefault: false }], modifierGroupIds: ['spice', 'extras'] },
    { id: 'naan', name: 'Butter Naan', sku: 'BRD-001', categoryId: 'c-food', description: '', imageUrl: null, isVeg: true, isFavorite: false, isAvailable: false, taxCategoryId: 'gst5', variants: [{ id: 'naan-r', name: 'Regular', priceMinor: 6_000, isDefault: true }], modifierGroupIds: [] },
  ],
  modifierGroups: [
    { id: 'spice', name: 'Spice level', minSelect: 1, maxSelect: 1, options: [{ id: 'mild', name: 'Mild', priceMinor: 0 }, { id: 'hot', name: 'Hot', priceMinor: 0 }] },
    { id: 'extras', name: 'Extras', minSelect: 0, maxSelect: 2, options: [{ id: 'butter', name: 'Butter', priceMinor: 2_000 }, { id: 'cheese', name: 'Cheese', priceMinor: 3_000 }, { id: 'egg', name: 'Egg', priceMinor: 1_500 }] },
  ],
  taxCategories: [{ id: 'gst5', name: 'GST 5%', rules: [{ component: 'CGST', name: 'CGST 2.5%', rateBps: 250, scope: 'INTRA_STATE' }, { component: 'SGST', name: 'SGST 2.5%', rateBps: 250, scope: 'INTRA_STATE' }, { component: 'IGST', name: 'IGST 5%', rateBps: 500, scope: 'INTER_STATE' }] }],
  stations: [],
  popularProductIds: ['curry'],
};
