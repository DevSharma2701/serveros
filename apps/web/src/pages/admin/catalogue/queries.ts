/** Read queries shared by the catalogue pages. Keys start with a domain word so they can be invalidated as a group. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Paged } from '@/lib/types';
import type { Category, Discount, ModifierGroup, Product, ProductDetail, Station, TaxCategory } from './types';

export const useCategories = () => useQuery({ queryKey: ['categories'], queryFn: () => api<Category[]>('/menu/categories') });
export const useModifierGroups = () => useQuery({ queryKey: ['modifier-groups'], queryFn: () => api<ModifierGroup[]>('/menu/modifier-groups') });
export const useTaxCategories = () => useQuery({ queryKey: ['tax-categories'], queryFn: () => api<TaxCategory[]>('/tax-categories') });
export const useDiscounts = () => useQuery({ queryKey: ['discounts'], queryFn: () => api<Discount[]>('/discounts') });

/** Kitchen stations of the selected outlet. Needs `kitchen.view`; without it the query stays idle. */
export function useStations() {
  const { can, outlet } = useAuth();
  return useQuery({ queryKey: ['stations', outlet?.id], queryFn: () => api<Station[]>('/kitchen/stations'), enabled: can('kitchen.view') });
}

export interface ProductFilters {
  q?: string;
  categoryId?: string;
  active?: boolean;
  page: number;
  pageSize: number;
}

export const useProducts = (filters: ProductFilters) =>
  useQuery({ queryKey: ['products', filters], queryFn: () => api<Paged<Product>>('/menu/products', { query: { ...filters } }), placeholderData: (previous) => previous });

export const useProduct = (id: string | null) => useQuery({ queryKey: ['product', id], queryFn: () => api<ProductDetail>(`/menu/products/${id}`), enabled: !!id });

/** Everything that shows menu data, including the POS menu cache (`catalog`). */
export function useInvalidateMenu() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of ['products', 'product', 'categories', 'modifier-groups', 'tax-categories', 'catalog']) void queryClient.invalidateQueries({ queryKey: [key] });
  };
}

/** Returns `value` once it has stopped changing for `delay` ms (search boxes). */
export function useDebounced<T>(value: T, delay = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
