import { Injectable } from '@nestjs/common';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { RateLimiter } from '../common/rate-limiter';
import { AuditService } from '../audit/audit.service';
import { TokenService } from '../auth/token.service';
import { verifySecret } from '../auth/password';
import { FeatureService } from '../platform/feature.service';
import { AccessService } from './access.service';
import { TenantSession } from '../common/session';

export interface ApprovalClaims {
  typ: 'approval';
  shop: string;
  action: string;
  entityId?: string;
  terminal?: string;
  cashier: string;
  approver: string;
}

/** Supervisor override at the till: a PIN lets a cashier complete a restricted action once. Both users are logged. */
@Injectable()
export class ApprovalService {
  private limiter = new RateLimiter(5, 5 * 60_000);

  constructor(
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly features: FeatureService,
    private readonly access: AccessService,
  ) {}

  async requestOverride(tx: Tx, s: TenantSession, input: { action: string; entityId?: string; approverUserId?: string; approverEmail?: string; pin: string }) {
    // the supervisor may be named by id or, at the till, by email
    const who = input.approverUserId ?? `email:${(input.approverEmail ?? '').toLowerCase()}`;
    this.limiter.check(`${s.shopId}:${who}`);
    const u = (
      await tx.query(`SELECT id, pin_hash, status FROM users WHERE shop_id=$1 AND (($2::uuid IS NOT NULL AND id=$2) OR ($2::uuid IS NULL AND lower(email)=lower($3)))`, [s.shopId, input.approverUserId ?? null, input.approverEmail ?? ''])
    ).rows[0];
    if (!u || u.status !== 'active' || !u.pin_hash || !(await verifySecret(u.pin_hash, input.pin))) throw E.forbidden('Invalid approver or PIN');
    const { features } = await this.features.resolve(tx, s.shopId);
    const acc = await this.access.load(tx, u.id, s.branchId, features);
    if (!acc.permissions.has('approval.grant')) throw E.forbidden('This user cannot approve restricted actions');
    this.limiter.reset(`${s.shopId}:${who}`);

    const claims: Omit<ApprovalClaims, 'exp'> = {
      typ: 'approval', shop: s.shopId, action: input.action, entityId: input.entityId,
      terminal: s.terminalId, cashier: s.userId, approver: u.id,
    };
    const token = this.tokens.sign(claims as any, 120);
    await this.audit.record(tx, {
      shopId: s.shopId, actorId: s.userId, approverId: u.id, terminalId: s.terminalId ?? null,
      action: 'approval.granted', entity: input.action, entityId: input.entityId, new: { action: input.action },
    });
    return { token, approverId: u.id as string, expiresInSec: 120 };
  }

  /** Called by the function that needs approval (void, refund, large discount). Returns the approver id. */
  verify(token: string | undefined, s: TenantSession, expect: { action: string; entityId?: string }): string {
    const c = this.tokens.verify<ApprovalClaims>(token);
    if (
      !c || c.typ !== 'approval' || c.shop !== s.shopId || c.action !== expect.action ||
      c.cashier !== s.userId || (c.terminal && c.terminal !== s.terminalId) ||
      (expect.entityId !== undefined && c.entityId !== expect.entityId)
    ) {
      throw E.approvalRequired(expect.action);
    }
    return c.approver;
  }
}
