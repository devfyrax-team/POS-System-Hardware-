import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthGuard, FeatureGuard, PermissionGuard, TenantContextGuard } from './auth/guards';
import { AllExceptionsFilter } from './common/exception.filter';
import { CoreModule } from './core.module';
import { HealthController } from './health.controller';
import { IdentityModule } from './identity/identity.module';
import { CatalogModule } from './catalog/catalog.module';
import { InventoryModule } from './inventory/inventory.module';
import { ImportModule } from './import/import.module';

@Module({
  imports: [CoreModule, IdentityModule, CatalogModule, InventoryModule, ImportModule],
  controllers: [HealthController],
  providers: [
    // Guard chain, in order: Auth -> Tenant/Subscription -> Feature -> Permission.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: TenantContextGuard },
    { provide: APP_GUARD, useClass: FeatureGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
