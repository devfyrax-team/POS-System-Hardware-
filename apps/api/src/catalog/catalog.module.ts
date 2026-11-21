import { Module } from '@nestjs/common';
import { BarcodeService } from './barcode.service';
import { MasterController, ProductsController } from './catalog.controllers';
import { LabelService } from './label.service';
import { MasterCatalogService } from './master.service';
import { PricingService } from './pricing.service';
import { ProductService } from './product.service';
import { ProductSearchService } from './search.service';
import { UnitService } from './unit.service';
import { VariantGenerator } from './variant.generator';

const services = [ProductService, PricingService, UnitService, BarcodeService, ProductSearchService, MasterCatalogService, LabelService, VariantGenerator];

@Module({ controllers: [MasterController, ProductsController], providers: services, exports: services })
export class CatalogModule {}
