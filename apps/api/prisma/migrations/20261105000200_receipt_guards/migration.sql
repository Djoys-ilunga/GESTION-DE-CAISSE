BEGIN;
INSERT INTO "Permission"(code,description) VALUES ('cash:configure','Configurer les agences et caisses'),('receipt:read','Consulter les encaissements autorisés') ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission"("companyId","roleId","permissionCode") SELECT "companyId",id,'receipt:read' FROM "Role" WHERE code IN('ADMINISTRATOR','DIRECTOR','FINANCE_MANAGER','ACCOUNTANT','CASHIER','AUDITOR') ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission"("companyId","roleId","permissionCode") SELECT "companyId",id,'cash:configure' FROM "Role" WHERE code='ADMINISTRATOR' ON CONFLICT DO NOTHING;
GRANT SELECT,INSERT,UPDATE ON "ReceiptCounter" TO caissepro_runtime;
GRANT SELECT,INSERT ON "CashReceipt" TO caissepro_runtime;
GRANT UPDATE(id) ON "CashRegister" TO caissepro_runtime;
GRANT INSERT,UPDATE ON "Agency","CashRegister" TO caissepro_auth_runtime;
GRANT SELECT,INSERT ON "TreasuryAccount","AuditEvent" TO caissepro_auth_runtime;
GRANT EXECUTE ON FUNCTION caissepro_assert_session(uuid,uuid) TO caissepro_auth_runtime;
CREATE POLICY auth_cash_configuration ON "TreasuryAccount" TO caissepro_auth_runtime USING("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid) WITH CHECK("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid);
CREATE POLICY auth_cash_configuration ON "AuditEvent" TO caissepro_auth_runtime USING("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid) WITH CHECK("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['CashReceipt','ReceiptCounter'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO caissepro_runtime USING("companyId"=nullif(current_setting(''caissepro.company_id'',true),'''')::uuid) WITH CHECK("companyId"=nullif(current_setting(''caissepro.company_id'',true),'''')::uuid)',t);
END LOOP; END $$;
CREATE POLICY receipt_cash_scope ON "CashReceipt" AS RESTRICTIVE TO caissepro_runtime USING(EXISTS(SELECT FROM "CashRegisterGrant" g JOIN "CompanyMember" m ON m.id=g."memberId" AND m."companyId"=g."companyId" JOIN "AgencyGrant" a ON a."companyId"=m."companyId" AND a."memberId"=m.id AND a."agencyId"="CashReceipt"."agencyId" WHERE g."companyId"="CashReceipt"."companyId" AND g."cashRegisterId"="CashReceipt"."cashRegisterId" AND m.active AND m."userId"=nullif(current_setting('caissepro.actor_id',true),'')::uuid));
ALTER TABLE "CashRegister" ADD CHECK(version>0 AND ("configurationHash" IS NULL OR "configurationHash" ~ '^[a-f0-9]{64}$'));
ALTER TABLE "ReceiptCounter" ADD CHECK(year BETWEEN 2000 AND 9999 AND "lastSequence">0);
ALTER TABLE "CashReceipt" ADD CHECK(amount>0 AND "sourceVersion">0 AND sequence>0 AND year BETWEEN 2000 AND 9999 AND length(trim(provenance))>0 AND length(trim(category))>0 AND length(trim(description))>0);
ALTER TABLE "ImportedDraft" ADD CHECK(("evidenceBytes" IS NULL AND "evidenceSha" IS NULL AND "evidenceName" IS NULL AND "evidenceMime" IS NULL) OR ("evidenceBytes" IS NOT NULL AND "evidenceSha" IS NOT NULL AND "evidenceName" IS NOT NULL AND "evidenceMime" IN('application/pdf','image/png','image/jpeg') AND octet_length("evidenceBytes") BETWEEN 1 AND 1048576 AND "evidenceSha"=encode(sha256("evidenceBytes"),'hex')));
ALTER TABLE "ImportedDraft" ADD CHECK(kind='RECEIPT' OR ("receiptProvenance" IS NULL AND "receiptCategory" IS NULL AND "receiptReference" IS NULL AND "evidenceBytes" IS NULL));
CREATE FUNCTION caissepro_assert_cash_read(c uuid,u uuid,r uuid,p text) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE a uuid; BEGIN
 IF p NOT IN('ledger:read','receipt:read') THEN RAISE EXCEPTION 'CAISSEPRO_CASH_ACCESS_DENIED' USING ERRCODE='42501'; END IF;
 SELECT "agencyId" INTO a FROM "CashRegister" WHERE "companyId"=c AND id=r;
 PERFORM caissepro_assert_permission(c,u,a,p);
 IF a IS NULL OR NOT EXISTS(SELECT FROM "CashRegisterGrant" g JOIN "CompanyMember" m ON m.id=g."memberId" AND m."companyId"=g."companyId" WHERE g."companyId"=c AND g."cashRegisterId"=r AND g."agencyId"=a AND m."userId"=u AND m.active) THEN RAISE EXCEPTION 'CAISSEPRO_CASH_ACCESS_DENIED' USING ERRCODE='42501'; END IF;
END $$;
GRANT EXECUTE ON FUNCTION caissepro_assert_cash_read(uuid,uuid,uuid,text) TO caissepro_runtime;
CREATE FUNCTION caissepro_assert_company_permission(c uuid,u uuid,p text) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 PERFORM caissepro_assert_session(c,u);
 IF c IS DISTINCT FROM nullif(current_setting('caissepro.company_id',true),'')::uuid OR u IS DISTINCT FROM nullif(current_setting('caissepro.actor_id',true),'')::uuid OR NOT EXISTS(SELECT FROM "CompanyMember" m JOIN "User" usr ON usr.id=m."userId" JOIN "Company" co ON co.id=m."companyId" JOIN "MemberRole" mr ON mr."companyId"=m."companyId" AND mr."memberId"=m.id JOIN "Role" ro ON ro.id=mr."roleId" AND ro."companyId"=m."companyId" JOIN "RolePermission" rp ON rp."roleId"=ro.id AND rp."companyId"=ro."companyId" WHERE m."companyId"=c AND m."userId"=u AND m.active AND usr.active AND co.active AND ro.active AND rp."permissionCode"=p) THEN RAISE EXCEPTION 'CAISSEPRO_ACCESS_DENIED' USING ERRCODE='42501'; END IF;
END $$;
CREATE FUNCTION caissepro_cash_configuration() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF current_user='caissepro_auth_runtime' THEN PERFORM caissepro_assert_company_permission(NEW."companyId",nullif(current_setting('caissepro.actor_id',true),'')::uuid,'cash:configure'); END IF;
 IF TG_TABLE_NAME='CashRegister' AND TG_OP='UPDATE' THEN
  IF ROW(NEW.id,NEW."companyId",NEW."agencyId",NEW.code,NEW."configurationHash") IS DISTINCT FROM ROW(OLD.id,OLD."companyId",OLD."agencyId",OLD.code,OLD."configurationHash") OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'CAISSEPRO_CASH_CONFIGURATION_CONFLICT' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER cash_configuration BEFORE INSERT OR UPDATE ON "CashRegister" FOR EACH ROW EXECUTE FUNCTION caissepro_cash_configuration();
CREATE TRIGGER agency_configuration BEFORE INSERT OR UPDATE ON "Agency" FOR EACH ROW EXECUTE FUNCTION caissepro_cash_configuration();
CREATE TRIGGER account_configuration BEFORE INSERT ON "TreasuryAccount" FOR EACH ROW EXECUTE FUNCTION caissepro_cash_configuration();
CREATE OR REPLACE FUNCTION caissepro_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."actorId" IS DISTINCT FROM nullif(current_setting('caissepro.actor_id',true),'')::uuid OR NEW.action NOT IN('OPERATION_POSTED','EXPENSE_REQUESTED','EXPENSE_APPROVED','EXPENSE_REJECTED','DRAFT_RECEIVED','CASH_CONFIGURED','AGENCY_CONFIGURED') OR NEW."targetType" NOT IN('OPERATION','EXPENSE','DRAFT','CASH','AGENCY') THEN RAISE EXCEPTION 'CAISSEPRO_AUDIT_INVALID' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE FUNCTION caissepro_confirmed_draft_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF EXISTS(SELECT FROM "CashReceipt" WHERE "companyId"=OLD."companyId" AND "sourceDraftId"=OLD.id) THEN RAISE EXCEPTION 'CAISSEPRO_DRAFT_ALREADY_CONFIRMED' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER confirmed_draft BEFORE UPDATE ON "ImportedDraft" FOR EACH ROW EXECUTE FUNCTION caissepro_confirmed_draft_guard();
CREATE FUNCTION caissepro_counter_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (TG_OP='INSERT' AND NEW."lastSequence"<>1) OR (TG_OP='UPDATE' AND (ROW(NEW."companyId",NEW.year) IS DISTINCT FROM ROW(OLD."companyId",OLD.year) OR NEW."lastSequence"<>OLD."lastSequence"+1)) THEN RAISE EXCEPTION 'CAISSEPRO_RECEIPT_SEQUENCE_INVALID' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER receipt_counter_guard BEFORE INSERT OR UPDATE ON "ReceiptCounter" FOR EACH ROW EXECUTE FUNCTION caissepro_counter_guard();
CREATE FUNCTION caissepro_receipt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE d "ImportedDraft"; o "FinancialOperation"; c "Company"; a "Agency"; r "CashRegister"; usr "User"; v bigint; BEGIN
 PERFORM caissepro_assert_cash_permission(NEW."companyId",NEW."createdById",NEW."cashRegisterId",'receipt:post');
 SELECT * INTO d FROM "ImportedDraft" WHERE "companyId"=NEW."companyId" AND id=NEW."sourceDraftId";
 SELECT * INTO o FROM "FinancialOperation" WHERE "companyId"=NEW."companyId" AND id=NEW."operationId";
 SELECT * INTO c FROM "Company" WHERE id=NEW."companyId";
 SELECT * INTO a FROM "Agency" WHERE "companyId"=NEW."companyId" AND id=NEW."agencyId";
 SELECT * INTO r FROM "CashRegister" WHERE "companyId"=NEW."companyId" AND id=NEW."cashRegisterId";
 SELECT * INTO usr FROM "User" WHERE id=NEW."createdById";
 SELECT "lastSequence" INTO v FROM "ReceiptCounter" WHERE "companyId"=NEW."companyId" AND year=NEW.year;
 IF d.id IS NULL OR o.id IS NULL OR c.id IS NULL OR a.id IS NULL OR r.id IS NULL OR usr.id IS NULL OR d.kind<>'RECEIPT' OR o.kind<>'RECEIPT' OR o."transactionId"<>txid_current() OR o."idempotencyKey"<>d.id OR NEW.year<>extract(year FROM o."postedAt" AT TIME ZONE 'UTC') OR NEW.sequence IS DISTINCT FROM v
  OR ROW(NEW."createdById",NEW."agencyId",NEW."cashRegisterId",NEW."clientDraftId",NEW.currency,NEW.amount,NEW.provenance,NEW.category,NEW.description,NEW.reference,NEW."sourceVersion",NEW."evidenceName",NEW."evidenceMime",NEW."evidenceSha",NEW."evidenceBytes",NEW."evidenceByteLength") IS DISTINCT FROM ROW(d."authorId",d."agencyId",d."cashRegisterId",d."clientDraftId",d.currency,d.amount,d."receiptProvenance",d."receiptCategory",d.description,d."receiptReference",d.version,d."evidenceName",d."evidenceMime",d."evidenceSha",d."evidenceBytes",octet_length(d."evidenceBytes"))
  OR o."createdById"<>NEW."createdById" OR o."agencyId"<>NEW."agencyId" OR o.currency<>NEW.currency THEN RAISE EXCEPTION 'CAISSEPRO_RECEIPT_INVALID' USING ERRCODE='23514'; END IF;
 NEW."postedAt":=o."postedAt"; NEW."companyName":=c.name; NEW."companyCode":=c.code; NEW."agencyName":=a.name; NEW."agencyCode":=a.code; NEW."cashName":=r.name; NEW."cashCode":=r.code; NEW."cashierName":=usr."displayName";
 NEW.number:='REC-'||c.code||'-'||NEW.year::text||'-'||lpad(NEW.sequence::text,greatest(6,length(NEW.sequence::text)),'0');
 RETURN NEW;
END $$;
CREATE TRIGGER receipt_guard BEFORE INSERT ON "CashReceipt" FOR EACH ROW EXECUTE FUNCTION caissepro_receipt_guard();
CREATE TRIGGER receipt_immutable BEFORE UPDATE OR DELETE ON "CashReceipt" FOR EACH ROW EXECUTE FUNCTION caissepro_immutable();
CREATE FUNCTION caissepro_receipt_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF NOT EXISTS(SELECT FROM "LedgerEntry" e JOIN "TreasuryAccount" a ON a.id=e."accountId" AND a."companyId"=e."companyId" WHERE e."companyId"=NEW."companyId" AND e."operationId"=NEW."operationId" AND a."cashRegisterId"=NEW."cashRegisterId" AND e.side='DEBIT' AND e.currency=NEW.currency AND e.amount=NEW.amount) THEN RAISE EXCEPTION 'CAISSEPRO_RECEIPT_INVALID' USING ERRCODE='23514'; END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER receipt_complete AFTER INSERT ON "CashReceipt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION caissepro_receipt_complete();
CREATE FUNCTION caissepro_counter_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF NEW."lastSequence"<>(SELECT coalesce(max(sequence),0) FROM "CashReceipt" WHERE "companyId"=NEW."companyId" AND year=NEW.year) THEN RAISE EXCEPTION 'CAISSEPRO_RECEIPT_SEQUENCE_INVALID' USING ERRCODE='23514'; END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER receipt_counter_complete AFTER INSERT OR UPDATE ON "ReceiptCounter" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION caissepro_counter_complete();
REVOKE ALL ON FUNCTION caissepro_assert_cash_read(uuid,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION caissepro_assert_company_permission(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION caissepro_assert_company_permission(uuid,uuid,text) TO caissepro_auth_runtime;
COMMIT;
