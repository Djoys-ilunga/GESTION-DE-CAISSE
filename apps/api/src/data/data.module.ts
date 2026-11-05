import { SynchronizationService } from './synchronization.service';
import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CentralAccess } from './central-access';
import { LedgerService } from './ledger.service';
import { DraftInboxService } from './draft-inbox.service';
import { CatalogService } from './catalog.service';
const providers = [
  SynchronizationService,
  PrismaService,
  CentralAccess,
  LedgerService,
  DraftInboxService,
  CatalogService,
];
@Module({ providers, exports: providers })
export class DataModule {}
