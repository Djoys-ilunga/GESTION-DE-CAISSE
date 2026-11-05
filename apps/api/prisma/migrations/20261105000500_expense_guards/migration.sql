BEGIN;
CREATE OR REPLACE FUNCTION caissepro_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."actorId" IS DISTINCT FROM nullif(current_setting('caissepro.actor_id',true),'')::uuid OR NEW.action NOT IN('OPERATION_POSTED','EXPENSE_REQUESTED','EXPENSE_APPROVED','EXPENSE_REJECTED','DRAFT_RECEIVED','CASH_CONFIGURED','AGENCY_CONFIGURED','EXPENSE_POLICY_CONFIGURED','EXPENSE_PAYMENT_CONFIRMED') OR NEW."targetType" NOT IN('OPERATION','EXPENSE','DRAFT','CASH','AGENCY','COMPANY') THEN RAISE EXCEPTION 'CAISSEPRO_AUDIT_INVALID' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
GRANT EXECUTE ON FUNCTION caissepro_assert_company_permission(uuid,uuid,text) TO caissepro_runtime;
GRANT SELECT,INSERT,UPDATE ON "ExpensePolicy","VoucherCounter" TO caissepro_runtime;
GRANT SELECT,INSERT ON "ExpenseEvidence","PaymentVoucher" TO caissepro_runtime;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['ExpensePolicy','ExpenseEvidence','VoucherCounter','PaymentVoucher'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO caissepro_runtime USING("companyId"=nullif(current_setting(''caissepro.company_id'',true),'''')::uuid) WITH CHECK("companyId"=nullif(current_setting(''caissepro.company_id'',true),'''')::uuid)',t);
END LOOP; END $$;
ALTER TABLE "ExpensePolicy" ADD CHECK(version>0 AND "payloadHash" ~ '^[a-f0-9]{64}$' AND jsonb_typeof(limits)='array' AND jsonb_array_length(limits)<=18);
ALTER TABLE "VoucherCounter" ADD CHECK(year BETWEEN 2000 AND 9999 AND "lastSequence">0);
ALTER TABLE "PaymentVoucher" ADD CHECK(amount>0 AND sequence>0 AND year BETWEEN 2000 AND 9999 AND length(trim(beneficiary))>0);
ALTER TABLE "ImportedDraft" ADD CHECK("expenseDetails" IS NULL OR (kind='EXPENSE_REQUEST' AND jsonb_typeof("expenseDetails")='object'));
ALTER TABLE "ExpenseRequest" ADD CHECK(("sourceDraftId" IS NULL AND "sourceVersion" IS NULL AND "workflowTransaction" IS NULL) OR ("sourceDraftId" IS NOT NULL AND "sourceVersion" IS NOT NULL AND "sourceVersion">0 AND "workflowTransaction" IS NOT NULL AND beneficiary IS NOT NULL AND length(trim(beneficiary))>0 AND reference IS NOT NULL));
ALTER TABLE "ExpenseEvidence" ADD CHECK("byteLength"=octet_length(bytes) AND ordinal BETWEEN 1 AND 3 AND length(trim("fileName"))>0 AND "fileName" !~ '[/\\]' AND octet_length(bytes) BETWEEN 1 AND 1048576 AND sha256=encode(sha256(bytes),'hex') AND CASE "mimeType"
 WHEN 'application/pdf' THEN substring(bytes FROM 1 FOR 5)=decode('255044462d','hex')
 WHEN 'image/png' THEN substring(bytes FROM 1 FOR 8)=decode('89504e470d0a1a0a','hex')
 WHEN 'image/jpeg' THEN substring(bytes FROM 1 FOR 3)=decode('ffd8ff','hex') ELSE false END);
CREATE FUNCTION caissepro_expense_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE item jsonb; seen text[]:='{}'; k text; BEGIN
 PERFORM caissepro_assert_company_permission(NEW."companyId",nullif(current_setting('caissepro.actor_id',true),'')::uuid,'cash:configure');
 IF NEW."configuredById" IS DISTINCT FROM nullif(current_setting('caissepro.actor_id',true),'')::uuid OR (TG_OP='INSERT' AND NEW.version<>1) THEN RAISE EXCEPTION 'CAISSEPRO_POLICY_INVALID' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW."companyId",NEW.currency) IS DISTINCT FROM ROW(OLD."companyId",OLD.currency) OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'CAISSEPRO_POLICY_CONFLICT' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(NEW.limits) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'CAISSEPRO_POLICY_INVALID' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.limits) LOOP
  k:=(item->>'role')||':'||(item->>'action');
  IF (item->>'role') IS NULL OR (item->>'role') NOT IN('ADMINISTRATOR','DIRECTOR','FINANCE_MANAGER','ACCOUNTANT','CASHIER','AUDITOR') OR (item->>'action') IS NULL OR (item->>'action') NOT IN('REQUEST','APPROVE','PAY') OR (item->>'maximum') IS NULL OR (item->>'maximum') !~ '^(0|[1-9][0-9]{0,15})\.[0-9]{2}$' OR (item->>'maximum')::numeric<=0 OR k=ANY(seen) THEN RAISE EXCEPTION 'CAISSEPRO_POLICY_INVALID' USING ERRCODE='23514'; END IF;
  seen:=array_append(seen,k);
 END LOOP;
 NEW."configuredAt":=transaction_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER expense_policy_guard BEFORE INSERT OR UPDATE ON "ExpensePolicy" FOR EACH ROW EXECUTE FUNCTION caissepro_expense_policy_guard();

