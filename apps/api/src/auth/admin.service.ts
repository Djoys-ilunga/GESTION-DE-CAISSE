import { Injectable, Inject, ForbiddenException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  accessAssignmentSchema,
  createUserSchema,
  ROLE_PERMISSIONS,
  type RoleCode,
  type AccessAssignment,
  type ManagedUser,
} from '@caissepro/shared';
import type { Prisma } from '../generated/prisma/client';
import { AuthService, type Principal } from './auth.service';
import type { AuthTx } from './auth-store';
const include = {
  user: true,
  roles: { include: { role: true } },
  agencies: true,
  cashGrants: true,
} satisfies Prisma.CompanyMemberInclude;
type Managed = Prisma.CompanyMemberGetPayload<{ include: typeof include }>;
function view(m: Managed): ManagedUser {
  return {
    id: m.userId,
    memberId: m.id,
    email: m.user.email,
    displayName: m.user.displayName,
    active: m.active && m.user.active,
    roles: m.roles.map((r) => r.role.code as RoleCode),
    agencyIds: m.agencies.map((g) => g.agencyId),
    cashRegisterIds: m.cashGrants.map((g) => g.cashRegisterId),
    version: m.authorizationVersion,
  };
}
export async function installRoles(tx: AuthTx, companyId: string) {
  for (const [code, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await tx.role.upsert({
      where: { companyId_code: { companyId, code } },
      create: { id: randomUUID(), companyId, code },
      update: {},
    });
    await tx.rolePermission.createMany({
      data: permissions.map((permissionCode) => ({ companyId, roleId: role.id, permissionCode })),
      skipDuplicates: true,
    });
  }
}
@Injectable()
export class AdminService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  async accessCatalog(p: Principal) {
    return this.auth.store.run(async (tx) => {
      await this.auth.require(tx, p, 'users:manage');
      const [agencies, cashRegisters, roles] = await Promise.all([
        tx.agency.findMany({
          where: { companyId: p.companyId, active: true },
          select: { id: true, name: true, code: true },
        }),
        tx.cashRegister.findMany({
          where: { companyId: p.companyId, active: true, agency: { active: true } },
          select: { id: true, agencyId: true, name: true, code: true },
        }),
        tx.role.findMany({
          where: {
            companyId: p.companyId,
            active: true,
            code: { in: Object.keys(ROLE_PERMISSIONS) },
          },
          include: { permissions: true },
          orderBy: { code: 'asc' },
        }),
      ]);
      return {
        roles: Object.fromEntries(
          roles.map((r) => [r.code, r.permissions.map((p) => p.permissionCode).sort()]),
        ),
        agencies,
        cashRegisters,
      };
    });
  }
  async users(p: Principal) {
    return this.auth.store.run(async (tx) => {
      await this.auth.require(tx, p, 'users:manage');
      return (
        await tx.companyMember.findMany({
          where: { companyId: p.companyId },
          include,
          take: 200,
          orderBy: { user: { email: 'asc' } },
        })
      ).map(view);
    });
  }
  private async scopes(tx: AuthTx, companyId: string, access: AccessAssignment) {
    const agencies = [...new Set(access.agencyIds)],
      registers = [...new Set(access.cashRegisterIds)];
    const [a, r, roles] = await Promise.all([
      tx.agency.findMany({ where: { companyId, id: { in: agencies }, active: true } }),
      tx.cashRegister.findMany({ where: { companyId, id: { in: registers }, active: true } }),
      tx.role.findMany({ where: { companyId, code: { in: access.roles }, active: true } }),
    ]);
    if (
      a.length !== agencies.length ||
      r.length !== registers.length ||
      roles.length !== new Set(access.roles).size ||
      r.some((register) => !agencies.includes(register.agencyId))
    )
      throw new ForbiddenException('Affectation hors du périmètre autorisé.');
    return { a, r, roles };
  }
  private async assign(tx: AuthTx, companyId: string, memberId: string, access: AccessAssignment) {
    const { a, r, roles } = await this.scopes(tx, companyId, access);
    await tx.memberRole.deleteMany({ where: { companyId, memberId } });
    await tx.agencyGrant.deleteMany({ where: { companyId, memberId } });
    await tx.cashRegisterGrant.deleteMany({ where: { companyId, memberId } });
    await tx.memberRole.createMany({
      data: roles.map((role) => ({ companyId, memberId, roleId: role.id })),
    });
    await tx.agencyGrant.createMany({
      data: a.map((agency) => ({ companyId, memberId, agencyId: agency.id })),
    });
    await tx.cashRegisterGrant.createMany({
      data: r.map((register) => ({
        companyId,
        memberId,
        agencyId: register.agencyId,
        cashRegisterId: register.id,
      })),
    });
  }
  async create(p: Principal, value: unknown) {
    const input = createUserSchema.parse(value);
    await this.auth.store.run((tx) => this.auth.require(tx, p, 'users:manage'));
    const hash = await this.auth.passwords.hash(input.initialPassword);
    return this.auth.store.run(async (tx) => {
      await this.auth.require(tx, p, 'users:manage');
      await this.auth.require(tx, p, 'roles:assign');
      await this.scopes(tx, p.companyId, input.access);
      if (await tx.user.findUnique({ where: { email: input.email } }))
        throw new ConflictException('Cet utilisateur ne peut pas être créé.');
      const user = await tx.user.create({
        data: {
          id: randomUUID(),
          email: input.email,
          displayName: input.displayName,
          mustChangePassword: true,
        },
      });
      await tx.userCredential.create({ data: { userId: user.id, passwordHash: hash } });
      const member = await tx.companyMember.create({
        data: {
          id: randomUUID(),
          companyId: p.companyId,
          userId: user.id,
          active: input.access.active,
        },
      });
      await this.assign(tx, p.companyId, member.id, input.access);
      await this.auth.event(tx, 'USER_CREATED', {
        companyId: p.companyId,
        actorId: p.userId,
        subjectId: user.id,
        sessionId: p.sessionId,
      });
      return view(await tx.companyMember.findUniqueOrThrow({ where: { id: member.id }, include }));
    });
  }
  async updateAccess(p: Principal, userId: string, value: unknown, expectedVersion: number) {
    const access = accessAssignmentSchema.parse(value);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new ConflictException('Version invalide.');
    return this.auth.store.run(async (tx) => {
      await this.auth.require(tx, p, 'users:manage');
      await this.auth.require(tx, p, 'roles:assign');
      await tx.$executeRaw`SELECT id FROM "Company" WHERE id=${p.companyId}::uuid FOR UPDATE`;
      const member = await tx.companyMember.findUnique({
        where: { companyId_userId: { companyId: p.companyId, userId } },
        include,
      });
      if (!member || member.authorizationVersion !== expectedVersion)
        throw new ConflictException('L’utilisateur a changé. Actualisez la liste.');
      const wasAdmin =
        member.roles.some((r) => r.role.active && r.role.code === 'ADMINISTRATOR') && member.active;
      if (wasAdmin && (!access.active || !access.roles.includes('ADMINISTRATOR'))) {
        const others = await tx.companyMember.count({
          where: {
            companyId: p.companyId,
            id: { not: member.id },
            active: true,
            user: { active: true },
            roles: { some: { role: { code: 'ADMINISTRATOR', active: true } } },
          },
        });
        if (!others) throw new ForbiddenException('Conservez au moins un administrateur actif.');
      }
      await this.assign(tx, p.companyId, member.id, access);
      await tx.companyMember.update({
        where: { id: member.id },
        data: { active: access.active, authorizationVersion: { increment: 1 } },
      });
      await tx.authSession.updateMany({
        where: { companyId: p.companyId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.auth.event(tx, 'ACCESS_CHANGED', {
        companyId: p.companyId,
        actorId: p.userId,
        subjectId: userId,
        sessionId: p.sessionId,
      });
      return view(await tx.companyMember.findUniqueOrThrow({ where: { id: member.id }, include }));
    });
  }
  async logs(p: Principal) {
    return this.auth.store.run(async (tx) => {
      await this.auth.require(tx, p, 'auth:logs:read');
      const events = await tx.authEvent.findMany({
        where: { companyId: p.companyId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
        select: { id: true, code: true, createdAt: true, actorId: true, subjectId: true },
      });
      const ids = [
        ...new Set(
          events
            .flatMap((event) => [event.actorId, event.subjectId])
            .filter((id): id is string => id !== null),
        ),
      ];
      const users = await tx.user.findMany({
        where: { id: { in: ids }, members: { some: { companyId: p.companyId } } },
        select: { id: true, displayName: true },
      });
      const names = new Map(users.map((user) => [user.id, user.displayName]));
      return events.map((event) => ({
        ...event,
        actorName: event.actorId ? (names.get(event.actorId) ?? null) : null,
        subjectName: event.subjectId ? (names.get(event.subjectId) ?? null) : null,
      }));
    });
  }
}
