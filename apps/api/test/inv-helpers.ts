import { D } from '@pos/money';
import { StockService } from '../src/inventory/stock.service';
import { OutboxService } from '../src/jobs/outbox.service';
import { auth, createUser, login, platformToken, provisionShop, Shop, TestCtx } from './helpers';

export interface Ctx {
  shop: Shop;
  owner: string;
  manager: string;
  storekeeper: string;
  cashier: string;
  users: { manager: string; storekeeper: string; cashier: string };
  emails: { manager: string; storekeeper: string; cashier: string };
}

/** Shop with an owner, manager, storekeeper and cashier all in the Main branch. */
export async function setupShop(t: TestCtx, opts: { plan?: string; shopType?: 'hardware' | 'paint' | 'both' } = {}): Promise<Ctx> {
  const shop = await provisionShop(t, { plan: opts.plan ?? 'enterprise', shopType: opts.shopType });
  if ((opts.plan ?? 'enterprise') === 'basic') {
    await t.http().put(`/v1/admin/shops/${shop.shopId}/limits`).set(auth(await platformToken(t))).send({ key: 'max_users', value: 10 }).expect(204);
  }
  const owner = await login(t, shop.ownerEmail);
  const m = await createUser(t, owner, { roleId: shop.roleIds.manager, branchId: shop.defaultBranchId });
  const sk = await createUser(t, owner, { roleId: shop.roleIds.storekeeper, branchId: shop.defaultBranchId });
  const c = await createUser(t, owner, { roleId: shop.roleIds.cashier, branchId: shop.defaultBranchId });
  return {
    shop, owner, manager: await login(t, m.email), storekeeper: await login(t, sk.email), cashier: await login(t, c.email),
    users: { manager: m.id, storekeeper: sk.id, cashier: c.id },
    emails: { manager: m.email, storekeeper: sk.email, cashier: c.email },
  };
}

export async function addProduct(t: TestCtx, token: string, body: Record<string, unknown>) {
  const res = await t.http().post('/v1/products').set(auth(token)).send({ baseUnit: 'pcs', ...body });
  if (res.status !== 201) throw new Error(`addProduct ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as { id: string; sku: string; short_code: string; name: string; version: number };
}

export async function openingStock(t: TestCtx, token: string, branchId: string, lines: { productId: string; qtyBase: string; unitCost?: string }[]) {
  const res = await t.http().post('/v1/stock/opening').set(auth(token)).send({ branchId, lines });
  if (res.status !== 201) throw new Error(`opening ${res.status}: ${JSON.stringify(res.body)}`);
}

/** Runs StockService against the database like a business flow would (own transaction). */
export function stockTx<T>(t: TestCtx, shopId: string, fn: (svc: StockService, tx: any) => Promise<T>) {
  return t.db.tenant({ shopId }, (tx) => fn(t.app.get(StockService), tx));
}

/** Ledger invariant: every balance equals the sum of its movements. Returns the offending rows. */
export async function ledgerDiffs(t: TestCtx, shopId: string) {
  const r = await t.db.admin((tx) =>
    tx.query(
      `SELECT sb.product_id, sb.quantity, coalesce(m.s,0) AS ledger
       FROM stock_balance sb LEFT JOIN (SELECT branch_id, product_id, sum(qty_base) s FROM stock_movement GROUP BY 1,2) m
         ON m.branch_id=sb.branch_id AND m.product_id=sb.product_id
       WHERE sb.shop_id=$1 AND sb.quantity <> coalesce(m.s,0)`,
      [shopId],
    ),
  );
  return r.rows;
}

export async function balance(t: TestCtx, branchId: string, productId: string): Promise<string> {
  const r = await t.db.admin((tx) => tx.query(`SELECT quantity FROM stock_balance WHERE branch_id=$1 AND product_id=$2`, [branchId, productId]));
  return r.rowCount ? D(r.rows[0].quantity).toString() : '0';
}

/** Registers a terminal and returns a till session (a user logged in on it). */
export async function till(t: TestCtx, c: Ctx, prefix: string, who: 'cashier' | 'manager' | 'owner' = 'cashier') {
  const term = await t.http().post('/v1/terminals').set(auth(c.owner)).send({ branchId: c.shop.defaultBranchId, name: prefix, prefix });
  if (term.status !== 201) throw new Error(`terminal ${term.status}: ${JSON.stringify(term.body)}`);
  const email = who === 'owner' ? c.shop.ownerEmail : c.emails[who];
  const token = await login(t, email, undefined, term.body.id);
  return { terminalId: term.body.id as string, token, prefix };
}

let keySeq = 0;
export const newKey = () => `key-${Date.now()}-${++keySeq}-${Math.random().toString(36).slice(2, 8)}`;

export function sell(t: TestCtx, token: string, body: Record<string, unknown>, key = newKey()) {
  return t.http().post('/v1/sales').set(auth(token)).set('Idempotency-Key', key).send(body);
}

/** Dispatches ALL pending outbox events (other suites may have left a backlog behind). */
export async function drainOutbox(t: TestCtx): Promise<void> {
  const outbox = t.app.get(OutboxService);
  for (let i = 0; i < 200; i++) if ((await outbox.dispatch(500)) === 0) return;
}
