/** Shapes returned by the menu endpoints (see apps/api/src/modules/menu.module.ts). */

export interface Category {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  isActive: boolean;
  _count: { products: number };
}

export interface Variant {
  id: string;
  productId: string;
  name: string;
  priceMinor: number;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface Product {
  id: string;
  categoryId: string;
  taxCategoryId: string | null;
  name: string;
  sku: string;
  description: string;
  imageUrl: string | null;
  isVeg: boolean | null;
  isActive: boolean;
  isFavorite: boolean;
  stationKey: string | null;
  variants: Variant[];
  modifierGroups: Array<{ modifierGroupId: string }>;
  category: { id: string; name: string };
}

/** GET /menu/products/:id adds per-outlet availability and price overrides (for every outlet). */
export interface ProductDetail extends Product {
  variants: Array<Variant & { outletPrices: Array<{ outletId: string; variantId: string; priceMinor: number }> }>;
  outletSettings: Array<{ outletId: string; productId: string; isAvailable: boolean }>;
}

export interface ModifierOption {
  id: string;
  name: string;
  priceMinor: number;
  isActive: boolean;
  sortOrder: number;
}

export interface ModifierGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  isActive: boolean;
  options: ModifierOption[];
  _count?: { products: number };
}

export type TaxComponent = 'CGST' | 'SGST' | 'IGST' | 'CESS' | 'VAT' | 'OTHER';
export type TaxScope = 'ANY' | 'INTRA_STATE' | 'INTER_STATE';

export interface TaxCategory {
  id: string;
  name: string;
  hsnSac: string;
  isActive: boolean;
  rules: Array<{ id: string; component: TaxComponent; name: string; rateBps: number; scope: TaxScope; isActive: boolean }>;
}

export interface Discount {
  id: string;
  name: string;
  code: string | null;
  type: 'PERCENT' | 'FLAT';
  /** Basis points when PERCENT, minor units when FLAT. */
  value: number;
  maxDiscountMinor: number | null;
  minOrderMinor: number;
  usageLimit: number | null;
  usedCount: number;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
}

export interface Station {
  id: string;
  key: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
}
