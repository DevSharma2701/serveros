/** API response shapes for the Setup pages. */
export interface Restaurant {
  id: string;
  name: string;
  legalName: string;
  gstin: string | null;
  currency: string;
  addressLine1: string;
  city: string;
  stateCode: string;
  postalCode: string;
  pricesIncludeTax: boolean;
  serviceChargeBps: number;
  serviceChargeTaxCategoryId: string | null;
  deliveryChargeTaxCategoryId: string | null;
  roundOffMode: 'NONE' | 'NEAREST_UNIT';
  receiptFooter: string;
  discountApprovalThresholdBps: number;
  cashVarianceApprovalThresholdMinor: number;
  allowPartialPayment: boolean;
  inventoryPolicy: 'NONE' | 'ON_CONFIRM' | 'ON_COMPLETE';
  allowNegativeStock: boolean;
  loyaltyEnabled: boolean;
  loyaltyEarnPointsPer100: number;
  loyaltyPointValueMinor: number;
  loyaltyMinRedeemPoints: number;
}

export interface TaxCategory {
  id: string;
  name: string;
  isActive: boolean;
  rules: Array<{ id: string; name: string; rateBps: number; scope: 'ANY' | 'INTRA_STATE' | 'INTER_STATE'; isActive: boolean }>;
}

export interface Outlet {
  id: string;
  name: string;
  code: string;
  addressLine1: string;
  city: string;
  stateCode: string;
  postalCode: string;
  phone: string;
  gstin: string | null;
  fssaiNumber: string | null;
  timezone: string;
  isActive: boolean;
  serviceChargeEnabled: boolean;
  qrOrderingEnabled: boolean;
  deliveryChargeMinor: number;
}

export interface KitchenStation {
  id: string;
  key: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface CashRegister {
  id: string;
  name: string;
  isActive: boolean;
  shifts: Array<{ id: string; openedById: string; openedByName: string; openedAt: string }>;
}
