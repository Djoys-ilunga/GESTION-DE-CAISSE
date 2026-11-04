import {
  Injectable,
  Inject,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService, type Principal } from './auth.service';
export const Public = () => SetMetadata('auth:public', true);
export const SessionAccess = (options: { locked?: boolean; passwordChange?: boolean }) =>
  SetMetadata('auth:access', options);
export const Permission = (permission: string) => SetMetadata('auth:permission', permission);
export type AuthRequest = {
  headers: { authorization?: string; 'x-caissepro-device'?: string };
  ip?: string;
  principal: Principal;
};
export function bearer(request: { headers: { authorization?: string } }) {
  const value = request.headers.authorization;
  if (!value || !/^Bearer [A-Za-z0-9_-]{43}$/.test(value))
    throw new UnauthorizedException('Session requise.');
  return value.slice(7);
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>('auth:public', targets)) return true;
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const options =
      this.reflector.getAllAndOverride<{ locked?: boolean; passwordChange?: boolean }>(
        'auth:access',
        targets,
      ) ?? {};
    const principal = await this.auth.authenticate(
      bearer(request),
      options.locked,
      options.passwordChange,
    );
    if (request.headers['x-caissepro-device'] !== principal.deviceId)
      throw new UnauthorizedException('Session indisponible pour cet appareil.');
    const permission = this.reflector.getAllAndOverride<string>('auth:permission', targets);
    if (permission && !principal.profile.permissions.includes(permission))
      throw new ForbiddenException('Autorisation insuffisante.');
    request.principal = principal;
    return true;
  }
}
