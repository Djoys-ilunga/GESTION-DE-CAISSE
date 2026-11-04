BEGIN;
ALTER TABLE "ImportedDraft" ADD CONSTRAINT receipt_draft_cash CHECK(kind<>'RECEIPT' OR "cashRegisterId" IS NOT NULL) NOT VALID;
CREATE FUNCTION caissepro_draft_cash_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF TG_OP='UPDATE' AND NEW."cashRegisterId" IS DISTINCT FROM OLD."cashRegisterId" THEN RAISE EXCEPTION 'CAISSEPRO_DRAFT_CONFLICT' USING ERRCODE='23514'; END IF;
 IF NEW."cashRegisterId" IS NOT NULL THEN PERFORM caissepro_assert_cash_permission(NEW."companyId",NEW."authorId",NEW."cashRegisterId",'draft:receive'); END IF;
 RETURN NEW; END $$;
CREATE TRIGGER cash_scope BEFORE INSERT OR UPDATE ON "ImportedDraft" FOR EACH ROW EXECUTE FUNCTION caissepro_draft_cash_scope();
COMMIT;
