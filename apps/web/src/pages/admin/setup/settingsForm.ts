import { updateRestaurantSchema } from '@serveos/shared';
import { z } from 'zod';
import { amount, parseAmount } from '@/lib/format';
import type { Restaurant } from './types';

const percentText = z
  .string()
  .trim()
  .refine((v) => /^\d{1,3}(\.\d{1,2})?$/.test(v) && Number(v) <= 100, 'Enter a percentage from 0 to 100, with up to 2 decimals');
const amountText = (min: number, max: number, message: string) =>
  z.string().refine((v) => {
    const minor = parseAmount(v);
    return minor !== null && minor >= min && minor <= max;
  }, message);
const wholeText = (max: number, message: string) => z.string().trim().refine((v) => /^\d+$/.test(v) && Number(v) <= max, message);

/**
 * The settings form as people type it: percentages and rupee amounts as text.
 * `toPatch` converts it to the API's units (basis points and minor units).
 */
export const settingsFormSchema = z.object({
  name: z.string().trim().min(1, 'Enter the restaurant name').max(120),
  legalName: z.string().trim().min(1, 'Enter the legal name').max(120),
  gstin: z.string().trim().max(20),
  addressLine1: z.string().trim().max(200),
  city: z.string().trim().max(80),
  stateCode: z.string().trim().max(4, 'Use the GST state code, up to 4 characters'),
  postalCode: z.string().trim().max(12),
  pricesIncludeTax: z.boolean(),
  serviceChargePercent: percentText,
  serviceChargeTaxCategoryId: z.string(),
  deliveryChargeTaxCategoryId: z.string(),
  roundOffMode: z.enum(['NONE', 'NEAREST_UNIT']),
  receiptFooter: z.string().trim().max(500),
  discountApprovalPercent: percentText,
  cashVarianceThreshold: amountText(0, 1_000_000_000, 'Enter an amount of 0 or more'),
  allowPartialPayment: z.boolean(),
  inventoryPolicy: z.enum(['NONE', 'ON_CONFIRM', 'ON_COMPLETE']),
  allowNegativeStock: z.boolean(),
  loyaltyEnabled: z.boolean(),
  loyaltyEarnPointsPer100: wholeText(1000, 'Enter a whole number from 0 to 1000'),
  loyaltyPointValue: amountText(1, 100_000, 'Enter an amount from 0.01 to 1,000.00'),
  loyaltyMinRedeemPoints: wholeText(1_000_000, 'Enter a whole number from 0 to 1,000,000'),
});
export type SettingsForm = z.infer<typeof settingsFormSchema>;
export type RestaurantPatch = z.infer<typeof updateRestaurantSchema>;

/** "5" for 500 bps, "12.5" for 1250. */
export const bpsToPercentText = (bps: number): string => String(bps / 100);
export const percentTextToBps = (text: string): number => Math.round(Number(text) * 100);

export function toForm(r: Restaurant): SettingsForm {
  return {
    name: r.name,
    legalName: r.legalName,
    gstin: r.gstin ?? '',
    addressLine1: r.addressLine1,
    city: r.city,
    stateCode: r.stateCode,
    postalCode: r.postalCode,
    pricesIncludeTax: r.pricesIncludeTax,
    serviceChargePercent: bpsToPercentText(r.serviceChargeBps),
    serviceChargeTaxCategoryId: r.serviceChargeTaxCategoryId ?? '',
    deliveryChargeTaxCategoryId: r.deliveryChargeTaxCategoryId ?? '',
    roundOffMode: r.roundOffMode,
    receiptFooter: r.receiptFooter,
    discountApprovalPercent: bpsToPercentText(r.discountApprovalThresholdBps),
    cashVarianceThreshold: amount(r.cashVarianceApprovalThresholdMinor),
    allowPartialPayment: r.allowPartialPayment,
    inventoryPolicy: r.inventoryPolicy,
    allowNegativeStock: r.allowNegativeStock,
    loyaltyEnabled: r.loyaltyEnabled,
    loyaltyEarnPointsPer100: String(r.loyaltyEarnPointsPer100),
    loyaltyPointValue: amount(r.loyaltyPointValueMinor),
    loyaltyMinRedeemPoints: String(r.loyaltyMinRedeemPoints),
  };
}

/** The whole form in API units. */
function toApi(f: SettingsForm): Required<RestaurantPatch> {
  return {
    name: f.name,
    legalName: f.legalName,
    gstin: f.gstin || null,
    addressLine1: f.addressLine1,
    city: f.city,
    stateCode: f.stateCode,
    postalCode: f.postalCode,
    pricesIncludeTax: f.pricesIncludeTax,
    serviceChargeBps: percentTextToBps(f.serviceChargePercent),
    serviceChargeTaxCategoryId: f.serviceChargeTaxCategoryId || null,
    deliveryChargeTaxCategoryId: f.deliveryChargeTaxCategoryId || null,
    roundOffMode: f.roundOffMode,
    receiptFooter: f.receiptFooter,
    discountApprovalThresholdBps: percentTextToBps(f.discountApprovalPercent),
    cashVarianceApprovalThresholdMinor: parseAmount(f.cashVarianceThreshold) ?? 0,
    allowPartialPayment: f.allowPartialPayment,
    inventoryPolicy: f.inventoryPolicy,
    allowNegativeStock: f.allowNegativeStock,
    loyaltyEnabled: f.loyaltyEnabled,
    loyaltyEarnPointsPer100: Number(f.loyaltyEarnPointsPer100),
    loyaltyPointValueMinor: parseAmount(f.loyaltyPointValue) ?? 1,
    loyaltyMinRedeemPoints: Number(f.loyaltyMinRedeemPoints),
  };
}

/** Only the settings that differ from what is saved: PATCH /restaurant is partial. */
export function toPatch(form: SettingsForm, saved: Restaurant): RestaurantPatch {
  const next = toApi(form);
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next) as Array<keyof typeof next>) {
    if (next[key] !== saved[key]) patch[key] = next[key];
  }
  return updateRestaurantSchema.parse(patch);
}
