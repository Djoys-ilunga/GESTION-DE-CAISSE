BEGIN;
-- AlterTable
ALTER TABLE "CashRegister" ADD COLUMN     "configurationHash" CHAR(64),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ImportedDraft" ADD COLUMN     "evidenceBytes" BYTEA,
ADD COLUMN     "evidenceMime" VARCHAR(100),
ADD COLUMN     "evidenceName" VARCHAR(160),
ADD COLUMN     "evidenceSha" CHAR(64),
ADD COLUMN     "receiptCategory" VARCHAR(80),
ADD COLUMN     "receiptProvenance" VARCHAR(160),
ADD COLUMN     "receiptReference" VARCHAR(160);

-- CreateTable
CREATE TABLE "ReceiptCounter" (
    "companyId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "lastSequence" BIGINT NOT NULL,

    CONSTRAINT "ReceiptCounter_pkey" PRIMARY KEY ("companyId","year")
);

-- CreateTable
CREATE TABLE "CashReceipt" (
    "evidenceByteLength" INTEGER,
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "cashRegisterId" UUID NOT NULL,
    "sourceDraftId" UUID NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "clientDraftId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "currency" "Currency" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "provenance" VARCHAR(160) NOT NULL,
    "category" VARCHAR(80) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "reference" VARCHAR(160) NOT NULL,
    "companyName" VARCHAR(160) NOT NULL,
    "companyCode" VARCHAR(32) NOT NULL,
    "agencyName" VARCHAR(160) NOT NULL,
    "agencyCode" VARCHAR(40) NOT NULL,
    "cashName" VARCHAR(160) NOT NULL,
    "cashCode" VARCHAR(40) NOT NULL,
    "cashierName" VARCHAR(160) NOT NULL,
    "postedAt" TIMESTAMPTZ(3) NOT NULL,
    "year" INTEGER NOT NULL,
    "sequence" BIGINT NOT NULL,
    "number" VARCHAR(160) NOT NULL,
    "evidenceName" VARCHAR(160),
    "evidenceMime" VARCHAR(100),
    "evidenceSha" CHAR(64),
    "evidenceBytes" BYTEA,

    CONSTRAINT "CashReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashReceipt_companyId_cashRegisterId_postedAt_id_idx" ON "CashReceipt"("companyId", "cashRegisterId", "postedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CashReceipt_companyId_id_key" ON "CashReceipt"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CashReceipt_companyId_sourceDraftId_key" ON "CashReceipt"("companyId", "sourceDraftId");

-- CreateIndex
CREATE UNIQUE INDEX "CashReceipt_companyId_operationId_key" ON "CashReceipt"("companyId", "operationId");

-- CreateIndex
CREATE UNIQUE INDEX "CashReceipt_companyId_number_key" ON "CashReceipt"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "CashReceipt_companyId_year_sequence_key" ON "CashReceipt"("companyId", "year", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "ImportedDraft_companyId_id_key" ON "ImportedDraft"("companyId", "id");

-- AddForeignKey
ALTER TABLE "ReceiptCounter" ADD CONSTRAINT "ReceiptCounter_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashReceipt" ADD CONSTRAINT "CashReceipt_companyId_cashRegisterId_agencyId_fkey" FOREIGN KEY ("companyId", "cashRegisterId", "agencyId") REFERENCES "CashRegister"("companyId", "id", "agencyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashReceipt" ADD CONSTRAINT "CashReceipt_companyId_operationId_fkey" FOREIGN KEY ("companyId", "operationId") REFERENCES "FinancialOperation"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashReceipt" ADD CONSTRAINT "CashReceipt_companyId_sourceDraftId_fkey" FOREIGN KEY ("companyId", "sourceDraftId") REFERENCES "ImportedDraft"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashReceipt" ADD CONSTRAINT "CashReceipt_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


COMMIT;
