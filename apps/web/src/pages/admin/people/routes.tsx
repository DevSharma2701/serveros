import { Contact, ScrollText, Users } from 'lucide-react';
import type { AdminRoute } from '../routes';
import { AuditPage } from './AuditPage';
import { CustomersPage } from './CustomersPage';
import { StaffPage } from './StaffPage';

export const peopleRoutes: AdminRoute[] = [
  { path: 'customers', label: 'Customers', icon: Contact, group: 'People', permission: 'customer.view', element: <CustomersPage /> },
  { path: 'staff', label: 'Staff', icon: Users, group: 'People', permission: 'staff.view', element: <StaffPage /> },
  { path: 'audit', label: 'Audit log', icon: ScrollText, group: 'People', permission: 'audit.view', element: <AuditPage /> },
];
