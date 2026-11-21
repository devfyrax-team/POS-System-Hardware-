import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { config } from '../common/config';
import { E } from '../common/errors';
import { RateLimiter } from '../common/rate-limiter';
import { Db, Tx } from '../db/db';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../identity/access.service';
import { FeatureService } from '../platform/feature.service';
import { hashSecret, verifySecret } from './password';
import { TokenService } from './token.service';

export interface AuthResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  user: { id: string; name: string };
  session: { shopId: string; branchId?: string; terminalId?: string };
  mustChangePassword: boolean;
}

const PIN_SESSION_TTL = 12 * 3600;

@Injectable()
export class AuthService {
  private loginLimiter = new RateLimiter(10, 15 * 60_000);
  private pinLimiter = new RateLimiter(5, 5 * 60_000);

  constructor(
    private readonly db: Db,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly features: FeatureService,
    private readonly access: AccessService,
  ) {}

  // ---------- helpers ----------
  private accessToken(s: { userId: string; shopId: string; branchId?: string; terminalId?: string }, ttl = config().accessTtlSec) {
    return this.tokens.sign({ typ: 'access', uid: s.userId, sid: s.shopId, bid: s.branchId, tid: s.terminalId }, ttl);
  }

  private async newRefresh(tx: Tx, p: { shopId: string; userId: string; familyId?: string; terminalId?: string; branchId?: string }) {
    const raw = TokenService.newOpaqueToken();
    await tx.query(
      `INSERT INTO refresh_token(shop_id, user_id, family_id, token_hash, terminal_id, branch_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval)`,
      [p.shopId, p.userId, p.familyId ?? randomUUID(), TokenService.hashOpaque(raw), p.terminalId ?? null, p.branchId ?? null, String(config().refreshTtlSec)],
    );
    return raw;
  }

  /** Branch must be one where the user holds a role (or the user is shop-wide). */
  private async bindBranch(tx: Tx, shopId: string, userId: string, terminalId?: string) {
    const { features } = await this.features.resolve(tx, shopId);
    let branchId: string | undefined;
    if (terminalId) {
      const t = (await tx.query(`SELECT branch_id, status FROM terminal WHERE shop_id=$1 AND id=$2`, [shopId, terminalId])).rows[0];
      if (!t || t.status !== 'active') throw E.forbidden('Terminal is not active');
      branchId = t.branch_id;
    } else {
      const bs = (await tx.query(`SELECT id FROM branch WHERE shop_id=$1 AND status='active'`, [shopId])).rows;
      if (bs.length === 1) branchId = bs[0].id; // single-branch shops are auto-bound
    }
    const acc = await this.access.load(tx, userId, undefined, features);
    if (!acc.allBranches && acc.branchIds.size === 0) throw E.forbidden('User has no role assigned');
    if (branchId && !acc.allBranches && !acc.branchIds.has(branchId)) throw E.forbidden('User has no role in this branch');
    return branchId;
  }

  // ---------- tenant users ----------
  async login(input: { email: string; password: string; terminalId?: string; ip?: string }): Promise<AuthResult> {
    const email = input.email.trim().toLowerCase();
    this.loginLimiter.check(`${input.ip ?? '-'}:${email}`);
    const u = (await this.db.query(`SELECT * FROM auth_find_user($1)`, [email]))[0];
    if (!u || !(await verifySecret(u.password_hash, input.password))) throw E.unauthenticated('Invalid email or password');
    if (u.status !== 'active') throw E.unauthenticated('Account is inactive');

    const out = await this.db.tenant({ shopId: u.shop_id, userId: u.id }, async (tx) => {
      const r = await this.features.resolve(tx, u.shop_id);
      if (r.shopStatus === 'suspended') throw E.subscriptionRestricted('This shop is suspended');
      const branchId = await this.bindBranch(tx, u.shop_id, u.id, input.terminalId);
      const refresh = await this.newRefresh(tx, { shopId: u.shop_id, userId: u.id, terminalId: input.terminalId, branchId });
      await this.audit.record(tx, { shopId: u.shop_id, actorId: u.id, action: 'auth.login', terminalId: input.terminalId ?? null });
      return { branchId, refresh };
    });
    this.loginLimiter.reset(`${input.ip ?? '-'}:${email}`);

    return {
      accessToken: this.accessToken({ userId: u.id, shopId: u.shop_id, branchId: out.branchId, terminalId: input.terminalId }),
      refreshToken: out.refresh,
      expiresIn: config().accessTtlSec,
      user: { id: u.id, name: u.name },
      session: { shopId: u.shop_id, branchId: out.branchId, terminalId: input.terminalId },
      mustChangePassword: u.must_change_password,
    };
  }

