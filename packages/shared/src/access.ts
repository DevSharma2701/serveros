/**
 * Access control catalogue. The API seeds these into the database on start-up and
 * enforces them on every request; the web and mobile apps only use them to hide UI.
 */
export const PERMISSIONS = {
  'platform.manage': ['Platform', 'Create and manage restaurants on the platform'],
  'restaurant.manage': ['Setup', 'Edit restaurant profile, tax and billing settings'],
  'outlet.manage': ['Setup', 'Create and edit outlets'],
  'staff.view': ['Staff', 'View staff members'],
  'staff.manage': ['Staff', 'Invite staff, change roles, outlets and permissions'],
  'audit.view': ['Staff', 'View the audit log'],
  'menu.view': ['Menu', 'View the menu'],
  'menu.manage': ['Menu', 'Create and edit categories, products, modifiers and taxes'],
  'menu.availability': ['Menu', 'Mark products available or unavailable in an outlet'],
  'table.view': ['Floor', 'View the floor plan'],
  'table.manage': ['Floor', 'Create and edit dining areas and tables'],
  'table.transfer': ['Floor', 'Transfer, merge and split table orders'],
  'reservation.manage': ['Floor', 'Create and update reservations'],
  'order.view': ['Orders', 'View orders'],
  'order.create': ['Orders', 'Create orders and send them to the kitchen'],
  'order.update': ['Orders', 'Add items to an existing order'],
  'order.complete': ['Orders', 'Complete orders'],
  'order.cancel': ['Orders', 'Cancel orders'],
  'order.void_item': ['Orders', 'Void items that were already sent to the kitchen'],
  'discount.apply': ['Billing', 'Apply discounts up to the approval threshold'],
  'discount.approve_high': ['Billing', 'Apply discounts above the approval threshold'],
  'discount.manage': ['Billing', 'Create and edit discounts and coupons'],
  'payment.record': ['Billing', 'Record payments'],
  'payment.refund': ['Billing', 'Refund payments'],
  'kitchen.view': ['Kitchen', 'View kitchen tickets'],
  'kitchen.update': ['Kitchen', 'Update kitchen ticket status'],
  'kitchen.manage': ['Kitchen', 'Configure kitchen stations'],
  'shift.operate': ['Cash', 'Open and close own cash shift and record cash movements'],
  'shift.view_all': ['Cash', 'View all shifts in an outlet'],
  'shift.approve_variance': ['Cash', 'Approve a shift closing with a large cash variance'],
  'shift.manage': ['Cash', 'Create cash registers and close shifts opened by others'],
  'inventory.view': ['Inventory', 'View stock, movements and recipes'],
  'inventory.manage': ['Inventory', 'Edit ingredients, record wastage, adjustments, counts and transfers'],
  'recipe.manage': ['Inventory', 'Create and change recipes'],
  'purchasing.manage': ['Inventory', 'Manage suppliers, purchase orders and goods receipts'],
  'customer.view': ['Customers', 'Search customers and see their names'],
  'customer.view_contact': ['Customers', 'See customer phone numbers and email addresses'],
  'customer.manage': ['Customers', 'Create and edit customers'],
  'customer.notes': ['Customers', 'Read and write customer notes'],
  'loyalty.adjust': ['Customers', 'Manually adjust loyalty points'],
  'report.view': ['Reports', 'View sales and operational reports'],
  'report.export': ['Reports', 'Export reports to CSV'],
} as const satisfies Record<string, readonly [category: string, description: string]>;

export type PermissionKey = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[];

export const ROLE_KEYS = [
  'PLATFORM_ADMIN',
  'RESTAURANT_OWNER',
  'RESTAURANT_ADMIN',
  'OUTLET_MANAGER',
  'INVENTORY_MANAGER',
  'CASHIER',
  'WAITER',
  'KITCHEN_STAFF',
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

const restaurantWide = ALL_PERMISSIONS.filter((p) => p !== 'platform.manage');

const managerExcluded: PermissionKey[] = ['platform.manage', 'restaurant.manage', 'outlet.manage', 'menu.manage', 'discount.manage'];

/** Built-in roles. `rank` decides who may manage whom: only strictly lower ranks. */
export const SYSTEM_ROLES: Record<RoleKey, { name: string; rank: number; permissions: PermissionKey[] }> = {
  PLATFORM_ADMIN: { name: 'Platform admin', rank: 100, permissions: ALL_PERMISSIONS },
  RESTAURANT_OWNER: { name: 'Restaurant owner', rank: 90, permissions: restaurantWide },
  RESTAURANT_ADMIN: { name: 'Restaurant admin', rank: 80, permissions: restaurantWide },
  OUTLET_MANAGER: {
    name: 'Outlet manager',
    rank: 60,
    permissions: ALL_PERMISSIONS.filter((p) => !managerExcluded.includes(p)),
  },
  INVENTORY_MANAGER: {
    name: 'Inventory manager',
    rank: 40,
    permissions: ['menu.view', 'inventory.view', 'inventory.manage', 'recipe.manage', 'purchasing.manage', 'report.view'],
  },
  CASHIER: {
    name: 'Cashier',
    rank: 30,
    permissions: [
      'menu.view',
      'table.view',
      'table.transfer',
      'reservation.manage',
      'order.view',
      'order.create',
      'order.update',
      'order.complete',
      'discount.apply',
      'payment.record',
      'kitchen.view',
      'shift.operate',
      'customer.view',
      'customer.view_contact',
      'customer.manage',
    ],
  },
  WAITER: {
    name: 'Waiter',
    rank: 20,
    permissions: ['menu.view', 'table.view', 'table.transfer', 'order.view', 'order.create', 'order.update', 'kitchen.view', 'customer.view'],
  },
  KITCHEN_STAFF: {
    name: 'Kitchen staff',
    rank: 20,
    permissions: ['menu.view', 'menu.availability', 'order.view', 'kitchen.view', 'kitchen.update'],
  },
};
