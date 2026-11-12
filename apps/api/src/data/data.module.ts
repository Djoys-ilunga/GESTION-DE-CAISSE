import { BccAuthorizationRequiredConnector } from '../exchange/bcc.authorization';
import { BccRepository } from '../exchange/bcc.repository';
import { BccRefreshCoordinator } from '../exchange/bcc.refresh';
import { BccExchangeRateProvider, BCC_CONNECTOR } from '../exchange/bcc.provider';
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
  BccRepository,
  BccRefreshCoordinator,
  BccExchangeRateProvider,
  BccAuthorizationRequiredConnector,
  { provide: BCC_CONNECTOR, useExisting: BccAuthorizationRequiredConnector },
];
@Module({ providers, exports: providers })
export class DataModule {}
