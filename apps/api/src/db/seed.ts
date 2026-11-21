import { Pool } from 'pg';
import { FEATURES } from '@pos/contracts';

const FEATURE_MODULE: Record<string, string> = {
  multi_branch: 'identity', branch_transfers: 'inventory', batch_expiry: 'inventory', colour_tinting: 'paint',
  credit_sales: 'customers', cheques: 'customers', quotations: 'sales', delivery_notes: 'sales',
  price_tiers: 'catalog', bulk_import: 'import', label_printing: 'catalog', advanced_profit: 'reporting',
  sms_alerts: 'notifications', whatsapp_alerts: 'notifications', api_access: 'platform', custom_roles: 'identity',
};

export const PLAN_DEFS = [
  {
    code: 'basic', name: 'Basic', monthly: '2500', annual: '25000', trial: 14,
    features: ['quotations'],
    limits: { max_users: 3, max_branches: 1, max_terminals_per_branch: 2, max_products: 2000, sms_monthly_allowance: 0 },
  },
  {
    code: 'pro', name: 'Pro', monthly: '7500', annual: '75000', trial: 14,
    features: ['multi_branch', 'branch_transfers', 'batch_expiry', 'credit_sales', 'cheques', 'quotations', 'delivery_notes',
      'price_tiers', 'bulk_import', 'label_printing', 'custom_roles', 'sms_alerts'],
    limits: { max_users: 15, max_branches: 5, max_terminals_per_branch: 5, max_products: 20000, sms_monthly_allowance: 500 },
  },
  {
    code: 'enterprise', name: 'Enterprise', monthly: '20000', annual: '200000', trial: 30,
    features: [...FEATURES],
    limits: {} as Record<string, number>, // unlimited
  },
];

/** Idempotent upsert of the feature catalog and default plans. */
export async function seedPlatformData(pool: Pool) {
  for (const key of FEATURES) {
    await pool.query(
      `INSERT INTO feature(key, description, module) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET module = EXCLUDED.module`,
      [key, key.replace(/_/g, ' '), FEATURE_MODULE[key] ?? 'misc'],
    );
  }
  for (const p of PLAN_DEFS) {
    const r = await pool.query(
      `INSERT INTO plan(code, name, price_monthly, price_annual, trial_days) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [p.code, p.name, p.monthly, p.annual, p.trial],
    );
    const id = r.rows[0].id;
    for (const f of p.features) {
      await pool.query(`INSERT INTO plan_feature(plan_id, feature_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, f]);
    }
    for (const [k, v] of Object.entries(p.limits)) {
      await pool.query(
        `INSERT INTO plan_limit(plan_id, limit_key, value) VALUES ($1,$2,$3)
         ON CONFLICT (plan_id, limit_key) DO UPDATE SET value = EXCLUDED.value`,
        [id, k, v],
      );
    }
  }
}
