import { Module, OnModuleInit } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { IdentityModule } from '../identity/identity.module';
import { Db } from '../db/db';
import { JobQueue } from '../jobs/job-queue';
import { CheckoutHooks } from './checkout.hooks';
import { CheckoutService } from './checkout.service';
import { DeliveryNoteService, HeldBillService, QuotationService } from './held-quote.service';
import { InvoiceNumberService } from './invoice-number.service';
import { ReceiptService } from './receipt.service';
import { SaleQueryService } from './sale-query.service';
import { DeliveryNoteController, QuotationController, SalesController } from './sales.controllers';
import { VoidReturnService } from './void-return.service';

const services = [CheckoutHooks, InvoiceNumberService, CheckoutService, SaleQueryService, VoidReturnService, ReceiptService, HeldBillService, QuotationService, DeliveryNoteService];

@Module({
  imports: [CatalogModule, InventoryModule, IdentityModule],
  controllers: [SalesController, QuotationController, DeliveryNoteController],
  providers: services,
  exports: services,
})
export class SalesModule implements OnModuleInit {
  constructor(private readonly jobs: JobQueue, private readonly quotes: QuotationService) {}

  onModuleInit() {
    this.jobs.register('quotation.expire', async (_j, db: Db) => {
      const shops = await db.platform(async (tx) => (await tx.query(`SELECT id FROM shop WHERE status='active'`)).rows);
      for (const sh of shops) await db.platform((tx) => this.quotes.expireOld(tx, sh.id), sh.id);
    });
  }
}
