BEGIN;
-- AlterTable
ALTER TABLE "ExpenseRequest" ADD COLUMN     "beneficiary" VARCHAR(160),
ADD COLUMN     "reference" VARCHAR(160),
ADD COLUMN     "sourceDraftId" UUID,
ADD COLUMN     "sourceVersion" INTEGER,
ADD COLUMN     "workflowTransaction" BIGINT;

-- AlterTable
ALTER TABLE "ExpenseApproval" ADD COLUMN     "reason" VARCHAR(500);

-- AlterTable
ALTER TABLE "ImportedDraft" ADD COLUMN     "expenseDetails" JSONB;

-- CreateTable
CREATE TABLE "ExpensePolicy" (
    "companyId" UUID NOT NULL,
    "currency" "Currency" NOT NULL,
    "version" INTEGER NOT NULL,
    "requireEvidence" BOOLEAN NOT NULL,
    "limits" JSONB NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "configuredById" UUID NOT NULL,
    "configuredAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ExpensePolicy_pkey" PRIMARY KEY ("companyId","currency")
);

-- CreateTable
CREATE TABLE "ExpenseEvidence" (
    "byteLength" INTEGER NOT NULL,
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "expenseRequestId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "fileName" VARCHAR(160) NOT NULL,
    "mimeType" VARCHAR(100) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "bytes" BYTEA NOT NULL,

    CONSTRAINT "ExpenseEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoucherCounter" (
    "companyId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "lastSequence" BIGINT NOT NULL,

    CONSTRAINT "VoucherCounter_pkey" PRIMARY KEY ("companyId","year")
);

-- CreateTable
CREATE TABLE "PaymentVoucher" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "expenseRequestId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "currency" "Currency" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "beneficiary" VARCHAR(160) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "reference" VARCHAR(160) NOT NULL,
    "companyName" VARCHAR(160) NOT NULL,
    "companyCode" VARCHAR(32) NOT NULL,
    "agencyName" VARCHAR(160) NOT NULL,
    "cashName" VARCHAR(160) NOT NULL,
    "requesterName" VARCHAR(160) NOT NULL,
    "approverName" VARCHAR(160) NOT NULL,
    "cashierName" VARCHAR(160) NOT NULL,
    "approvedAt" TIMESTAMPTZ(3) NOT NULL,
    "postedAt" TIMESTAMPTZ(3) NOT NULL,
    "year" INTEGER NOT NULL,
    "sequence" BIGINT NOT NULL,
    "number" VARCHAR(160) NOT NULL,

    CONSTRAINT "PaymentVoucher_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseEvidence_companyId_expenseRequestId_ordinal_key" ON "ExpenseEvidence"("companyId", "expenseRequestId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentVoucher_companyId_id_key" ON "PaymentVoucher"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentVoucher_companyId_expenseRequestId_key" ON "PaymentVoucher"("companyId", "expenseRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentVoucher_companyId_operationId_key" ON "PaymentVoucher"("companyId", "operationId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentVoucher_companyId_year_sequence_key" ON "PaymentVoucher"("companyId", "year", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentVoucher_companyId_number_key" ON "PaymentVoucher"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseRequest_companyId_sourceDraftId_key" ON "ExpenseRequest"("companyId", "sourceDraftId");

-- AddForeignKey
ALTER TABLE "ExpenseRequest" ADD CONSTRAINT "ExpenseRequest_companyId_sourceDraftId_fkey" FOREIGN KEY ("companyId", "sourceDraftId") REFERENCES "ImportedDraft"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpensePolicy" ADD CONSTRAINT "ExpensePolicy_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseEvidence" ADD CONSTRAINT "ExpenseEvidence_companyId_expenseRequestId_fkey" FOREIGN KEY ("companyId", "expenseRequestId") REFERENCES "ExpenseRequest"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherCounter" ADD CONSTRAINT "VoucherCounter_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentVoucher" ADD CONSTRAINT "PaymentVoucher_companyId_expenseRequestId_fkey" FOREIGN KEY ("companyId", "expenseRequestId") REFERENCES "ExpenseRequest"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentVoucher" ADD CONSTRAINT "PaymentVoucher_companyId_operationId_fkey" FOREIGN KEY ("companyId", "operationId") REFERENCES "FinancialOperation"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentVoucher" ADD CONSTRAINT "PaymentVoucher_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


COMMIT;
