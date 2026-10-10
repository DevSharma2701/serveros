/** API response shapes for the People pages (customers, staff, schedules, attendance, audit). */
import type { PermissionKey } from '@serveos/shared';

export interface CustomerRow {
  id: string;
  name: string;
  /** Masked ("••••••0001") unless the role may see contact details. */
  phone: string | null;
  email: string;
  gstin: string;
  stateCode: string;
  /** Absent unless the role holds customer.notes. */
  notes?: string;
  marketingSms: boolean;
  marketingEmail: boolean;
  marketingWhatsapp: boolean;
  consentUpdatedAt: string | null;
  loyaltyPoints: number;
  createdAt: string;
}

export interface LoyaltyEntry {
  id: string;
  type: 'EARN' | 'REDEEM' | 'REVERSAL' | 'ADJUSTMENT';
  points: number;
  balanceAfter: number;
  reason: string;
  createdAt: string;
}

export interface CustomerDetail extends CustomerRow {
  orders: Array<{ id: string; orderNumber: string; type: string; status: string; totalMinor: number; createdAt: string; outletId: string }>;
  ledger: LoyaltyEntry[];
}

export interface Role {
  id: string;
  key: string;
  name: string;
  rank: number;
  permissions: Array<{ permissionKey: string }>;
}

export interface Grant {
  id: string;
  permissionKey: PermissionKey;
  outletId: string | null;
}

export interface StaffMember {
  id: string;
  roleId: string;
  email: string;
  name: string;
  phone: string;
  employeeCode: string;
  jobTitle: string;
  status: 'INVITED' | 'ACTIVE' | 'DISABLED';
  allOutlets: boolean;
  lastLoginAt: string | null;
  role: { id: string; key: string; name: string; rank: number };
  assignments: Array<{ outletId: string }>;
  grants: Grant[];
}

export interface Schedule {
  id: string;
  userId: string;
  startsAt: string;
  endsAt: string;
  note: string;
  user: { id: string; name: string };
}

export interface AttendanceRow {
  id: string;
  userId: string;
  clockInAt: string;
  clockOutAt: string | null;
  user: { id: string; name: string };
}

export interface AuditEvent {
  id: string;
  outletId: string | null;
  actorId: string | null;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: unknown;
  createdAt: string;
}