-- Les plafonds ne donnent jamais une permission : les deux conditions sont exigées.
CREATE FUNCTION caissepro_assert_expense_limit(c uuid,u uuid,cur "Currency",act text,total numeric) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE pol "ExpensePolicy"; BEGIN
 SELECT * INTO pol FROM "ExpensePolicy" WHERE "companyId"=c AND currency=cur FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_POLICY_REQUIRED' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT FROM "CompanyMember" m JOIN "MemberRole" mr ON mr."companyId"=m."companyId" AND mr."memberId"=m.id JOIN "Role" r ON r."companyId"=mr."companyId" AND r.id=mr."roleId" JOIN "RolePermission" rp ON rp."companyId"=r."companyId" AND rp."roleId"=r.id CROSS JOIN LATERAL jsonb_array_elements(pol.limits) lim WHERE m."companyId"=c AND m."userId"=u AND m.active AND r.active AND lim->>'role'=r.code AND lim->>'action'=act AND (lim->>'maximum')::numeric>=total AND rp."permissionCode"=CASE act WHEN 'REQUEST' THEN 'expense:request' WHEN 'APPROVE' THEN 'expense:approve' WHEN 'PAY' THEN 'expense:pay' ELSE '' END) THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_LIMIT_EXCEEDED' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION caissepro_assert_expense_limit(uuid,uuid,"Currency",text,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION caissepro_assert_expense_limit(uuid,uuid,"Currency",text,numeric) TO caissepro_runtime;

CREATE FUNCTION caissepro_expense_workflow_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE d "ImportedDraft"; BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW."sourceDraftId",NEW."sourceVersion",NEW.beneficiary,NEW.reference,NEW."workflowTransaction") IS DISTINCT FROM ROW(OLD."sourceDraftId",OLD."sourceVersion",OLD.beneficiary,OLD.reference,OLD."workflowTransaction") THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NEW."sourceDraftId" IS NOT NULL THEN
  IF TG_OP='INSERT' THEN
   SELECT * INTO d FROM "ImportedDraft" WHERE "companyId"=NEW."companyId" AND id=NEW."sourceDraftId" FOR UPDATE;
   IF NOT FOUND OR d.kind<>'EXPENSE_REQUEST' OR d."authorId"<>NEW."requestedById" OR d."authorId" IS DISTINCT FROM nullif(current_setting('caissepro.actor_id',true),'')::uuid OR d.version<>NEW."sourceVersion" OR d."agencyId"<>NEW."agencyId" OR d.amount<>NEW.amount OR d.currency<>NEW.currency OR d.description<>NEW.description OR d."expenseDetails" IS NULL OR (d."expenseDetails"->>'beneficiary') IS DISTINCT FROM NEW.beneficiary OR (d."expenseDetails"->>'reference') IS DISTINCT FROM NEW.reference OR NOT EXISTS(SELECT FROM "TreasuryAccount" a WHERE a.id=NEW."accountId" AND a."companyId"=NEW."companyId" AND a."cashRegisterId"=d."cashRegisterId") THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_SOURCE_INVALID' USING ERRCODE='23514'; END IF;
   PERFORM caissepro_assert_expense_limit(NEW."companyId",NEW."requestedById",NEW.currency,'REQUEST',NEW.amount);
   NEW."workflowTransaction":=txid_current();
  ELSIF NEW.state='PAID' THEN
   PERFORM caissepro_assert_expense_limit(NEW."companyId",nullif(current_setting('caissepro.actor_id',true),'')::uuid,NEW.currency,'PAY',NEW.amount);
  END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER expense_workflow_guard BEFORE INSERT OR UPDATE ON "ExpenseRequest" FOR EACH ROW EXECUTE FUNCTION caissepro_expense_workflow_guard();
