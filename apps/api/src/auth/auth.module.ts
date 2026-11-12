import { ExchangeRatesService } from '../exchange/exchange.service';
import { ExchangeRatesController } from '../exchange/exchange.controller';
import { MoneyService } from '../money/money.service';
import { MoneyController } from '../money/money.controller';
import { ReportsController } from '../reports/reports.controller';
import { ManagementController } from '../management/management.controller';
import { ManagementService } from '../management/management.service';
import { ReportsService } from '../reports/reports.service';
import { TransfersService } from '../transfers/transfers.service';
import { TransfersController } from '../transfers/transfers.controller';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DataModule } from '../data/data.module';
import { AuthStore } from './auth-store';
import { PasswordService } from './password.service';
import { AuthService } from './auth.service';
import { AdminService } from './admin.service';
import { AuthGuard } from './auth.guard';
import { AuthController, AdminController } from './auth.controller';
import { WorkspaceController } from './workspace.controller';
import { CashController } from '../cash/cash.controller';
import { ExpensesController } from '../expenses/expenses.controller';
import { ExpensesService } from '../expenses/expenses.service';
import { CashService } from '../cash/cash.service';
@Module({
  imports: [DataModule],
  controllers: [
    AuthController,
    AdminController,
    WorkspaceController,
    CashController,
    ExpensesController,
    TransfersController,
    ReportsController,
    ManagementController,
    MoneyController,
    ExchangeRatesController,
  ],
  providers: [
    AuthStore,
    PasswordService,
    AuthService,
    AdminService,
    CashService,
    ExpensesService,
    TransfersService,
    ReportsService,
    ManagementService,
    MoneyService,
    ExchangeRatesService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, AuthStore, AdminService, PasswordService],
})
export class AuthModule {}
