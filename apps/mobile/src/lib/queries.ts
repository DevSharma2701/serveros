/**
 * Data hooks (TanStack Query). Query keys start with a short name that realtime.tsx invalidates,
 * followed by the outlet id so one outlet's cache can never be shown under another outlet.
 * Hooks take `enabled` from the caller's permission check so screens never fire requests the
 * server is certain to refuse.
 */
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrderStatus } from '@serveos/shared';
import { api } from './api';
import { useAuth } from './auth';
import type { Attendance, AuditEvent, Catalog, Dashboard, Order, OrderSummary, Paged, Session, Shift, ShiftDetail, StockRow } from './types';

export const LIVE_STATUSES: OrderStatus[] = ['CONFIRMED', 'PREPARING', 'READY'];

const useOutletId = (): string | null => useAuth().outlet?.id ?? null;

export interface DashboardParams {
  from: string;
  to: string;
  outletIds: string[];
}

export function useDashboard(params: DashboardParams, enabled = true) {
  const outletIds = [...params.outletIds].sort().join(',');
  return useQuery({
    queryKey: ['dashboard', params.from, params.to, outletIds],
    // Reports span outlets: the outlet list travels in the query string, not the X-Outlet-Id header.
    queryFn: ({ signal }) => api<Dashboard>('/reports/dashboard', { query: { from: params.from, to: params.to, outletIds }, outletId: null, signal }),
    enabled: enabled && params.outletIds.length > 0,
    placeholderData: keepPreviousData,
  });
}

export function useLiveOrders(enabled = true, options: { pollMs?: number | false } = {}) {
  const outletId = useOutletId();
  return useQuery({
    queryKey: ['orders', outletId, 'live'],
    queryFn: ({ signal }) => api<Paged<OrderSummary>>('/orders', { query: { status: LIVE_STATUSES.join(','), page: 1, pageSize: 50 }, signal }),
    enabled: enabled && !!outletId,
    refetchInterval: options.pollMs ?? false,
  });
}

/** Cancelled orders that were created on one calendar day (the API filters the list by creation time, outlet time zone). */
export function useCancelledOrders(day: string, enabled = true) {
  const outletId = useOutletId();
  return useQuery({
    queryKey: ['orders', outletId, 'cancelled', day],
    queryFn: ({ signal }) => api<Paged<OrderSummary>>('/orders', { query: { status: 'CANCELLED', from: day, to: day, page: 1, pageSize: 50 }, signal }),
    enabled: enabled && !!outletId,
  });
}

export function useOrder(id: string | undefined, enabled = true) {
  const outletId = useOutletId();
  return useQuery({
    queryKey: ['order', outletId, id],
    queryFn: ({ signal }) => api<Order>(`/orders/${id}`, { signal }),
    enabled: enabled && !!outletId && !!id,
  });
}

export function useCatalog(enabled = true) {
  const outletId = useOutletId();
  return useQuery({
    queryKey: ['catalog', outletId],
    queryFn: ({ signal }) => api<Catalog>('/menu/catalog', { signal }),
    enabled: enabled && !!outletId,
  });
}

/** Marks a product available / unavailable in the selected outlet, optimistically. */
export function useSetAvailability() {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  const key = ['catalog', outletId];
  return useMutation({
    mutationFn: ({ productId, isAvailable }: { productId: string; isAvailable: boolean }) =>
      api(`/menu/products/${productId}/availability`, { method: 'PUT', body: { isAvailable } }),
    onMutate: async ({ productId, isAvailable }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Catalog>(key);
      if (previous) {
        queryClient.setQueryData<Catalog>(key, { ...previous, products: previous.products.map((p) => (p.id === productId ? { ...p, isAvailable } : p)) });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

export function useStock(enabled = true) {
  const outletId = useOutletId();
  return useQuery({
    queryKey: ['stock', outletId],
    queryFn: ({ signal }) => api<StockRow[]>('/inventory/stock', { signal }),
    enabled: enabled && !!outletId,
  });
}

export function useShifts(enabled = true) {
  const outletId = useOutletId();
  return useQuery({
    queryKey: ['shifts', outletId],
    queryFn: ({ signal }) => api<Shift[]>('/shifts', { signal }),
    enabled: enabled && !!outletId,
  });
}

export function useShift(id: string | undefined, enabled = true) {
  const outletId = useOutletId();
  return useQuery({
    queryKey: ['shifts', outletId, id],
    queryFn: ({ signal }) => api<ShiftDetail>(`/shifts/${id}`, { signal }),
    enabled: enabled && !!outletId && !!id,
  });
}

const AUDIT_PAGE = 50;

export function useAuditEvents(enabled = true) {
  return useInfiniteQuery({
    queryKey: ['audit'],
    queryFn: ({ pageParam, signal }) => api<Paged<AuditEvent>>('/audit-events', { query: { page: pageParam, pageSize: AUDIT_PAGE }, outletId: null, signal }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
    enabled,
  });
}

export function useAttendance(enabled = true) {
  const outletId = useOutletId();
  return useQuery({
    queryKey: ['attendance', outletId],
    queryFn: ({ signal }) => api<Attendance[]>('/attendance', { signal }),
    enabled: enabled && !!outletId,
  });
}

export function useSessions() {
  return useQuery({
    queryKey: ['sessions'],
    queryFn: ({ signal }) => api<Session[]>('/auth/sessions', { outletId: null, signal }),
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/auth/sessions/${id}`, { method: 'DELETE', outletId: null }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  });
}

export function useChangePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) => api('/auth/password/change', { method: 'POST', body, outletId: null }),
    // The server signs out every other device when the password changes.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  });
}
