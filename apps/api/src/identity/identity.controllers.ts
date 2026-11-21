import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { CurrentTenant, TenantSession } from '../common/session';
import { parse, z } from '../common/validate';
import { Db } from '../db/db';
import { AuditService } from '../audit/audit.service';
import { RequirePermission } from '../auth/decorators';
import { BranchService } from './branch.service';
import { TerminalService } from './terminal.service';
import { RoleService } from './role.service';
import { UserAdminService } from './user-admin.service';
import { ShopService } from './shop.service';
import { ApprovalService } from './approval.service';

const ctx = (s: TenantSession) => ({ shopId: s.shopId, userId: s.userId });

@Controller('shop')
export class ShopController {
  constructor(private readonly db: Db, private readonly shop: ShopService) {}

  @Get('settings')
  @RequirePermission('shop.settings')
  get(@CurrentTenant() s: TenantSession) {
    return this.db.tenant(ctx(s), (tx) => this.shop.get(tx, s.shopId));
  }

  @Patch('settings')
  @RequirePermission('shop.settings')
  update(@CurrentTenant() s: TenantSession, @Body() body: any) {
    const { name, ...settings } = body ?? {};
    return this.db.tenant(ctx(s), (tx) => this.shop.updateSettings(tx, s, settings, typeof name === 'string' ? name : undefined));
  }
}

@Controller('branches')
export class BranchesController {
  constructor(private readonly db: Db, private readonly branches: BranchService) {}

  @Get()
  list(@CurrentTenant() s: TenantSession) {
    return this.db.tenant(ctx(s), (tx) => this.branches.list(tx, s.shopId));
  }

  @Post()
  @RequirePermission('branch.manage')
  create(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ name: z.string().min(1).max(100), code: z.string().max(20).optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.branches.create(tx, s, b));
  }

  @Patch(':id')
  @RequirePermission('branch.manage')
  update(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ name: z.string().min(1).max(100).optional(), code: z.string().max(20).optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.branches.update(tx, s, id, b));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('branch.manage')
  async deactivate(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    await this.db.tenant(ctx(s), (tx) => this.branches.deactivate(tx, s, id));
  }
}

@Controller('terminals')
export class TerminalsController {
  constructor(private readonly db: Db, private readonly terminals: TerminalService) {}

  @Get()
  list(@CurrentTenant() s: TenantSession, @Query('branchId') branchId?: string) {
    return this.db.tenant(ctx(s), (tx) => this.terminals.list(tx, s.shopId, branchId));
  }

  @Post()
  @RequirePermission('terminal.manage')
  register(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ branchId: z.string().uuid(), name: z.string().min(1).max(60), prefix: z.string().min(2).max(16) }), body);
    return this.db.tenant(ctx(s), (tx) => this.terminals.register(tx, s, b));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('terminal.manage')
  async deactivate(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    await this.db.tenant(ctx(s), (tx) => this.terminals.deactivate(tx, s, id));
  }
}

@Controller('roles')
export class RolesController {
  constructor(private readonly db: Db, private readonly roles: RoleService) {}

  @Get()
  @RequirePermission('user.manage')
  list(@CurrentTenant() s: TenantSession) {
    return this.db.tenant(ctx(s), (tx) => this.roles.list(tx, s.shopId));
  }

  @Post()
  @RequirePermission('role.manage')
  create(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ name: z.string().min(1).max(60), permissions: z.array(z.string()), approvalLimits: z.record(z.string(), z.unknown()).optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.roles.create(tx, s, b));
  }

  @Post(':id/clone')
  @RequirePermission('role.manage')
  clone(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ name: z.string().min(1).max(60) }), body);
    return this.db.tenant(ctx(s), (tx) => this.roles.clone(tx, s, id, b.name));
  }

  @Patch(':id')
  @RequirePermission('role.manage')
  update(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ name: z.string().optional(), permissions: z.array(z.string()).optional(), approvalLimits: z.record(z.string(), z.unknown()).optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.roles.update(tx, s, id, b));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('role.manage')
  async remove(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    await this.db.tenant(ctx(s), (tx) => this.roles.remove(tx, s, id));
  }
}

@Controller('users')
export class UsersController {
  constructor(private readonly db: Db, private readonly users: UserAdminService) {}

  @Get()
  @RequirePermission('user.manage')
  list(@CurrentTenant() s: TenantSession) {
    return this.db.tenant(ctx(s), (tx) => this.users.list(tx, s.shopId));
  }

  @Post()
  @RequirePermission('user.manage')
  invite(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(
      z.object({ email: z.string().email(), name: z.string().min(1), roleId: z.string().uuid(), branchId: z.string().uuid().nullable(), password: z.string().min(8).optional() }),
      body,
    );
    return this.db.tenant(ctx(s), (tx) => this.users.invite(tx, s, b));
  }

  @Put(':id/branch-roles')
  @HttpCode(204)
  @RequirePermission('user.manage')
  async assign(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ branchId: z.string().uuid().nullable(), roleId: z.string().uuid() }), body);
    await this.db.tenant(ctx(s), (tx) => this.users.assignBranchRole(tx, s, id, b.branchId, b.roleId));
  }

  @Delete(':id/branch-roles')
  @HttpCode(204)
  @RequirePermission('user.manage')
  async unassign(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ branchId: z.string().uuid().nullable(), roleId: z.string().uuid() }), body);
    await this.db.tenant(ctx(s), (tx) => this.users.removeBranchRole(tx, s, id, b.branchId, b.roleId));
  }

  @Post(':id/deactivate')
  @HttpCode(204)
  @RequirePermission('user.manage')
  async deactivate(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    await this.db.tenant(ctx(s), (tx) => this.users.deactivate(tx, s, id));
  }

  @Post(':id/reactivate')
  @HttpCode(204)
  @RequirePermission('user.manage')
  async reactivate(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    await this.db.tenant(ctx(s), (tx) => this.users.reactivate(tx, s, id));
  }

  @Post(':id/reset-password')
  @RequirePermission('user.manage')
  reset(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.users.resetPassword(tx, s, id));
  }

  @Put(':id/pin')
  @HttpCode(204)
  async setPin(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ pin: z.string() }), body);
    await this.db.tenant(ctx(s), (tx) => this.users.setPin(tx, s, id, b.pin));
  }
}

@Controller()
export class AuditAndApprovalController {
  constructor(private readonly db: Db, private readonly audit: AuditService, private readonly approvals: ApprovalService) {}

  @Get('audit-log')
  @RequirePermission('shop.settings')
  auditLog(@CurrentTenant() s: TenantSession, @Query() q: any) {
    return this.db.tenant(ctx(s), (tx) => this.audit.query(tx, { action: q.action, entity: q.entity, actorId: q.actorId, from: q.from, to: q.to, limit: q.limit ? Number(q.limit) : undefined, beforeId: q.beforeId ? Number(q.beforeId) : undefined }));
  }

  @Post('approvals')
  @HttpCode(200)
  override(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ action: z.string().min(1), entityId: z.string().optional(), approverUserId: z.string().uuid().optional(), approverEmail: z.string().email().optional(), pin: z.string() }).refine((v) => v.approverUserId || v.approverEmail, 'approverUserId or approverEmail is required'), body);
    return this.db.tenant(ctx(s), (tx) => this.approvals.requestOverride(tx, s, b));
  }
}
