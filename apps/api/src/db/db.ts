import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { config } from '../common/config';

export interface Tx {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[]; rowCount: number }>;
}

export interface TenantCtx {
  shopId: string;
  userId?: string;
}

function wrap(c: PoolClient): Tx {
  return {
    async query(sql, params) {
      const r = await c.query(sql, params);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
  };
}

/**
 * All database access goes through here.
 *  - tenant(): app role, RLS bound to ctx.shopId via a transaction-local setting (pooler-safe).
 *  - platform(): app role with the platform flag (Super Admin / worker); optional shop binding.
 *  - admin(): superuser, migrations/tests only. Never used by request handlers.
 */
@Injectable()
export class Db implements OnModuleDestroy {
  readonly appPool: Pool;
  readonly adminPool: Pool;

  constructor() {
    const c = config();
    this.appPool = new Pool({ connectionString: c.databaseUrl, max: 20 });
    this.adminPool = new Pool({ connectionString: c.adminDatabaseUrl, max: 5 });
  }

  private async run<T>(pool: Pool, setup: ((c: PoolClient) => Promise<void>) | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (setup) await setup(c);
      const out = await fn(wrap(c));
      await c.query('COMMIT');
      return out;
    } catch (e) {
      try {
        await c.query('ROLLBACK');
      } catch {
        /* connection already broken */
      }
      throw e;
    } finally {
      c.release();
    }
  }

  tenant<T>(ctx: TenantCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(
      this.appPool,
      async (c) => {
        await c.query(
          `select set_config('app.shop_id', $1, true), set_config('app.user_id', $2, true), set_config('app.is_platform_admin', 'false', true)`,
          [ctx.shopId, ctx.userId ?? ''],
        );
      },
      fn,
    );
  }

  platform<T>(fn: (tx: Tx) => Promise<T>, shopId?: string): Promise<T> {
    return this.run(
      this.appPool,
      async (c) => {
        await c.query(
          `select set_config('app.shop_id', $1, true), set_config('app.is_platform_admin', 'true', true)`,
          [shopId ?? ''],
        );
      },
      fn,
    );
  }

  admin<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(this.adminPool, null, fn);
  }

  /** Lookups that happen before a shop is known (login, refresh) via SECURITY DEFINER functions. */
  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const r = await this.appPool.query(sql, params);
    return r.rows as T[];
  }

  async onModuleDestroy() {
    await Promise.all([this.appPool.end(), this.adminPool.end()]);
  }
}
