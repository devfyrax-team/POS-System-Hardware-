import { Injectable } from '@nestjs/common';
import { D } from '@pos/money';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { TenantSession } from '../common/session';
import { AuditService } from '../audit/audit.service';
import { ChequeInput, ChequeService } from '../customers/cheque.service';

export interface SupplierInput {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  paymentTermsDays?: number;
  returnTerms?: string;
}

const COLS = `id, name, phone, email, address, payment_terms_days, return_terms, status, version, created_at`;

@Injectable()
export class SupplierService {
  constructor(private readonly audit: AuditService, private readonly cheques: ChequeService) {}

  async create(tx: Tx, s: TenantSession, i: SupplierInput) {
    try {
      const r = (
        await tx.query(
          `INSERT INTO supplier(shop_id, name, phone, email, address, payment_terms_days, return_terms) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${COLS}`,
          [s.shopId, i.name, i.phone ?? null, i.email ?? null, i.address ?? null, i.paymentTermsDays ?? 30, i.returnTerms ?? null],
        )
      ).rows[0];
      await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'supplier.created', entity: 'supplier', entityId: r.id, new: { name: i.name } });
      return r;
    } catch (e: any) {
      if (e.code === '23505') throw E.conflict('A supplier with this name already exists');
      throw e;
    }
  }

  async update(tx: Tx, s: TenantSession, id: string, version: number, p: Partial<SupplierInput> & { status?: 'active' | 'inactive' }) {
    const r = await tx.query(
      `UPDATE supplier SET name=coalesce($4,name), phone=coalesce($5,phone), email=coalesce($6,email), address=coalesce($7,address),
         payment_terms_days=coalesce($8,payment_terms_days), return_terms=coalesce($9,return_terms), status=coalesce($10,status), version=version+1
       WHERE shop_id=$1 AND id=$2 AND version=$3 RETURNING ${COLS}`,
      [s.shopId, id, version, p.name ?? null, p.phone ?? null, p.email ?? null, p.address ?? null, p.paymentTermsDays ?? null, p.returnTerms ?? null, p.status ?? null],
    );
    if (!r.rowCount) {
      if (!(await tx.query(`SELECT 1 FROM supplier WHERE shop_id=$1 AND id=$2`, [s.shopId, id])).rowCount) throw E.notFound('Supplier');
      throw E.versionConflict();
    }
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'supplier.updated', entity: 'supplier', entityId: id, new: p });
    return r.rows[0];
  }

  async get(tx: Tx, shopId: string, id: string) {
    const r = (await tx.query(`SELECT ${COLS}, (SELECT coalesce(sum(amount),0) FROM supplier_ledger WHERE supplier_id=supplier.id) AS balance FROM supplier WHERE shop_id=$1 AND id=$2`, [shopId, id])).rows[0];
    if (!r) throw E.notFound('Supplier');
    return r;
  }

  async list(tx: Tx, shopId: string) {
    return (
      await tx.query(
        `SELECT ${COLS}, (SELECT coalesce(sum(amount),0) FROM supplier_ledger l WHERE l.supplier_id=supplier.id) AS balance FROM supplier WHERE shop_id=$1 ORDER BY name`,
        [shopId],
      )
    ).rows;
  }

  async balance(tx: Tx, shopId: string, id: string): Promise<string> {
    return D((await tx.query(`SELECT coalesce(sum(amount),0) b FROM supplier_ledger WHERE shop_id=$1 AND supplier_id=$2`, [shopId, id])).rows[0].b).toString();
  }

  /** Statement with a running balance of what we owe. */
  async statement(tx: Tx, shopId: string, supplierId: string) {
    const sup = await this.get(tx, shopId, supplierId);
    let run = D(0);
    const entries = (await tx.query(`SELECT id, created_at, entry_type, amount, ref_type, ref_id, due_date, note FROM supplier_ledger WHERE shop_id=$1 AND supplier_id=$2 ORDER BY id`, [shopId, supplierId])).rows.map((r) => {
      run = run.plus(r.amount);
      return { ...r, balance: run.toString() };
    });
    return { supplier: { id: sup.id, name: sup.name, returnTerms: sup.return_terms }, closingBalance: run.toString(), entries };
  }

  /** Payments are recorded separately and can be partial. */
  async pay(tx: Tx, s: TenantSession, i: { supplierId: string; amount: string; method: 'cash' | 'bank_transfer' | 'cheque' | 'card'; reference?: string; cheque?: ChequeInput }) {
    if (!D(i.amount).gt(0)) throw E.validation('Amount must be positive');
    await tx.query(`SELECT 1 FROM supplier WHERE shop_id=$1 AND id=$2 FOR UPDATE`, [s.shopId, i.supplierId]);
    const owed = D(await this.balance(tx, s.shopId, i.supplierId));
    if (D(i.amount).gt(owed)) throw E.validation('Payment is more than what is owed to this supplier', { owed: owed.toString() });
    if (i.method === 'cheque' && !i.cheque) throw E.validation('Cheque details are required');
    const p = (
      await tx.query(`INSERT INTO supplier_payment(shop_id, supplier_id, amount, method, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [
        s.shopId, i.supplierId, i.amount, i.method, i.reference ?? null, s.userId,
      ])
    ).rows[0];
    await tx.query(
      `INSERT INTO supplier_ledger(shop_id, supplier_id, entry_type, amount, ref_type, ref_id, note, created_by) VALUES ($1,$2,'payment',$3,'supplier_payment',$4,$5,$6)`,
      [s.shopId, i.supplierId, D(i.amount).neg().toString(), p.id, i.reference ?? null, s.userId],
    );
    let chequeId: string | undefined;
    if (i.method === 'cheque') chequeId = (await this.cheques.recordIssued(tx, s, { supplierId: i.supplierId, amount: i.amount, paymentId: p.id, cheque: i.cheque! })).id;
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'supplier.paid', entity: 'supplier', entityId: i.supplierId, new: { amount: i.amount, method: i.method } });
    return { paymentId: p.id as string, balance: owed.minus(i.amount).toString(), chequeId };
  }
}