CREATE FUNCTION caissepro_expense_decision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE ex "ExpenseRequest"; BEGIN
 SELECT * INTO ex FROM "ExpenseRequest" WHERE "companyId"=NEW."companyId" AND id=NEW."expenseRequestId";
 IF ex."sourceDraftId" IS NOT NULL THEN
  IF NEW.decision='REJECT' AND (NEW.reason IS NULL OR length(trim(NEW.reason))<3) THEN RAISE EXCEPTION 'CAISSEPRO_REJECTION_REASON_REQUIRED' USING ERRCODE='23514'; END IF;
  IF NEW.decision='APPROVE' THEN PERFORM caissepro_assert_expense_limit(NEW."companyId",NEW."approverId",ex.currency,'APPROVE',ex.amount); END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER expense_decision_guard BEFORE INSERT ON "ExpenseApproval" FOR EACH ROW EXECUTE FUNCTION caissepro_expense_decision_guard();
CREATE FUNCTION caissepro_submitted_draft_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF EXISTS(SELECT FROM "ExpenseRequest" e WHERE e."companyId"=OLD."companyId" AND e."sourceDraftId"=OLD.id) THEN RAISE EXCEPTION 'CAISSEPRO_DRAFT_ALREADY_SUBMITTED' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER submitted_draft_guard BEFORE UPDATE OR DELETE ON "ImportedDraft" FOR EACH ROW EXECUTE FUNCTION caissepro_submitted_draft_guard();

