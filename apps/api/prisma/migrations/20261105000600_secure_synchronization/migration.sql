BEGIN;
-- AlterTable
ALTER TABLE "ImportedDraft" ADD COLUMN     "clientCreatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "clientUpdatedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "SyncEvent" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "clientDraftId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "stage" VARCHAR(20) NOT NULL,
    "code" VARCHAR(60) NOT NULL,
    "serverId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SyncEvent_companyId_authorId_createdAt_idx" ON "SyncEvent"("companyId", "authorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncEvent_companyId_authorId_attemptId_stage_key" ON "SyncEvent"("companyId", "authorId", "attemptId", "stage");

-- At most one terminal result even for direct concurrent SQL writers.
CREATE UNIQUE INDEX "SyncEvent_one_final_per_attempt" ON "SyncEvent"("companyId","authorId","attemptId") WHERE stage<>'STARTED';

-- AddForeignKey
ALTER TABLE "SyncEvent" ADD CONSTRAINT "SyncEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncEvent" ADD CONSTRAINT "SyncEvent_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncEvent" ADD CONSTRAINT "SyncEvent_companyId_serverId_fkey" FOREIGN KEY ("companyId", "serverId") REFERENCES "ImportedDraft"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


GRANT SELECT,INSERT ON "SyncEvent" TO caissepro_runtime;
ALTER TABLE "SyncEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY own_sync_events ON "SyncEvent" TO caissepro_runtime
 USING("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid AND "authorId"=nullif(current_setting('caissepro.actor_id',true),'')::uuid)
 WITH CHECK("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid AND "authorId"=nullif(current_setting('caissepro.actor_id',true),'')::uuid);
ALTER TABLE "SyncEvent" ADD CHECK(version>0 AND stage IN('STARTED','SUCCESS','CONFLICT','ERROR') AND code IN('started','draft-received','conflict','validation-failed','permission-denied','expired','interrupted') AND ((stage='SUCCESS')=("serverId" IS NOT NULL)));
ALTER TABLE "ImportedDraft" ADD CHECK(("clientCreatedAt" IS NULL AND "clientUpdatedAt" IS NULL) OR ("clientCreatedAt" IS NOT NULL AND "clientUpdatedAt" IS NOT NULL AND "clientUpdatedAt">="clientCreatedAt"));
CREATE FUNCTION caissepro_sync_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 PERFORM caissepro_assert_company_permission(NEW."companyId",NEW."authorId",'draft:write_own');
 IF NEW.stage='STARTED' THEN
  IF NEW.code<>'started' OR EXISTS(SELECT FROM "SyncEvent" WHERE "companyId"=NEW."companyId" AND "authorId"=NEW."authorId" AND "attemptId"=NEW."attemptId") THEN RAISE EXCEPTION 'CAISSEPRO_SYNC_EVENT_INVALID' USING ERRCODE='23514'; END IF;
 ELSE
  IF NOT EXISTS(SELECT FROM "SyncEvent" WHERE "companyId"=NEW."companyId" AND "authorId"=NEW."authorId" AND "attemptId"=NEW."attemptId" AND "clientDraftId"=NEW."clientDraftId" AND version=NEW.version AND stage='STARTED') OR EXISTS(SELECT FROM "SyncEvent" WHERE "companyId"=NEW."companyId" AND "authorId"=NEW."authorId" AND "attemptId"=NEW."attemptId" AND stage<>'STARTED') THEN RAISE EXCEPTION 'CAISSEPRO_SYNC_EVENT_INVALID' USING ERRCODE='23514'; END IF;
  IF NEW.stage='SUCCESS' AND (NEW.code<>'draft-received' OR NOT EXISTS(SELECT FROM "ImportedDraft" WHERE "companyId"=NEW."companyId" AND "authorId"=NEW."authorId" AND id=NEW."serverId" AND "clientDraftId"=NEW."clientDraftId" AND version>=NEW.version)) THEN RAISE EXCEPTION 'CAISSEPRO_SYNC_EVENT_INVALID' USING ERRCODE='23514'; END IF;
 END IF;
 NEW."createdAt":=transaction_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER sync_event_guard BEFORE INSERT ON "SyncEvent" FOR EACH ROW EXECUTE FUNCTION caissepro_sync_event_guard();
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON "SyncEvent" FOR EACH ROW EXECUTE FUNCTION caissepro_immutable();
CREATE FUNCTION caissepro_sync_dates_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND OLD."clientCreatedAt" IS NOT NULL AND (NEW."clientCreatedAt" IS DISTINCT FROM OLD."clientCreatedAt" OR NEW."clientUpdatedAt" IS NULL OR NEW."clientUpdatedAt"<OLD."clientUpdatedAt") THEN RAISE EXCEPTION 'CAISSEPRO_DRAFT_DATES_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sync_dates_guard BEFORE INSERT OR UPDATE ON "ImportedDraft" FOR EACH ROW EXECUTE FUNCTION caissepro_sync_dates_guard();
COMMIT;
