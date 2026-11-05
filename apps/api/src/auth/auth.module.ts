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
  ],
  providers: [
    AuthStore,
    PasswordService,
    AuthService,
    AdminService,
    CashService,
    ExpensesService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, AuthStore, AdminService, PasswordService],
})
export class AuthModule {}
