import { Global, Module, OnModuleInit } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { AuthService } from './auth/auth.service';
import { TokenService } from './auth/token.service';
import { IdempotencyService } from './common/idempotency.service';
import { Db } from './db/db';
import { AccessService } from './identity/access.service';
import { JobQueue } from './jobs/job-queue';
import { OutboxService } from './jobs/outbox.service';
import { AdminFeatureService } from './platform/admin-feature.service';
import { FeatureService } from './platform/feature.service';
import { LimitService } from './platform/limit.service';
import { ShopProvisioningService } from './platform/provisioning.service';
import { SubscriptionService } from './platform/subscription.service';

const providers = [
  Db, TokenService, AuditService, IdempotencyService, FeatureService, LimitService, AccessService,
  SubscriptionService, AdminFeatureService, ShopProvisioningService, AuthService, JobQueue, OutboxService,
];

/** Shared infrastructure every module can use. */
@Global()
@Module({ providers, exports: providers })
export class CoreModule implements OnModuleInit {
  constructor(private readonly jobs: JobQueue, private readonly outbox: OutboxService, private readonly adminFeatures: AdminFeatureService) {}

  onModuleInit() {
    this.jobs.register('outbox.dispatch', async () => {
      await this.outbox.dispatch();
    });
    this.jobs.register('feature.expire_overrides', async (_j, db) => {
      await db.platform((tx) => this.adminFeatures.expireOverrides(tx));
    });
  }
}
