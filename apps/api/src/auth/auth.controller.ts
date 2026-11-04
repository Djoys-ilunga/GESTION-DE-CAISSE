import { Controller, Post, Get, Put, Body, Req, Param, Inject, Header } from '@nestjs/common';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { AdminService } from './admin.service';
import { Public, SessionAccess, Permission, bearer, type AuthRequest } from './auth.guard';
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @Public() @Post('login') @Header('Cache-Control', 'no-store') login(
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ) {
    return this.auth.login(body, req.ip ?? 'unknown');
  }
  @SessionAccess({ locked: true, passwordChange: true })
  @Get('session')
  @Header('Cache-Control', 'no-store')
  session(@Req() req: AuthRequest) {
    return req.principal.profile;
  }
  @Public() @Post('logout') @Header('Cache-Control', 'no-store') logout(@Req() req: AuthRequest) {
    return this.auth.logout(bearer(req));
  }
  @SessionAccess({ locked: true, passwordChange: true }) @Post('lock') lock(
    @Req() req: AuthRequest,
  ) {
    return this.auth.lock(req.principal);
  }
  @SessionAccess({ locked: true, passwordChange: true })
  @Post('unlock')
  @Header('Cache-Control', 'no-store')
  unlock(@Req() req: AuthRequest, @Body() body: unknown) {
    const input = z
      .object({ password: z.string().min(1).max(128) })
      .strict()
      .parse(body);
    return this.auth.unlock(req.principal, input.password, req.ip ?? 'unknown');
  }
  @Post('activity') activity(@Req() req: AuthRequest) {
    return this.auth.activity(req.principal);
  }
  @SessionAccess({ passwordChange: true }) @Post('password') password(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        currentPassword: z.string().min(1).max(128),
        newPassword: z.string().min(12).max(128),
      })
      .strict()
      .parse(body);
    return this.auth.changePassword(req.principal, input.currentPassword, input.newPassword);
  }
}
@Controller('admin')
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}
  @Permission('users:manage') @Get('access') access(@Req() req: AuthRequest) {
    return this.admin.accessCatalog(req.principal);
  }
  @Permission('users:manage') @Get('users') users(@Req() req: AuthRequest) {
    return this.admin.users(req.principal);
  }
  @Permission('users:manage') @Post('users') create(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    return this.admin.create(req.principal, body);
  }
  @Permission('roles:assign') @Put('users/:userId/access') update(
    @Req() req: AuthRequest,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    const input = z
      .object({ access: z.unknown(), expectedVersion: z.number().int().positive() })
      .strict()
      .parse(body);
    return this.admin.updateAccess(
      req.principal,
      z.uuid().parse(userId),
      input.access,
      input.expectedVersion,
    );
  }
  @Permission('auth:logs:read') @Get('logs') logs(@Req() req: AuthRequest) {
    return this.admin.logs(req.principal);
  }
}
