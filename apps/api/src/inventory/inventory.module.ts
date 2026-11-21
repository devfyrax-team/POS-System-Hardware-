import { Module, OnModuleInit } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ProductService } from '../catalog/product.service';
import { Db } from '../db/db';
import { JobQueue } from '../jobs/job-queue';
import { OutboxService } from '../jobs/outbox.service';
import { AdjustmentService } from './adjustment.service';
import { CostingService } from './costing.service';
import { InventoryController } from './inventory.controllers';
import { LowStockService } from './lowstock.service';
import { NotificationService } from './notification.service';
import { ReconciliationService } from './reconciliation.service';
import { StockService } from './stock.service';
import { StocktakeService } from './stocktake.service';

const services = [CostingService, LowStockService, StockService, NotificationService, AdjustmentService, StocktakeService, ReconciliationService];

@Module({ imports: [CatalogModule], controllers: [InventoryController], providers: services, exports: services })
export class InventoryModule implements OnModuleInit {
  constructor(
    private readonly outbox: OutboxService,
    private readonly jobs: JobQueue,
    private readonly notifications: NotificationService,
    private readonly low: LowStockService,
    private readonly recon: ReconciliationService,
    private readonly products: ProductService,
  ) {}

  onModuleInit() {
    // Low-stock event -> in-app notification to everyone who holds lowstock.receive_alerts at that branch.
    this.outbox.on('stock.low', async (e, db: Db) => {
      await db.platform(async (tx) => {
        const p = (await tx.query(`SELECT name, base_unit FROM product WHERE shop_id=$1 AND id=$2`, [e.shop_id, e.payload.productId])).rows[0];
        const users = await this.notifications.recipientsWithPermission(tx, e.shop_id!, e.payload.branchId, 'lowstock.receive_alerts');
        const out = e.payload.state === 'out';
        await this.notifications.notify(tx, {
          shopId: e.shop_id!, userIds: users, branchId: e.payload.branchId, type: out ? 'stock.out' : 'stock.low',
          title: out ? `Out of stock: ${p?.name}` : `Low stock: ${p?.name}`,
          body: `${e.payload.quantity} ${p?.base_unit ?? ''} left (minimum ${e.payload.minLevel})`, payload: e.payload,
        });
      }, e.shop_id!);
    });

    // Daily safety nets, enqueued by the worker scheduler.
    const forEachShop = async (db: Db, fn: (tx: any, shopId: string) => Promise<unknown>) => {
      const shops = await db.platform(async (tx) => (await tx.query(`SELECT id FROM shop WHERE status='active'`)).rows);
      for (const sh of shops) await db.platform((tx) => fn(tx, sh.id), sh.id);
    };
    this.jobs.register('lowstock.check', (_j, db) => forEachShop(db, (tx, id) => this.low.dailyCheck(tx, id)) as Promise<void>);
    this.jobs.register('stock.reconcile', (_j, db) => forEachShop(db, (tx, id) => this.recon.run(tx, id)) as Promise<void>);
  }
}
