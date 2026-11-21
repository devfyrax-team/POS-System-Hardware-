import { Injectable } from '@nestjs/common';
import { Tx } from '../db/db';
import { TenantSession } from '../common/session';

export interface CreditCharge {
  customerId: string;
  amount: string;
  saleId: string;
  invoiceNo: string;
}

/**
 * Extension points that later modules (customers/credit, cheques, batches, tinting) plug into, so the sales
 * module never reads their tables. A hook runs INSIDE the checkout transaction.
 */
@Injectable()
export class CheckoutHooks {
  /** Locks the customer row, checks the limit and records the receivable. */
  charge?: (tx: Tx, s: TenantSession, c: CreditCharge) => Promise<void>;
  /** Reverses a credit charge (void / refund to account). */
  reverse?: (tx: Tx, s: TenantSession, c: { customerId: string; amount: string; saleId: string; reason: string }) => Promise<void>;
  /** Locks and validates the customer BEFORE any stock row is locked (global lock order: customer -> stock). */
  lockCustomer?: (tx: Tx, s: TenantSession, customerId: string) => Promise<{ tier: 'retail' | 'wholesale' | 'contractor' }>;
  /** Records the cheque details for a cheque payment. */
  cheque?: (tx: Tx, s: TenantSession, c: { saleId: string; amount: string; reference?: string; customerId?: string | null; details?: any }) => Promise<void>;
  /** Picks batches for batch-tracked items (earliest expiry first unless the cashier chose). */
  allocateBatch?: (
    tx: Tx,
    s: TenantSession,
    c: { productId: string; qtyBase: string; preferredBatchId?: string },
  ) => Promise<{ batchId: string | null; allocations?: { batchId: string | null; qtyBase: string; batchNo?: string | null; expiry?: string | null; expired?: boolean }[] }>;
}
