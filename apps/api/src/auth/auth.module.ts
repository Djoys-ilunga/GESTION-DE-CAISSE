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
@Module({
  imports: [DataModule],
  controllers: [AuthController, AdminController, WorkspaceController],
  providers: [
    AuthStore,
    PasswordService,
    AuthService,
    AdminService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, AuthStore, AdminService, PasswordService],
})
export class AuthModule {}
