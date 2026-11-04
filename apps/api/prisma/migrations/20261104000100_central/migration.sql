BEGIN;
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('CDF', 'USD');

-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('TREASURY', 'CLEARING', 'EQUITY');

-- CreateEnum
CREATE TYPE "SessionState" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "OperationKind" AS ENUM ('RECEIPT', 'DISBURSEMENT', 'TRANSFER', 'FX', 'REVERSAL');

-- CreateEnum
CREATE TYPE "EntrySide" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "ExpenseState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVE', 'REJECT');

-- CreateEnum
CREATE TYPE "ReservationState" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "DraftKind" AS ENUM ('RECEIPT', 'EXPENSE_REQUEST');

-- CreateTable
CREATE TABLE "Installation" (
    "id" UUID NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agency" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Agency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "displayName" VARCHAR(160) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyMember" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CompanyMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" VARCHAR(60) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "code" VARCHAR(80) NOT NULL,
    "description" VARCHAR(200) NOT NULL,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "MemberRole" (
    "companyId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "roleId" UUID NOT NULL,

    CONSTRAINT "MemberRole_pkey" PRIMARY KEY ("companyId","memberId","roleId")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "companyId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "permissionCode" VARCHAR(80) NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("companyId","roleId","permissionCode")
);

-- CreateTable
CREATE TABLE "AgencyGrant" (
    "companyId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "agencyId" UUID NOT NULL,

    CONSTRAINT "AgencyGrant_pkey" PRIMARY KEY ("companyId","memberId","agencyId")
);

-- CreateTable
CREATE TABLE "CashRegister" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CashRegister_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreasuryAccount" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "cashRegisterId" UUID,
    "code" VARCHAR(60) NOT NULL,
    "currency" "Currency" NOT NULL,
    "kind" "AccountKind" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "TreasuryAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashSession" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "cashRegisterId" UUID NOT NULL,
    "openedById" UUID NOT NULL,
    "closedById" UUID,
    "state" "SessionState" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),

    CONSTRAINT "CashSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialOperation" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "kind" "OperationKind" NOT NULL,
    "currency" "Currency",
    "idempotencyKey" UUID NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "postedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
    "expenseRequestId" UUID,
    "reversalOfId" UUID,
    "reasonCode" VARCHAR(80),
    "exchangeRateId" UUID,
    "sourceAmount" DECIMAL(18,2),
    "targetAmount" DECIMAL(18,2),

    CONSTRAINT "FinancialOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "cashSessionId" UUID,
    "lineNo" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL,
    "side" "EntrySide" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseRequest" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "currency" "Currency" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "state" "ExpenseState" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseApproval" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "expenseRequestId" UUID NOT NULL,
    "approverId" UUID NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "currency" "Currency" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundReservation" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "expenseRequestId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "currency" "Currency" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "state" "ReservationState" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "sourceAccountId" UUID NOT NULL,
    "destinationAccountId" UUID NOT NULL,
    "currency" "Currency" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeRate" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "fromCurrency" "Currency" NOT NULL,
    "toCurrency" "Currency" NOT NULL,
    "rate" DECIMAL(24,12) NOT NULL,
    "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
    "source" VARCHAR(100) NOT NULL,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "operationId" UUID,
    "expenseRequestId" UUID,
    "uploadedById" UUID NOT NULL,
    "objectKey" VARCHAR(200) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "mimeType" VARCHAR(100) NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "action" VARCHAR(60) NOT NULL,
    "targetType" VARCHAR(60) NOT NULL,
    "targetId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportedDraft" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "clientDraftId" UUID NOT NULL,
    "kind" "DraftKind" NOT NULL,
    "currency" "Currency" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "version" INTEGER NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportedDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Agency_companyId_id_key" ON "Agency"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Agency_companyId_code_key" ON "Agency"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyMember_companyId_id_key" ON "CompanyMember"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyMember_companyId_userId_key" ON "CompanyMember"("companyId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_companyId_id_key" ON "Role"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Role_companyId_code_key" ON "Role"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "CashRegister_companyId_id_agencyId_key" ON "CashRegister"("companyId", "id", "agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "CashRegister_companyId_agencyId_code_key" ON "CashRegister"("companyId", "agencyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "TreasuryAccount_companyId_id_currency_key" ON "TreasuryAccount"("companyId", "id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "TreasuryAccount_companyId_id_currency_agencyId_key" ON "TreasuryAccount"("companyId", "id", "currency", "agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "TreasuryAccount_companyId_agencyId_code_currency_key" ON "TreasuryAccount"("companyId", "agencyId", "code", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "TreasuryAccount_companyId_cashRegisterId_currency_key" ON "TreasuryAccount"("companyId", "cashRegisterId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "CashSession_companyId_id_key" ON "CashSession"("companyId", "id");

-- CreateIndex
CREATE INDEX "FinancialOperation_companyId_postedAt_idx" ON "FinancialOperation"("companyId", "postedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialOperation_companyId_id_key" ON "FinancialOperation"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialOperation_companyId_idempotencyKey_key" ON "FinancialOperation"("companyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialOperation_companyId_expenseRequestId_key" ON "FinancialOperation"("companyId", "expenseRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialOperation_companyId_reversalOfId_key" ON "FinancialOperation"("companyId", "reversalOfId");

-- CreateIndex
CREATE INDEX "LedgerEntry_companyId_accountId_idx" ON "LedgerEntry"("companyId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_companyId_operationId_lineNo_key" ON "LedgerEntry"("companyId", "operationId", "lineNo");

-- CreateIndex
CREATE INDEX "ExpenseRequest_companyId_agencyId_state_idx" ON "ExpenseRequest"("companyId", "agencyId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseRequest_companyId_id_key" ON "ExpenseRequest"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseApproval_companyId_expenseRequestId_key" ON "ExpenseApproval"("companyId", "expenseRequestId");

-- CreateIndex
CREATE INDEX "FundReservation_companyId_accountId_state_idx" ON "FundReservation"("companyId", "accountId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "FundReservation_companyId_expenseRequestId_key" ON "FundReservation"("companyId", "expenseRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_companyId_operationId_key" ON "Transfer"("companyId", "operationId");

-- CreateIndex
CREATE INDEX "ExchangeRate_companyId_fromCurrency_toCurrency_effectiveAt_idx" ON "ExchangeRate"("companyId", "fromCurrency", "toCurrency", "effectiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_companyId_id_key" ON "ExchangeRate"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_objectKey_key" ON "Attachment"("objectKey");

-- CreateIndex
CREATE INDEX "AuditEvent_companyId_targetType_targetId_idx" ON "AuditEvent"("companyId", "targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportedDraft_companyId_authorId_clientDraftId_key" ON "ImportedDraft"("companyId", "authorId", "clientDraftId");

-- AddForeignKey
ALTER TABLE "Agency" ADD CONSTRAINT "Agency_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyMember" ADD CONSTRAINT "CompanyMember_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyMember" ADD CONSTRAINT "CompanyMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberRole" ADD CONSTRAINT "MemberRole_companyId_memberId_fkey" FOREIGN KEY ("companyId", "memberId") REFERENCES "CompanyMember"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberRole" ADD CONSTRAINT "MemberRole_companyId_roleId_fkey" FOREIGN KEY ("companyId", "roleId") REFERENCES "Role"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_companyId_roleId_fkey" FOREIGN KEY ("companyId", "roleId") REFERENCES "Role"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionCode_fkey" FOREIGN KEY ("permissionCode") REFERENCES "Permission"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyGrant" ADD CONSTRAINT "AgencyGrant_companyId_memberId_fkey" FOREIGN KEY ("companyId", "memberId") REFERENCES "CompanyMember"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyGrant" ADD CONSTRAINT "AgencyGrant_companyId_agencyId_fkey" FOREIGN KEY ("companyId", "agencyId") REFERENCES "Agency"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashRegister" ADD CONSTRAINT "CashRegister_companyId_agencyId_fkey" FOREIGN KEY ("companyId", "agencyId") REFERENCES "Agency"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreasuryAccount" ADD CONSTRAINT "TreasuryAccount_companyId_agencyId_fkey" FOREIGN KEY ("companyId", "agencyId") REFERENCES "Agency"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreasuryAccount" ADD CONSTRAINT "TreasuryAccount_companyId_cashRegisterId_agencyId_fkey" FOREIGN KEY ("companyId", "cashRegisterId", "agencyId") REFERENCES "CashRegister"("companyId", "id", "agencyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_companyId_cashRegisterId_agencyId_fkey" FOREIGN KEY ("companyId", "cashRegisterId", "agencyId") REFERENCES "CashRegister"("companyId", "id", "agencyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialOperation" ADD CONSTRAINT "FinancialOperation_companyId_agencyId_fkey" FOREIGN KEY ("companyId", "agencyId") REFERENCES "Agency"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialOperation" ADD CONSTRAINT "FinancialOperation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialOperation" ADD CONSTRAINT "FinancialOperation_companyId_expenseRequestId_fkey" FOREIGN KEY ("companyId", "expenseRequestId") REFERENCES "ExpenseRequest"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialOperation" ADD CONSTRAINT "FinancialOperation_companyId_reversalOfId_fkey" FOREIGN KEY ("companyId", "reversalOfId") REFERENCES "FinancialOperation"("companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FinancialOperation" ADD CONSTRAINT "FinancialOperation_companyId_exchangeRateId_fkey" FOREIGN KEY ("companyId", "exchangeRateId") REFERENCES "ExchangeRate"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_companyId_operationId_fkey" FOREIGN KEY ("companyId", "operationId") REFERENCES "FinancialOperation"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_companyId_accountId_currency_fkey" FOREIGN KEY ("companyId", "accountId", "currency") REFERENCES "TreasuryAccount"("companyId", "id", "currency") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_companyId_cashSessionId_fkey" FOREIGN KEY ("companyId", "cashSessionId") REFERENCES "CashSession"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseRequest" ADD CONSTRAINT "ExpenseRequest_companyId_accountId_currency_agencyId_fkey" FOREIGN KEY ("companyId", "accountId", "currency", "agencyId") REFERENCES "TreasuryAccount"("companyId", "id", "currency", "agencyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseRequest" ADD CONSTRAINT "ExpenseRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseApproval" ADD CONSTRAINT "ExpenseApproval_companyId_expenseRequestId_fkey" FOREIGN KEY ("companyId", "expenseRequestId") REFERENCES "ExpenseRequest"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseApproval" ADD CONSTRAINT "ExpenseApproval_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundReservation" ADD CONSTRAINT "FundReservation_companyId_expenseRequestId_fkey" FOREIGN KEY ("companyId", "expenseRequestId") REFERENCES "ExpenseRequest"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundReservation" ADD CONSTRAINT "FundReservation_companyId_accountId_currency_fkey" FOREIGN KEY ("companyId", "accountId", "currency") REFERENCES "TreasuryAccount"("companyId", "id", "currency") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_companyId_operationId_fkey" FOREIGN KEY ("companyId", "operationId") REFERENCES "FinancialOperation"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_companyId_sourceAccountId_currency_fkey" FOREIGN KEY ("companyId", "sourceAccountId", "currency") REFERENCES "TreasuryAccount"("companyId", "id", "currency") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_companyId_destinationAccountId_currency_fkey" FOREIGN KEY ("companyId", "destinationAccountId", "currency") REFERENCES "TreasuryAccount"("companyId", "id", "currency") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeRate" ADD CONSTRAINT "ExchangeRate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_companyId_operationId_fkey" FOREIGN KEY ("companyId", "operationId") REFERENCES "FinancialOperation"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_companyId_expenseRequestId_fkey" FOREIGN KEY ("companyId", "expenseRequestId") REFERENCES "ExpenseRequest"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportedDraft" ADD CONSTRAINT "ImportedDraft_companyId_agencyId_fkey" FOREIGN KEY ("companyId", "agencyId") REFERENCES "Agency"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportedDraft" ADD CONSTRAINT "ImportedDraft_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
