/** Shapes of the API responses the KDS reads. The API is the source of truth for all of them. */
import type { KitchenTicketStatus, OrderType, PermissionKey } from '@serveos/shared';

export interface OutletRef {
  id: string;
  name: string;
  code: string;
}

export interface Me {
  user: { id: string; name: string; email: string };
  outlets: OutletRef[];
  permissions: PermissionKey[];
  outletPermissions: Record<string, PermissionKey[]>;
}

export interface Station {
  id: string;
  key: string;
  name: string;
  isActive?: boolean;
}

export interface TicketItem {
  id: string;
  name: string;
  quantity: number;
  /** Comma-separated modifier names, already formatted by the API. */
  modifiers: string;
  notes: string;
  isPrepared: boolean;
  isCancelled: boolean;
}

export interface Ticket {
  id: string;
  orderId: string;
  stationId: string;
  ticketNumber: string;
  status: KitchenTicketStatus;
  orderType: OrderType;
  orderNumber: string;
  tableLabel: string;
  /** Order-level notes (allergies are written here by the POS). */
  notes: string;
  firedAt: string;
  startedAt: string | null;
  readyAt: string | null;
  items: TicketItem[];
  station: Station;
}

export type BumpStatus = 'PENDING' | 'PREPARING' | 'READY';
export type ConnectionStatus = 'live' | 'reconnecting' | 'offline';
export type BoardView = 'active' | 'recent';
