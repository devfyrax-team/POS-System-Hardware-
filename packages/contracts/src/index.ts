// Shared contracts: permission keys, feature keys, roles, error codes.

export const SHOP_TYPES = ['hardware', 'paint', 'both'] as const;
export type ShopType = (typeof SHOP_TYPES)[number];

/** Every permission a role can hold. Checked by @RequirePermission(). */
export const PERMISSIONS = [
  'sale.create',
  'payment.take',
  'price.change',
  'price.override_on_sale',
  'cost.view',
  'profit.view',
  'sale.void',
  'sale.refund',
  'discount.large',
  'stock.receive',
  'stock.count',
  'stock.adjust_request',
  'stock.adjust',
  'lowstock.receive_alerts',
  'catalog.manage',
  'purchase.manage',
  'customer.manage',
  'credit.manage',
  'report.view',
  'user.manage',
  'role.manage',
  'branch.manage',
  'terminal.manage',
  'shop.settings',
  'approval.grant',
  'transfer.manage',
  'import.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Feature keys a Super Admin can grant to a shop (via plan or override). */
export const FEATURES = [
  'multi_branch',
  'branch_transfers',
  'batch_expiry',
  'colour_tinting',
  'credit_sales',
  'cheques',
  'quotations',
  'delivery_notes',
  'price_tiers',
  'bulk_import',
  'label_printing',
  'advanced_profit',
  'sms_alerts',
  'whatsapp_alerts',
  'api_access',
  'custom_roles',
] as const;
export type FeatureKey = (typeof FEATURES)[number];

/** Which permission needs which feature to be usable by a shop. */
export const PERMISSION_FEATURE: Partial<Record<Permission, FeatureKey>> = {
  'transfer.manage': 'branch_transfers',
  'import.manage': 'bulk_import',
  'credit.manage': 'credit_sales',
};

/** Features restricted to certain shop types (others are always allowed). */
export const FEATURE_SHOP_TYPES: Partial<Record<FeatureKey, ShopType[]>> = {
  colour_tinting: ['paint', 'both'],
  batch_expiry: ['paint', 'both', 'hardware'],
};

export const LIMITS = [
  'max_users',
  'max_branches',
  'max_terminals_per_branch',
  'max_products',
  'sms_monthly_allowance',
] as const;
export type LimitKey = (typeof LIMITS)[number];

export const SYSTEM_ROLES = ['owner', 'manager', 'cashier', 'storekeeper'] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

const ALL = [...PERMISSIONS] as Permission[];

export const DEFAULT_ROLE_PERMISSIONS: Record<SystemRole, Permission[]> = {
  owner: ALL,
  manager: ALL.filter((p) => !['role.manage', 'branch.manage', 'shop.settings'].includes(p)),
  cashier: ['sale.create', 'payment.take', 'customer.manage'],
  storekeeper: [
    'stock.receive',
    'stock.count',
    'stock.adjust_request',
    'lowstock.receive_alerts',
    'catalog.manage',
  ],
};

/** Stable machine-readable error codes returned by the API. */
export const ERROR_CODES = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  FEATURE_NOT_ENABLED: 'FEATURE_NOT_ENABLED',
  PLAN_LIMIT: 'PLAN_LIMIT',
  SUBSCRIPTION_RESTRICTED: 'SUBSCRIPTION_RESTRICTED',
  STOCK_SHORT: 'STOCK_SHORT',
  CREDIT_LIMIT: 'CREDIT_LIMIT',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  CONFLICT: 'CONFLICT',
  IDEMPOTENCY_MISMATCH: 'IDEMPOTENCY_MISMATCH',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type PaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'cheque' | 'credit';
export const PAYMENT_METHODS: PaymentMethod[] = ['cash', 'card', 'bank_transfer', 'cheque', 'credit'];

export type MovementType =
  | 'opening'
  | 'purchase'
  | 'sale'
  | 'sales_return'
  | 'purchase_return'
  | 'adjustment'
  | 'transfer_out'
  | 'transfer_in'
  | 'damaged'
  | 'expired'
  | 'stocktake';
