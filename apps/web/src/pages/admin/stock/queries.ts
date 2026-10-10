/** Read queries shared by the stock pages. Everything outlet-specific sits under the `stock` key. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { GoodsReceipt, Ingredient, PurchaseOrder, Recipe, StockCount, StockRow, Supplier, Unit } from './types';

const useOutletId = () => useAuth().outlet?.id ?? null;

export const useUnits = () => useQuery({ queryKey: ['units'], queryFn: () => api<Unit[]>('/units'), staleTime: 5 * 60_000 });

export function useIngredients() {
  const outletId = useOutletId();
  return useQuery({ queryKey: ['ingredients', outletId], queryFn: () => api<Ingredient[]>('/ingredients') });
}

export function useStock() {
  const outletId = useOutletId();
  return useQuery({ queryKey: ['stock', 'on-hand', outletId], queryFn: () => api<StockRow[]>('/inventory/stock') });
}

export function useStockCounts() {
  const outletId = useOutletId();
  return useQuery({ queryKey: ['stock', 'counts', outletId], queryFn: () => api<StockCount[]>('/inventory/counts') });
}

export const useStockCount = (id: string | null) => useQuery({ queryKey: ['stock', 'count', id], queryFn: () => api<StockCount>(`/inventory/counts/${id}`), enabled: !!id });

export const useSuppliers = () => useQuery({ queryKey: ['suppliers'], queryFn: () => api<Supplier[]>('/suppliers') });

export function usePurchaseOrders() {
  const outletId = useOutletId();
  return useQuery({ queryKey: ['purchase-orders', outletId], queryFn: () => api<PurchaseOrder[]>('/purchase-orders') });
}

export function useGoodsReceipts() {
  const outletId = useOutletId();
  return useQuery({ queryKey: ['goods-receipts', outletId], queryFn: () => api<GoodsReceipt[]>('/goods-receipts') });
}

/** Active recipes (no product) or every version of one product's recipes (history). */
export const useRecipes = (productId?: string) => useQuery({ queryKey: ['recipes', productId ?? 'active'], queryFn: () => api<Recipe[]>('/recipes', { query: { productId } }) });

/** Anything that moves stock changes balances, movement history, ingredient costs and recipe costs. */
export function useInvalidateStock() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of ['stock', 'ingredients', 'recipes', 'purchase-orders', 'goods-receipts']) void queryClient.invalidateQueries({ queryKey: [key] });
  };
}

/** Lookups by id for showing names and units next to ids. */
export function useStockLookups() {
  const units = useUnits();
  const ingredients = useIngredients();
  const unitById = new Map((units.data ?? []).map((u) => [u.id, u]));
  const ingredientById = new Map((ingredients.data ?? []).map((i) => [i.id, i]));
  return {
    units,
    ingredients,
    unitById,
    ingredientById,
    unitCode: (unitId: string | null | undefined) => (unitId ? (unitById.get(unitId)?.code ?? '') : ''),
    ingredientName: (ingredientId: string) => ingredientById.get(ingredientId)?.name ?? 'Unknown ingredient',
    /** Code of the unit the ingredient's stock is kept in. */
    baseUnitCode: (ingredientId: string) => unitById.get(ingredientById.get(ingredientId)?.baseUnitId ?? '')?.code ?? '',
    /** Units a quantity of this ingredient may be entered in (same dimension as its base unit). */
    unitsFor: (ingredientId: string): Unit[] => {
      const base = unitById.get(ingredientById.get(ingredientId)?.baseUnitId ?? '');
      return base ? (units.data ?? []).filter((u) => u.dimension === base.dimension) : [];
    },
  };
}

export type StockLookups = ReturnType<typeof useStockLookups>;