  /** Rotating refresh tokens with reuse detection: replaying a used token revokes the whole family. */
  async refresh(rawToken: string): Promise<AuthResult> {
    const row = (await this.db.query(`SELECT * FROM auth_find_refresh($1)`, [TokenService.hashOpaque(rawToken)]))[0];
    if (!row) throw E.unauthenticated('Invalid refresh token');
    if (row.revoked_at) {
      await this.db.query(`SELECT auth_revoke_family($1)`, [row.family_id]);
      throw E.unauthenticated('Refresh token was already used');
    }
    if (new Date(row.expires_at) < new Date()) throw E.unauthenticated('Refresh token expired');

    return this.db.tenant({ shopId: row.shop_id, userId: row.user_id }, async (tx) => {
      const u = (await tx.query(`SELECT id, name, status, must_change_password FROM users WHERE shop_id=$1 AND id=$2`, [row.shop_id, row.user_id])).rows[0];
      if (!u || u.status !== 'active') throw E.unauthenticated('Account is inactive');
      const r = await this.features.resolve(tx, row.shop_id);
      if (r.shopStatus === 'suspended') throw E.subscriptionRestricted('This shop is suspended');
      await tx.query(`UPDATE refresh_token SET revoked_at=now() WHERE id=$1`, [row.id]);
      const next = await this.newRefresh(tx, {
        shopId: row.shop_id, userId: row.user_id, familyId: row.family_id, terminalId: row.terminal_id ?? undefined, branchId: row.branch_id ?? undefined,
      });
      return {
        accessToken: this.accessToken({ userId: u.id, shopId: row.shop_id, branchId: row.branch_id ?? undefined, terminalId: row.terminal_id ?? undefined }),
        refreshToken: next,
        expiresIn: config().accessTtlSec,
        user: { id: u.id, name: u.name },
        session: { shopId: row.shop_id, branchId: row.branch_id ?? undefined, terminalId: row.terminal_id ?? undefined },
        mustChangePassword: u.must_change_password,
      };
    });
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const row = (await this.db.query(`SELECT * FROM auth_find_refresh($1)`, [TokenService.hashOpaque(rawToken)]))[0];
    if (row) await this.db.query(`SELECT auth_revoke_family($1)`, [row.family_id]);
  }

