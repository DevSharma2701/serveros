import { minorToText, toMinor, type Report } from '../forms';
import type { Product } from '../types';

export type VegChoice = 'veg' | 'nonveg' | 'unspecified';

/** What the product editor holds while someone is typing. Prices are text in rupees. */
export interface ProductFormValues {
  name: string;
  sku: string;
  categoryId: string;
  taxCategoryId: string;
  description: string;
  imageUrl: string | null;
  veg: VegChoice;
  isActive: boolean;
  isFavorite: boolean;
  stationKey: string;
  variants: Array<{ id?: string; name: string; priceMinor: string; isDefault: boolean; isActive: boolean }>;
  modifierGroupIds: string[];
}

export const emptyVariant = (isDefault = false): ProductFormValues['variants'][number] => ({ name: '', priceMinor: '', isDefault, isActive: true });

export function productDefaults(product?: Product): ProductFormValues {
  if (!product) {
    return { name: '', sku: '', categoryId: '', taxCategoryId: '', description: '', imageUrl: null, veg: 'unspecified', isActive: true, isFavorite: false, stationKey: '', variants: [{ ...emptyVariant(true), name: 'Regular' }], modifierGroupIds: [] };
  }
  return {
    name: product.name,
    sku: product.sku,
    categoryId: product.categoryId,
    taxCategoryId: product.taxCategoryId ?? '',
    description: product.description,
    imageUrl: product.imageUrl,
    veg: product.isVeg == null ? 'unspecified' : product.isVeg ? 'veg' : 'nonveg',
    isActive: product.isActive,
    isFavorite: product.isFavorite,
    stationKey: product.stationKey ?? '',
    // Retired variants are shown (inactive) so they can be brought back; they keep their id.
    variants: product.variants.map((v) => ({ id: v.id, name: v.name, priceMinor: minorToText(v.priceMinor), isDefault: v.isDefault, isActive: v.isActive })),
    modifierGroupIds: product.modifierGroups.map((g) => g.modifierGroupId),
  };
}

/** Typed values -> the body of POST/PATCH /menu/products (prices in minor units). */
export function productPayload(values: ProductFormValues, report: Report) {
  if (values.variants.length > 0 && !values.variants.some((v) => v.isActive)) report('variants.root', 'At least one variant must be active');
  return {
    name: values.name,
    sku: values.sku,
    categoryId: values.categoryId,
    taxCategoryId: values.taxCategoryId || null,
    description: values.description,
    imageUrl: values.imageUrl || null,
    isVeg: values.veg === 'unspecified' ? null : values.veg === 'veg',
    isActive: values.isActive,
    isFavorite: values.isFavorite,
    stationKey: values.stationKey || null,
    variants: values.variants.map((v, i) => ({
      ...(v.id ? { id: v.id } : {}),
      name: v.name,
      priceMinor: toMinor(v.priceMinor, `variants.${i}.priceMinor`, report) ?? 0,
      isDefault: v.isDefault,
      isActive: v.isActive,
    })),
    modifierGroupIds: values.modifierGroupIds,
  };
}

