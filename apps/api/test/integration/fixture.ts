import { randomUUID as id } from 'node:crypto';
import type { PrismaService } from '../../src/prisma.service';
import { CentralAccess } from '../../src/data/central-access';
export async function fixture(db: PrismaService) {
  const companyId = id(),
    agencyId = id(),
    otherAgencyId = id(),
    userId = id(),
    approverId = id(),
    viewerId = id(),
    registerId = id(),
    otherRegisterId = id();
  const usd = id(),
    cdf = id(),
    otherUsd = id(),
    clearingUsd = id(),
    clearingCdf = id(),
    sessionId = id(),
    otherSessionId = id();
  await db.company.create({ data: { id: companyId, name: 'Entreprise de test' } });
  await db.agency.createMany({
    data: [
      { id: agencyId, companyId, code: 'A', name: 'Agence A' },
      { id: otherAgencyId, companyId, code: 'B', name: 'Agence B' },
    ],
  });
  const permissions = await db.permission.findMany();
  const roleId = id();
  await db.role.create({ data: { id: roleId, companyId, code: 'ADMIN_TEST' } });
  await db.rolePermission.createMany({
    data: permissions.map((p) => ({ companyId, roleId, permissionCode: p.code })),
  });
  for (const u of [userId, approverId, viewerId]) {
    await db.user.create({
      data: { id: u, email: `${u}@example.test`, displayName: 'Utilisateur test' },
    });
    const memberId = id();
    await db.companyMember.create({ data: { id: memberId, companyId, userId: u } });
    if (u !== viewerId) await db.memberRole.create({ data: { companyId, memberId, roleId } });
    await db.agencyGrant.createMany({
      data: [agencyId, otherAgencyId].map((agencyId) => ({ companyId, memberId, agencyId })),
    });
  }
  await db.cashRegister.createMany({
    data: [
      { id: registerId, companyId, agencyId, code: 'C1', name: 'Caisse A' },
      { id: otherRegisterId, companyId, agencyId: otherAgencyId, code: 'C2', name: 'Caisse B' },
    ],
  });
  await db.treasuryAccount.createMany({
    data: [
      {
        id: usd,
        companyId,
        agencyId,
        cashRegisterId: registerId,
        code: 'CASH',
        currency: 'USD',
        kind: 'TREASURY',
      },
      {
        id: cdf,
        companyId,
        agencyId,
        cashRegisterId: registerId,
        code: 'CASH',
        currency: 'CDF',
        kind: 'TREASURY',
      },
      {
        id: otherUsd,
        companyId,
        agencyId: otherAgencyId,
        cashRegisterId: otherRegisterId,
        code: 'CASH',
        currency: 'USD',
        kind: 'TREASURY',
      },
      { id: clearingUsd, companyId, agencyId, code: 'CLEAR', currency: 'USD', kind: 'CLEARING' },
      { id: clearingCdf, companyId, agencyId, code: 'CLEAR', currency: 'CDF', kind: 'CLEARING' },
    ],
  });
  const ctx = { companyId, userId };
  const access = new CentralAccess(db);
  await access.run(ctx, async (tx) => {
    await tx.cashSession.createMany({
      data: [
        { id: sessionId, companyId, agencyId, cashRegisterId: registerId, openedById: userId },
        {
          id: otherSessionId,
          companyId,
          agencyId: otherAgencyId,
          cashRegisterId: otherRegisterId,
          openedById: userId,
        },
      ],
    });
  });
  return {
    companyId,
    agencyId,
    otherAgencyId,
    userId,
    approverId,
    viewerId,
    usd,
    cdf,
    otherUsd,
    clearingUsd,
    clearingCdf,
    sessionId,
    otherSessionId,
    registerId,
    otherRegisterId,
    ctx,
    approveCtx: { companyId, userId: approverId },
  };
}
