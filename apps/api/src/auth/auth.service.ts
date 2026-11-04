import {
  Inject,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  loginSchema,
  newPasswordSchema,
  sessionProfileSchema,
  type SessionProfile,
} from '@caissepro/shared';
import { Prisma } from '../generated/prisma/client';
import { AuthStore, type AuthTx } from './auth-store';
import { PasswordService } from './password.service';
export const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000,
  SESSION_IDLE_MS = 15 * 60 * 1000,
  OFFLINE_MS = 15 * 60 * 1000;
const includeMember = {
  user: true,
  company: true,
  roles: { include: { role: { include: { permissions: true } } } },
  agencies: { include: { agency: true } },
  cashGrants: { include: { register: true } },
} satisfies Prisma.CompanyMemberInclude;
type Member = Prisma.CompanyMemberGetPayload<{ include: typeof includeMember }>;
export type Principal = {
  companyId: string;
  userId: string;
  memberId: string;
  sessionId: string;
  deviceId: string;
  tokenHash: string;
  profile: SessionProfile;
};
export function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
@Injectable()
export class AuthService {
  private readonly throttleSecret: string;
  constructor(
    @Inject(AuthStore) readonly store: AuthStore,
    @Inject(PasswordService) readonly passwords: PasswordService,
  ) {
    const secret = process.env.AUTH_RATE_LIMIT_SECRET;
    if (!secret || !/^[a-f0-9]{64}$/.test(secret))
      throw new Error('Configuration de sécurité API manquante. Exécuter pnpm setup:env.');
    this.throttleSecret = secret;
  }
  async event(
    tx: AuthTx,
    code: string,
    values: {
      companyId?: string;
      actorId?: string;
      subjectId?: string;
      sessionId?: string;
      deviceId?: string;
    } = {},
  ) {
    await tx.authEvent.create({ data: { id: randomUUID(), code, ...values } });
  }
  private async attempt(key: string, limit: number) {
    return this.store.run(async (tx) => {
      const now = new Date();
      await tx.authThrottle.upsert({
        where: { key },
        create: { key, windowStartedAt: now },
        update: {},
      });
      await tx.$executeRaw`SELECT key FROM "AuthThrottle" WHERE key=${key} FOR UPDATE`;
      const row = await tx.authThrottle.findUniqueOrThrow({ where: { key } });
      if (row.blockedUntil && row.blockedUntil > now) return false;
      const fresh = now.getTime() - row.windowStartedAt.getTime() >= SESSION_IDLE_MS;
      const failures = (fresh ? 0 : row.failures) + 1;
      await tx.authThrottle.update({
        where: { key },
        data: {
          failures,
          windowStartedAt: fresh ? now : row.windowStartedAt,
          blockedUntil: failures > limit ? new Date(now.getTime() + SESSION_IDLE_MS) : null,
        },
      });
      return failures <= limit;
    });
  }
  private key(value: string) {
    return createHmac('sha256', this.throttleSecret).update(value).digest('hex');
  }
  async login(value: unknown, ip: string) {
    const input = loginSchema.parse(value),
      identityKey = this.key(`identity:${input.companyCode}:${input.email}`);
    if (!(await this.attempt(this.key(`ip:${ip}`), 120)) || !(await this.attempt(identityKey, 5))) {
      await this.store.run((tx) => this.event(tx, 'LOGIN_THROTTLED', { deviceId: input.deviceId }));
      throw new HttpException('Connexion temporairement limitée. Réessayez plus tard.', 429);
    }
    const candidate = await this.store.run((tx) =>
      tx.user.findUnique({
        where: { email: input.email },
        include: {
          credential: true,
          members: { where: { company: { code: input.companyCode } }, include: { company: true } },
        },
      }),
    );
    const correct = await this.passwords.verify(
      input.password,
      candidate?.credential?.passwordHash ?? null,
    );
    const member = candidate?.members[0];
    if (!correct || !candidate?.active || !member?.active || !member.company.active) {
      await this.store.run((tx) =>
        this.event(tx, 'LOGIN_FAILED', {
          companyId: member?.companyId,
          subjectId: member ? candidate?.id : undefined,
          deviceId: input.deviceId,
        }),
      );
      throw new UnauthorizedException('Identifiants ou accès non valides.');
    }
    const token = randomBytes(32).toString('base64url');
    const result = await this.store.run(async (tx) => {
      const current = await tx.companyMember.findUnique({
        where: { id: member.id },
        include: includeMember,
      });
      const credential = await tx.userCredential.findUnique({ where: { userId: candidate.id } });
      if (
        !current?.active ||
        !current.user.active ||
        !current.company.active ||
        credential?.passwordHash !== candidate.credential?.passwordHash
      )
        return null;
      const now = new Date(),
        id = randomUUID();
      // Une seule session ouverte pour ce compte, cette entreprise et cet appareil.
      await tx.authSession.updateMany({
        where: {
          companyId: current.companyId,
          userId: candidate.id,
          deviceId: input.deviceId,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      const session = await tx.authSession.create({
        data: {
          id,
          companyId: current.companyId,
          memberId: current.id,
          userId: candidate.id,
          deviceId: input.deviceId,
          tokenHash: tokenHash(token),
          userVersion: current.user.securityVersion,
          memberVersion: current.authorizationVersion,
          createdAt: now,
          lastSeenAt: now,
          expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
          idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_MS),
        },
      });
      await tx.authThrottle.update({
        where: { key: identityKey },
        data: { failures: 0, blockedUntil: null },
      });
      await this.event(tx, 'LOGIN_SUCCESS', {
        companyId: current.companyId,
        actorId: candidate.id,
        subjectId: candidate.id,
        sessionId: id,
        deviceId: input.deviceId,
      });
      return this.profile(current, session, now);
    });
    if (!result) throw new UnauthorizedException('Identifiants ou accès non valides.');
    return { accessToken: token, profile: result };
  }
  private profile(
    member: Member,
    session: {
      id: string;
      deviceId: string;
      expiresAt: Date;
      idleExpiresAt: Date;
      lockedAt: Date | null;
    },
    now = new Date(),
  ): SessionProfile {
    const roles = member.roles.filter((r) => r.role.active),
      permissions = [
        ...new Set(roles.flatMap((r) => r.role.permissions.map((p) => p.permissionCode))),
      ].sort();
    const agencies = member.agencies
      .filter((g) => g.agency.active)
      .map((g) => ({ id: g.agency.id, code: g.agency.code, name: g.agency.name }));
    const allowed = new Set(agencies.map((a) => a.id));
    const cashRegisters = member.cashGrants
      .filter((g) => g.register.active && allowed.has(g.agencyId))
      .map((g) => ({
        id: g.register.id,
        agencyId: g.agencyId,
        code: g.register.code,
        name: g.register.name,
      }));
    return sessionProfileSchema.parse({
      sessionId: session.id,
      deviceId: session.deviceId,
      user: {
        id: member.userId,
        displayName: member.user.displayName,
        email: member.user.email,
        mustChangePassword: member.user.mustChangePassword,
      },
      company: { id: member.companyId, code: member.company.code, name: member.company.name },
      roles: roles.map((r) => r.role.code),
      permissions,
      agencies,
      cashRegisters,
      expiresAt: session.expiresAt.toISOString(),
      idleExpiresAt: session.idleExpiresAt.toISOString(),
      offlineUntil:
        permissions.includes('offline:access') &&
        !member.user.mustChangePassword &&
        !session.lockedAt
          ? new Date(
              Math.min(
                now.getTime() + OFFLINE_MS,
                session.expiresAt.getTime(),
                session.idleExpiresAt.getTime(),
              ),
            ).toISOString()
          : null,
      validatedAt: now.toISOString(),
      locked: session.lockedAt !== null,
      authorizationVersion: member.authorizationVersion,
    });
  }
  async resolve(tx: AuthTx, hash: string) {
    const session = await tx.authSession.findUnique({ where: { tokenHash: hash } });
    if (!session || session.revokedAt) return null;
    const member = await tx.companyMember.findUnique({
      where: { id: session.memberId },
      include: includeMember,
    });
    const expired = session.expiresAt <= new Date() || session.idleExpiresAt <= new Date();
    if (
      expired ||
      !member?.active ||
      !member.user.active ||
      !member.company.active ||
      session.userVersion !== member.user.securityVersion ||
      session.memberVersion !== member.authorizationVersion
    ) {
      await tx.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      await this.event(tx, expired ? 'SESSION_EXPIRED' : 'SESSION_REVOKED', {
        companyId: session.companyId,
        subjectId: session.userId,
        sessionId: session.id,
        deviceId: session.deviceId,
      });
      return null;
    }
    return { session, member };
  }
  async authenticate(
    token: string,
    allowLocked = false,
    allowPasswordChange = false,
  ): Promise<Principal> {
    const result = await this.store.run((tx) => this.resolve(tx, tokenHash(token)));
    if (!result) throw new UnauthorizedException('Session expirée ou accès révoqué.');
    if (result.session.lockedAt && !allowLocked)
      throw new HttpException('Session verrouillée.', 423);
    if (result.member.user.mustChangePassword && !allowPasswordChange)
      throw new ForbiddenException('Le mot de passe doit être renouvelé.');
    return {
      companyId: result.session.companyId,
      userId: result.session.userId,
      memberId: result.member.id,
      sessionId: result.session.id,
      deviceId: result.session.deviceId,
      tokenHash: result.session.tokenHash,
      profile: this.profile(result.member, result.session),
    };
  }
  async require(tx: AuthTx, principal: Principal, permission?: string) {
    const result = await this.resolve(tx, principal.tokenHash);
    if (
      !result ||
      result.session.id !== principal.sessionId ||
      result.session.lockedAt ||
      result.member.user.mustChangePassword
    )
      throw new UnauthorizedException('Session indisponible.');
    const profile = this.profile(result.member, result.session);
    if (permission && !profile.permissions.includes(permission))
      throw new ForbiddenException('Autorisation insuffisante.');
    return profile;
  }
  async logout(token: string) {
    await this.store.run(async (tx) => {
      const session = await tx.authSession.findUnique({ where: { tokenHash: tokenHash(token) } });
      if (!session || session.revokedAt) return;
      await tx.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      await this.event(tx, 'LOGOUT', {
        companyId: session.companyId,
        actorId: session.userId,
        sessionId: session.id,
        deviceId: session.deviceId,
      });
    });
    return { ok: true };
  }
  async lock(principal: Principal) {
    await this.store.run(async (tx) => {
      const result = await this.resolve(tx, principal.tokenHash);
      if (!result) return;
      if (!result.session.lockedAt) {
        await tx.authSession.update({
          where: { id: principal.sessionId },
          data: { lockedAt: new Date() },
        });
        await this.event(tx, 'LOCK', {
          companyId: principal.companyId,
          actorId: principal.userId,
          sessionId: principal.sessionId,
          deviceId: principal.deviceId,
        });
      }
    });
    return { ok: true };
  }
  async unlock(principal: Principal, password: string, ip: string) {
    if (
      !(await this.attempt(this.key(`unlock:${principal.userId}`), 5)) ||
      !(await this.attempt(this.key(`ip:${ip}`), 120))
    )
      throw new HttpException('Déverrouillage temporairement limité.', 429);
    const credential = await this.store.run((tx) =>
      tx.userCredential.findUnique({ where: { userId: principal.userId } }),
    );
    if (!(await this.passwords.verify(password, credential?.passwordHash ?? null))) {
      await this.store.run((tx) =>
        this.event(tx, 'UNLOCK_FAILED', {
          companyId: principal.companyId,
          subjectId: principal.userId,
          sessionId: principal.sessionId,
          deviceId: principal.deviceId,
        }),
      );
      throw new UnauthorizedException('Déverrouillage refusé.');
    }
    const token = randomBytes(32).toString('base64url');
    const profile = await this.store.run(async (tx) => {
      const result = await this.resolve(tx, principal.tokenHash);
      const current = await tx.userCredential.findUnique({ where: { userId: principal.userId } });
      if (!result || current?.passwordHash !== credential?.passwordHash) return null;
      const now = new Date();
      const session = await tx.authSession.update({
        where: { id: principal.sessionId },
        data: {
          tokenHash: tokenHash(token),
          lockedAt: null,
          lastSeenAt: now,
          idleExpiresAt: new Date(
            Math.min(now.getTime() + SESSION_IDLE_MS, result.session.expiresAt.getTime()),
          ),
        },
      });
      await tx.authThrottle.update({
        where: { key: this.key(`unlock:${principal.userId}`) },
        data: { failures: 0, blockedUntil: null },
      });
      await this.event(tx, 'UNLOCK_SUCCESS', {
        companyId: principal.companyId,
        actorId: principal.userId,
        sessionId: principal.sessionId,
        deviceId: principal.deviceId,
      });
      return this.profile(result.member, session, now);
    });
    if (!profile) throw new UnauthorizedException('Session expirée ou accès révoqué.');
    return { accessToken: token, profile };
  }
  async activity(principal: Principal) {
    return this.store.run(async (tx) => {
      await this.require(tx, principal);
      const row = await tx.authSession.findUniqueOrThrow({ where: { id: principal.sessionId } }),
        now = new Date();
      await tx.authSession.update({
        where: { id: row.id },
        data: {
          lastSeenAt: now,
          idleExpiresAt: new Date(
            Math.min(now.getTime() + SESSION_IDLE_MS, row.expiresAt.getTime()),
          ),
        },
      });
      return { ok: true };
    });
  }
  async changePassword(principal: Principal, currentPassword: string, newPassword: string) {
    newPasswordSchema.parse(newPassword);
    if (currentPassword === newPassword)
      throw new ForbiddenException('Choisissez un nouveau mot de passe.');
    if (!(await this.attempt(this.key(`unlock:${principal.userId}`), 5)))
      throw new HttpException('Action temporairement limitée.', 429);
    const credential = await this.store.run((tx) =>
      tx.userCredential.findUnique({ where: { userId: principal.userId } }),
    );
    if (!(await this.passwords.verify(currentPassword, credential?.passwordHash ?? null)))
      throw new UnauthorizedException('Mot de passe actuel non valide.');
    const hash = await this.passwords.hash(newPassword);
    await this.store.run(async (tx) => {
      const result = await this.resolve(tx, principal.tokenHash),
        current = await tx.userCredential.findUnique({ where: { userId: principal.userId } });
      if (!result || result.session.lockedAt || current?.passwordHash !== credential?.passwordHash)
        throw new UnauthorizedException('Session indisponible.');
      await tx.userCredential.update({
        where: { userId: principal.userId },
        data: { passwordHash: hash, changedAt: new Date() },
      });
      await tx.user.update({
        where: { id: principal.userId },
        data: { securityVersion: { increment: 1 }, mustChangePassword: false },
      });
      await tx.authSession.updateMany({
        where: { userId: principal.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.event(tx, 'PASSWORD_CHANGED', {
        companyId: principal.companyId,
        actorId: principal.userId,
        subjectId: principal.userId,
        sessionId: principal.sessionId,
      });
    });
    return { ok: true };
  }
}