CREATE FUNCTION caissepro_expense_evidence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE ex "ExpenseRequest"; doc jsonb; BEGIN
 SELECT * INTO ex FROM "ExpenseRequest" WHERE "companyId"=NEW."companyId" AND id=NEW."expenseRequestId";
 IF ex."sourceDraftId" IS NULL OR ex."workflowTransaction"<>txid_current() OR ex.state<>'PENDING' THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_EVIDENCE_INVALID' USING ERRCODE='23514'; END IF;
 SELECT d."expenseDetails"->'documents'->(NEW.ordinal-1) INTO doc FROM "ImportedDraft" d WHERE d."companyId"=NEW."companyId" AND d.id=ex."sourceDraftId";
 IF doc IS NULL OR doc->>'fileName' IS DISTINCT FROM NEW."fileName" OR doc->>'mimeType' IS DISTINCT FROM NEW."mimeType" OR decode(doc->>'dataBase64','base64') IS DISTINCT FROM NEW.bytes THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_EVIDENCE_INVALID' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER expense_evidence_guard BEFORE INSERT ON "ExpenseEvidence" FOR EACH ROW EXECUTE FUNCTION caissepro_expense_evidence_guard();
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON "ExpenseEvidence" FOR EACH ROW EXECUTE FUNCTION caissepro_immutable();
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON "PaymentVoucher" FOR EACH ROW EXECUTE FUNCTION caissepro_immutable();
CREATE FUNCTION caissepro_payment_voucher_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE ex "ExpenseRequest"; op "FinancialOperation"; ap "ExpenseApproval"; BEGIN
 SELECT * INTO ex FROM "ExpenseRequest" WHERE "companyId"=NEW."companyId" AND id=NEW."expenseRequestId";
 SELECT * INTO op FROM "FinancialOperation" WHERE "companyId"=NEW."companyId" AND id=NEW."operationId";
 SELECT * INTO ap FROM "ExpenseApproval" WHERE "companyId"=NEW."companyId" AND "expenseRequestId"=ex.id;
 IF ex.id IS NULL OR op.id IS NULL OR ap.id IS NULL OR ex.state<>'PAID' OR ex."sourceDraftId" IS NULL OR op.kind<>'DISBURSEMENT' OR op."expenseRequestId"<>ex.id OR op."transactionId"<>txid_current() OR NEW."createdById"<>op."createdById" OR NEW.currency<>ex.currency OR NEW.amount<>ex.amount OR NEW.beneficiary IS DISTINCT FROM ex.beneficiary OR NEW.description<>ex.description OR NEW.reference IS DISTINCT FROM ex.reference OR NEW."approvedAt"<>ap."createdAt" OR NEW."postedAt"<>op."postedAt" OR NEW.year<>extract(year FROM op."postedAt" AT TIME ZONE 'Africa/Kinshasa')::int OR NEW.number<>('BON-'||NEW."companyCode"||'-'||NEW.year||'-'||lpad(NEW.sequence::text,greatest(6,length(NEW.sequence::text)), '0')) OR NOT EXISTS(SELECT FROM "VoucherCounter" WHERE "companyId"=NEW."companyId" AND year=NEW.year AND "lastSequence"=NEW.sequence) THEN RAISE EXCEPTION 'CAISSEPRO_PAYMENT_VOUCHER_INVALID' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER payment_voucher_guard BEFORE INSERT ON "PaymentVoucher" FOR EACH ROW EXECUTE FUNCTION caissepro_payment_voucher_guard();
CREATE FUNCTION caissepro_voucher_counter_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF NEW."lastSequence"<>(SELECT coalesce(max(sequence),0) FROM "PaymentVoucher" WHERE "companyId"=NEW."companyId" AND year=NEW.year) THEN RAISE EXCEPTION 'CAISSEPRO_VOUCHER_SEQUENCE_INVALID' USING ERRCODE='23514'; END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER voucher_counter_complete AFTER INSERT OR UPDATE ON "VoucherCounter" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION caissepro_voucher_counter_complete();
CREATE FUNCTION caissepro_expense_workflow_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE n int; total int; expected int; required boolean; BEGIN
 IF NEW."sourceDraftId" IS NOT NULL THEN
  SELECT count(*),coalesce(sum(octet_length(bytes)),0) INTO n,total FROM "ExpenseEvidence" WHERE "companyId"=NEW."companyId" AND "expenseRequestId"=NEW.id;
  -- Le brouillon privé reste visible uniquement par son auteur. Sa copie est
  -- vérifiée et scellée à la soumission ; l'approbateur n'en relit pas le cache.
  IF TG_OP='INSERT' THEN
   SELECT jsonb_array_length(d."expenseDetails"->'documents') INTO expected FROM "ImportedDraft" d WHERE d."companyId"=NEW."companyId" AND d.id=NEW."sourceDraftId";
   SELECT "requireEvidence" INTO required FROM "ExpensePolicy" WHERE "companyId"=NEW."companyId" AND currency=NEW.currency;
   IF n IS DISTINCT FROM expected OR (required AND n=0) THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_WORKFLOW_INCOMPLETE' USING ERRCODE='23514'; END IF;
  END IF;
  IF n>3 OR total>1048576 OR (NEW.state='PAID' AND NOT EXISTS(SELECT FROM "PaymentVoucher" WHERE "companyId"=NEW."companyId" AND "expenseRequestId"=NEW.id)) THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_WORKFLOW_INCOMPLETE' USING ERRCODE='23514'; END IF;
 END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER expense_workflow_complete AFTER INSERT OR UPDATE ON "ExpenseRequest" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION caissepro_expense_workflow_complete();
COMMIT;
