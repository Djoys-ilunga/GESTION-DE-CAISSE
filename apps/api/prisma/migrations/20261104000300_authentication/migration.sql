BEGIN;
-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "code" VARCHAR(32) NOT NULL DEFAULT ('CP-'::text || upper(substr((gen_random_uuid())::text, 1, 12)));

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "securityVersion" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "CompanyMember" ADD COLUMN     "authorizationVersion" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ImportedDraft" ADD COLUMN     "cashRegisterId" UUID;

-- CreateTable
CREATE TABLE "UserCredential" (
    "userId" UUID NOT NULL,
    "passwordHash" VARCHAR(256) NOT NULL,
    "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserCredential_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "CashRegisterGrant" (
    "companyId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "cashRegisterId" UUID NOT NULL,

    CONSTRAINT "CashRegisterGrant_pkey" PRIMARY KEY ("companyId","memberId","cashRegisterId")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "userVersion" INTEGER NOT NULL,
    "memberVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "idleExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lockedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthThrottle" (
    "key" CHAR(64) NOT NULL,
    "windowStartedAt" TIMESTAMPTZ(3) NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "blockedUntil" TIMESTAMPTZ(3),

    CONSTRAINT "AuthThrottle_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuthEvent" (
    "id" UUID NOT NULL,
    "companyId" UUID,
    "actorId" UUID,
    "subjectId" UUID,
    "sessionId" UUID,
    "deviceId" UUID,
    "code" VARCHAR(60) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthSession_companyId_userId_revokedAt_idx" ON "AuthSession"("companyId", "userId", "revokedAt");

-- CreateIndex
CREATE INDEX "AuthEvent_companyId_createdAt_idx" ON "AuthEvent"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Company_code_key" ON "Company"("code");

-- AddForeignKey
ALTER TABLE "UserCredential" ADD CONSTRAINT "UserCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashRegisterGrant" ADD CONSTRAINT "CashRegisterGrant_companyId_memberId_fkey" FOREIGN KEY ("companyId", "memberId") REFERENCES "CompanyMember"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashRegisterGrant" ADD CONSTRAINT "CashRegisterGrant_companyId_cashRegisterId_agencyId_fkey" FOREIGN KEY ("companyId", "cashRegisterId", "agencyId") REFERENCES "CashRegister"("companyId", "id", "agencyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_companyId_memberId_fkey" FOREIGN KEY ("companyId", "memberId") REFERENCES "CompanyMember"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