  /**
   * A signed-in user starts working at a till: binds this session to a registered terminal (and its branch).
   * The user must hold a role at that branch. Tokens are re-issued so the terminal survives a refresh.
   */
  async selectTerminal(s: { shopId: string; userId: string }, input: { terminalId: string; oldRefreshToken?: string }): Promise<AuthResult> {
    return this.db.tenant({ shopId: s.shopId, userId: s.userId }, async (tx) => {
      const u = (await tx.query(`SELECT id, name, status, must_change_password FROM users WHERE shop_id=$1 AND id=$2`, [s.shopId, s.userId])).rows[0];
      if (!u || u.status !== 'active') throw E.unauthenticated('Account is inactive');
      const branchId = await this.bindBranch(tx, s.shopId, s.userId, input.terminalId);
      if (input.oldRefreshToken) {
        await tx.query(`UPDATE refresh_token SET revoked_at=now() WHERE shop_id=$1 AND user_id=$2 AND token_hash=$3 AND revoked_at IS NULL`, [s.shopId, s.userId, TokenService.hashOpaque(input.oldRefreshToken)]);
      }
      const refresh = await this.newRefresh(tx, { shopId: s.shopId, userId: s.userId, terminalId: input.terminalId, branchId });
      await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'auth.select_terminal', terminalId: input.terminalId });
      return {
        accessToken: this.accessToken({ userId: s.userId, shopId: s.shopId, branchId, terminalId: input.terminalId }),
        refreshToken: refresh,
        expiresIn: config().accessTtlSec,
        user: { id: u.id, name: u.name },
        session: { shopId: s.shopId, branchId, terminalId: input.terminalId },
        mustChangePassword: u.must_change_password,
      };
    });
  }

  /** Fast cashier switch on a registered terminal. Requires an existing terminal session. */
  async switchUserByPin(s: { shopId: string; terminalId?: string }, input: { userId: string; pin: string }): Promise<AuthResult> {
    if (!s.terminalId) throw E.forbidden('PIN switch is only available on a registered terminal');
    this.pinLimiter.check(`${s.terminalId}:${input.userId}`);
    return this.db.tenant({ shopId: s.shopId, userId: input.userId }, async (tx) => {
      const t = (await tx.query(`SELECT branch_id, status FROM terminal WHERE shop_id=$1 AND id=$2`, [s.shopId, s.terminalId])).rows[0];
      if (!t || t.status !== 'active') throw E.forbidden('Terminal is not active');
      const u = (await tx.query(`SELECT id, name, pin_hash, status FROM users WHERE shop_id=$1 AND id=$2`, [s.shopId, input.userId])).rows[0];
      if (!u || u.status !== 'active' || !u.pin_hash || !(await verifySecret(u.pin_hash, input.pin))) throw E.unauthenticated('Invalid user or PIN');
      const { features } = await this.features.resolve(tx, s.shopId);
      const acc = await this.access.load(tx, u.id, t.branch_id, features);
      if (acc.permissions.size === 0) throw E.forbidden('User has no role in this branch');
      this.pinLimiter.reset(`${s.terminalId}:${input.userId}`);
      await this.audit.record(tx, { shopId: s.shopId, actorId: u.id, action: 'auth.pin_switch', terminalId: s.terminalId });
      return {
        accessToken: this.accessToken({ userId: u.id, shopId: s.shopId, branchId: t.branch_id, terminalId: s.terminalId }, PIN_SESSION_TTL),
        expiresIn: PIN_SESSION_TTL,
        user: { id: u.id, name: u.name },
        session: { shopId: s.shopId, branchId: t.branch_id, terminalId: s.terminalId },
        mustChangePassword: false,
      };
    });
  }

  async changePassword(tx: Tx, s: { shopId: string; userId: string }, oldPassword: string, newPassword: string) {
    if (newPassword.length < 8) throw E.validation('Password must be at least 8 characters');
    const u = (await tx.query(`SELECT password_hash FROM users WHERE shop_id=$1 AND id=$2`, [s.shopId, s.userId])).rows[0];
    if (!u || !(await verifySecret(u.password_hash, oldPassword))) throw E.unauthenticated('Current password is incorrect');
    await tx.query(`UPDATE users SET password_hash=$3, must_change_password=false, version=version+1 WHERE shop_id=$1 AND id=$2`, [s.shopId, s.userId, await hashSecret(newPassword)]);
    await tx.query(`UPDATE refresh_token SET revoked_at=now() WHERE shop_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [s.shopId, s.userId]);
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'auth.password_changed', entity: 'user', entityId: s.userId });
  }

  // ---------- platform admins ----------
  async adminLogin(input: { email: string; password: string; ip?: string }) {
    const email = input.email.trim().toLowerCase();
    this.loginLimiter.check(`admin:${input.ip ?? '-'}:${email}`);
    const a = (await this.db.query(`SELECT id, name, password_hash, status FROM platform_admin WHERE lower(email)=$1`, [email]))[0];
    if (!a || a.status !== 'active' || !(await verifySecret(a.password_hash, input.password))) throw E.unauthenticated('Invalid email or password');
    return {
      accessToken: this.tokens.sign({ typ: 'access', aid: a.id, plat: true }, config().accessTtlSec),
      expiresIn: config().accessTtlSec,
      admin: { id: a.id as string, name: a.name as string },
    };
  }

  async createPlatformAdmin(email: string, name: string, password: string) {
    const hashed = await hashSecret(password);
    const r = await this.db.admin((tx) =>
      tx.query(`INSERT INTO platform_admin(email, name, password_hash) VALUES (lower($1),$2,$3) RETURNING id`, [email, name, hashed]),
    );
    return r.rows[0].id as string;
  }
}

export { hashSecret };
