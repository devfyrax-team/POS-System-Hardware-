import { Module } from '@nestjs/common';
import { AuthController } from '../auth/auth.controller';
import { AdminController } from '../platform/admin.controller';
import { ApprovalService } from './approval.service';
import { BranchService } from './branch.service';
import { RoleService } from './role.service';
import { ShopService } from './shop.service';
import { TerminalService } from './terminal.service';
import { UserAdminService } from './user-admin.service';
import {
  AuditAndApprovalController, BranchesController, RolesController, ShopController, TerminalsController, UsersController,
} from './identity.controllers';

const services = [BranchService, TerminalService, RoleService, UserAdminService, ShopService, ApprovalService];

@Module({
  controllers: [AuthController, AdminController, ShopController, BranchesController, TerminalsController, RolesController, UsersController, AuditAndApprovalController],
  providers: services,
  exports: services,
})
export class IdentityModule {}
