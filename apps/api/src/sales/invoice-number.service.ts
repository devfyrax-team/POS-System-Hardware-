import { Injectable } from '@nestjs/common';
import { Tx } from '../db/db';
import { E } from '../common/errors';

/**
 * Per-terminal invoice numbers, e.g. MAIN-T2-000123. The counter row belongs to ONE terminal and is advanced
 * inside the sale transaction, so a failed sale leaves no gap and tills never wait on a branch-wide counter.
 */
@Injectable()
export class InvoiceNumberService {
  async next(tx: Tx, shopId: string, terminalId: string): Promise<{ invoiceNo: string; seq: number }> {
    const r = (
      await tx.query(
        `UPDATE invoice_sequence s SET next = next + 1 FROM terminal t
         WHERE s.shop_id=$1 AND s.terminal_id=$2 AND t.shop_id=s.shop_id AND t.id=s.terminal_id AND t.status='active'
         RETURNING t.prefix, s.next - 1 AS seq`,
        [shopId, terminalId],
      )
    ).rows[0];
    if (!r) throw E.forbidden('Terminal is not active');
    const seq = Number(r.seq);
    return { invoiceNo: `${r.prefix}-${String(seq).padStart(6, '0')}`, seq };
  }
}
