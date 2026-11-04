BEGIN;
ALTER TABLE "User" ADD CHECK (email=lower(trim(email)));
ALTER TABLE "LedgerEntry" ADD CHECK (amount>0 AND "lineNo">0);
ALTER TABLE "ExpenseRequest" ADD CHECK (amount>0 AND version>0);
ALTER TABLE "ExpenseApproval" ADD CHECK (amount>0);
ALTER TABLE "FundReservation" ADD CHECK (amount>0);
ALTER TABLE "Transfer" ADD CHECK (amount>0 AND "sourceAccountId"<>"destinationAccountId");
ALTER TABLE "ExchangeRate" ADD CHECK (rate>0 AND "fromCurrency"<>"toCurrency");
ALTER TABLE "TreasuryAccount" ADD CHECK ("cashRegisterId" IS NULL OR kind='TREASURY');
ALTER TABLE "ImportedDraft" ADD CHECK (amount>0 AND version>0 AND "payloadHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "FinancialOperation" ADD CHECK ("requestHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "FinancialOperation" ADD CHECK ((kind='DISBURSEMENT')=("expenseRequestId" IS NOT NULL));
ALTER TABLE "FinancialOperation" ADD CHECK ((kind='REVERSAL')=("reversalOfId" IS NOT NULL) AND (kind<>'REVERSAL' OR ("reasonCode" IS NOT NULL AND "reasonCode" ~ '^[A-Z0-9_]{3,80}$')));
ALTER TABLE "FinancialOperation" ADD CHECK ((kind='FX' AND currency IS NULL AND "exchangeRateId" IS NOT NULL AND "sourceAmount" IS NOT NULL AND "targetAmount" IS NOT NULL AND "sourceAmount">0 AND "targetAmount">0) OR (kind<>'FX' AND "exchangeRateId" IS NULL AND "sourceAmount" IS NULL AND "targetAmount" IS NULL));
ALTER TABLE "CashSession" ADD CHECK ((state='OPEN' AND "closedAt" IS NULL AND "closedById" IS NULL) OR (state='CLOSED' AND "closedAt" IS NOT NULL AND "closedAt">="openedAt" AND "closedById" IS NOT NULL));
ALTER TABLE "Attachment" ADD CHECK (("operationId" IS NULL)<>("expenseRequestId" IS NULL) AND "byteLength">0 AND sha256 ~ '^[0-9a-f]{64}$' AND "mimeType" IN ('application/pdf','image/png','image/jpeg'));
CREATE UNIQUE INDEX one_open_session_per_register ON "CashSession"("companyId","cashRegisterId") WHERE state='OPEN';
INSERT INTO "Permission"(code,description) VALUES
 ('directory:read','Consulter le catalogue autorisé'),('ledger:read','Consulter les soldes'),('receipt:post','Comptabiliser un encaissement'),
 ('expense:request','Demander une dépense'),('expense:approve','Approuver une dépense distincte de la sienne'),('expense:pay','Payer une dépense approuvée'),
 ('transfer:post','Comptabiliser un transfert'),('fx:post','Comptabiliser une conversion'),('ledger:reverse','Créer une contre-écriture'),
 ('session:manage','Gérer les sessions de caisse'),('draft:receive','Recevoir un brouillon sans comptabilisation'),('attachment:write','Enregistrer un justificatif autorisé');
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='caissepro_runtime') THEN CREATE ROLE caissepro_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='caissepro_runtime' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN RAISE EXCEPTION 'CAISSEPRO_RUNTIME_ROLE_INVALID'; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO caissepro_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO caissepro_runtime;
GRANT INSERT ON "FinancialOperation","LedgerEntry","ExpenseRequest","ExpenseApproval","FundReservation","Transfer","AuditEvent","Attachment","ImportedDraft","CashSession" TO caissepro_runtime;
GRANT UPDATE ON "ExpenseRequest","FundReservation","ImportedDraft","CashSession" TO caissepro_runtime;
-- Le verrou de ligne exige UPDATE sur une colonne ; son changement reste interdit.
GRANT UPDATE(id) ON "TreasuryAccount" TO caissepro_runtime;
DO $$ DECLARE t text; col text; BEGIN
 FOREACH t IN ARRAY ARRAY['Company','Agency','CompanyMember','Role','MemberRole','RolePermission','AgencyGrant','CashRegister','TreasuryAccount','CashSession','FinancialOperation','LedgerEntry','ExpenseRequest','ExpenseApproval','FundReservation','Transfer','ExchangeRate','Attachment','AuditEvent','ImportedDraft'] LOOP
  col:=CASE WHEN t='Company' THEN 'id' ELSE 'companyId' END;
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (%I=nullif(current_setting(''caissepro.company_id'',true),'''')::uuid) WITH CHECK (%I=nullif(current_setting(''caissepro.company_id'',true),'''')::uuid)',t,col,col);
 END LOOP;
END $$;
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_scope ON "User" USING (EXISTS(SELECT FROM "CompanyMember" m WHERE m."userId"="User".id AND m."companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid));
CREATE FUNCTION caissepro_assert_permission(c uuid,u uuid,a uuid,p text) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF c IS DISTINCT FROM nullif(current_setting('caissepro.company_id',true),'')::uuid OR u IS DISTINCT FROM nullif(current_setting('caissepro.actor_id',true),'')::uuid OR NOT EXISTS(
  SELECT FROM "CompanyMember" m JOIN "User" usr ON usr.id=m."userId" JOIN "Company" co ON co.id=m."companyId"
  JOIN "MemberRole" mr ON mr."companyId"=m."companyId" AND mr."memberId"=m.id
  JOIN "Role" r ON r.id=mr."roleId" AND r."companyId"=m."companyId"
  JOIN "RolePermission" rp ON rp."companyId"=r."companyId" AND rp."roleId"=r.id
  JOIN "AgencyGrant" ag ON ag."companyId"=m."companyId" AND ag."memberId"=m.id
  JOIN "Agency" agency ON agency.id=ag."agencyId" AND agency."companyId"=m."companyId"
  WHERE m."companyId"=c AND m."userId"=u AND m.active AND usr.active AND co.active AND r.active AND agency.active AND agency.id=a AND rp."permissionCode"=p
 ) THEN RAISE EXCEPTION 'CAISSEPRO_ACCESS_DENIED' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION caissepro_assert_permission(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION caissepro_assert_permission(uuid,uuid,uuid,text) TO caissepro_runtime;
CREATE VIEW "AccountBalance" WITH(security_invoker=true) AS SELECT a."companyId",a."agencyId",a.id AS "accountId",a.currency,COALESCE(sum(CASE WHEN e.side='DEBIT' THEN e.amount ELSE -e.amount END),0)::numeric AS balance FROM "TreasuryAccount" a LEFT JOIN "LedgerEntry" e ON e."companyId"=a."companyId" AND e."accountId"=a.id GROUP BY a."companyId",a."agencyId",a.id,a.currency;
CREATE VIEW "AvailableFunds" WITH(security_invoker=true) AS SELECT b.*,COALESCE(r.reserved,0)::numeric AS reserved,(b.balance-COALESCE(r.reserved,0))::numeric AS available FROM "AccountBalance" b LEFT JOIN(SELECT "companyId","accountId",sum(amount) reserved FROM "FundReservation" WHERE state='ACTIVE' GROUP BY "companyId","accountId")r ON r."companyId"=b."companyId" AND r."accountId"=b."accountId";
GRANT SELECT ON "AccountBalance","AvailableFunds" TO caissepro_runtime;
CREATE FUNCTION caissepro_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'CAISSEPRO_IMMUTABLE_RECORD' USING ERRCODE='23514'; END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['FinancialOperation','LedgerEntry','ExpenseApproval','Transfer','ExchangeRate','Attachment','AuditEvent'] LOOP EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION caissepro_immutable()',t); END LOOP; END $$;
CREATE FUNCTION caissepro_operation_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 NEW."transactionId":=txid_current(); NEW."postedAt":=transaction_timestamp();
 PERFORM caissepro_assert_permission(NEW."companyId",NEW."createdById",NEW."agencyId",CASE NEW.kind WHEN 'RECEIPT' THEN 'receipt:post' WHEN 'DISBURSEMENT' THEN 'expense:pay' WHEN 'TRANSFER' THEN 'transfer:post' WHEN 'FX' THEN 'fx:post' ELSE 'ledger:reverse' END);
 IF NEW.kind='REVERSAL' AND NOT EXISTS(SELECT FROM "FinancialOperation" o WHERE o."companyId"=NEW."companyId" AND o.id=NEW."reversalOfId" AND o.currency IS NOT DISTINCT FROM NEW.currency AND o.kind<>'REVERSAL') THEN RAISE EXCEPTION 'CAISSEPRO_REVERSAL_INVALID' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER operation_insert BEFORE INSERT ON "FinancialOperation" FOR EACH ROW EXECUTE FUNCTION caissepro_operation_insert();
CREATE FUNCTION caissepro_entry_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE o "FinancialOperation"; a "TreasuryAccount"; s "CashSession"; BEGIN
 SELECT * INTO o FROM "FinancialOperation" WHERE "companyId"=NEW."companyId" AND id=NEW."operationId";
 IF NOT FOUND OR o."transactionId"<>txid_current() THEN RAISE EXCEPTION 'CAISSEPRO_SEALED_OPERATION' USING ERRCODE='23514'; END IF;
 SELECT * INTO a FROM "TreasuryAccount" WHERE "companyId"=NEW."companyId" AND id=NEW."accountId" FOR UPDATE;
 IF NOT FOUND OR NOT a.active OR a.currency<>NEW.currency THEN RAISE EXCEPTION 'CAISSEPRO_ACCOUNT_INVALID' USING ERRCODE='23514'; END IF;
 PERFORM caissepro_assert_permission(o."companyId",o."createdById",a."agencyId",CASE o.kind WHEN 'RECEIPT' THEN 'receipt:post' WHEN 'DISBURSEMENT' THEN 'expense:pay' WHEN 'TRANSFER' THEN 'transfer:post' WHEN 'FX' THEN 'fx:post' ELSE 'ledger:reverse' END);
 IF a."cashRegisterId" IS NOT NULL THEN
  SELECT * INTO s FROM "CashSession" WHERE "companyId"=NEW."companyId" AND id=NEW."cashSessionId" FOR UPDATE;
  IF NOT FOUND OR s.state<>'OPEN' OR s."cashRegisterId"<>a."cashRegisterId" OR NOT EXISTS(SELECT FROM "CashRegister" cr WHERE cr.id=s."cashRegisterId" AND cr.active) THEN RAISE EXCEPTION 'CAISSEPRO_SESSION_INVALID' USING ERRCODE='23514'; END IF;
 ELSIF NEW."cashSessionId" IS NOT NULL THEN RAISE EXCEPTION 'CAISSEPRO_SESSION_INVALID' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER entry_insert BEFORE INSERT ON "LedgerEntry" FOR EACH ROW EXECUTE FUNCTION caissepro_entry_insert();
CREATE FUNCTION caissepro_check_funds(c uuid,a uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF EXISTS(SELECT FROM "AvailableFunds" f JOIN "TreasuryAccount" ac ON ac.id=f."accountId" AND ac."companyId"=f."companyId" WHERE f."companyId"=c AND f."accountId"=a AND ac.kind='TREASURY' AND (f.balance<0 OR f.available<0)) THEN RAISE EXCEPTION 'CAISSEPRO_INSUFFICIENT_FUNDS' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION caissepro_check_operation(c uuid,op uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE o "FinancialOperation"; ex "ExpenseRequest"; tr "Transfer"; rate "ExchangeRate"; n int; BEGIN
 SELECT * INTO o FROM "FinancialOperation" WHERE "companyId"=c AND id=op;
 SELECT count(*) INTO n FROM "LedgerEntry" WHERE "companyId"=c AND "operationId"=op;
 IF n<2 OR EXISTS(SELECT currency FROM "LedgerEntry" WHERE "companyId"=c AND "operationId"=op GROUP BY currency HAVING sum(CASE WHEN side='DEBIT' THEN amount ELSE -amount END)<>0) THEN RAISE EXCEPTION 'CAISSEPRO_UNBALANCED_OPERATION' USING ERRCODE='23514'; END IF;
 IF o.kind NOT IN ('FX','REVERSAL') AND (o.currency IS NULL OR EXISTS(SELECT FROM "LedgerEntry" WHERE "operationId"=op AND currency<>o.currency)) THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_MISMATCH' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT FROM "AuditEvent" WHERE "companyId"=c AND "targetType"='OPERATION' AND "targetId"=op AND "actorId"=o."createdById" AND action='OPERATION_POSTED') THEN RAISE EXCEPTION 'CAISSEPRO_AUDIT_REQUIRED' USING ERRCODE='23514'; END IF;
 IF o.kind='RECEIPT' AND(n<>2 OR NOT EXISTS(SELECT FROM "LedgerEntry" e JOIN "TreasuryAccount" a ON a.id=e."accountId" WHERE e."operationId"=op AND e.side='DEBIT' AND a.kind='TREASURY' AND a."agencyId"=o."agencyId") OR NOT EXISTS(SELECT FROM "LedgerEntry" e JOIN "TreasuryAccount" a ON a.id=e."accountId" WHERE e."operationId"=op AND e.side='CREDIT' AND a.kind IN ('CLEARING','EQUITY'))) THEN RAISE EXCEPTION 'CAISSEPRO_RECEIPT_INVALID' USING ERRCODE='23514'; END IF;
 IF o.kind='DISBURSEMENT' THEN
  SELECT * INTO ex FROM "ExpenseRequest" WHERE "companyId"=c AND id=o."expenseRequestId";
  IF ex.id IS NULL OR ex.state<>'PAID' OR ex.currency<>o.currency OR ex."agencyId"<>o."agencyId" OR n<>2 OR NOT EXISTS(SELECT FROM "ExpenseApproval" ap WHERE ap."companyId"=c AND ap."expenseRequestId"=ex.id AND ap.decision='APPROVE' AND ap."approverId"<>ex."requestedById" AND ap.amount=ex.amount AND ap.currency=ex.currency) OR NOT EXISTS(SELECT FROM "FundReservation" r WHERE r."companyId"=c AND r."expenseRequestId"=ex.id AND r.state='CONSUMED' AND r.amount=ex.amount) OR NOT EXISTS(SELECT FROM "LedgerEntry" WHERE "operationId"=op AND "accountId"=ex."accountId" AND side='CREDIT' AND amount=ex.amount) OR NOT EXISTS(SELECT FROM "LedgerEntry" e JOIN "TreasuryAccount" a ON a.id=e."accountId" WHERE e."operationId"=op AND e.side='DEBIT' AND a.kind IN ('CLEARING','EQUITY')) THEN RAISE EXCEPTION 'CAISSEPRO_UNAPPROVED_EXPENSE' USING ERRCODE='23514'; END IF;
 END IF;
 IF o.kind='TRANSFER' THEN
  SELECT * INTO tr FROM "Transfer" WHERE "companyId"=c AND "operationId"=op;
  IF tr.id IS NULL OR n<>2 OR tr.currency<>o.currency OR NOT EXISTS(SELECT FROM "LedgerEntry" e JOIN "TreasuryAccount" a ON a.id=e."accountId" WHERE e."operationId"=op AND e."accountId"=tr."sourceAccountId" AND e.side='CREDIT' AND e.amount=tr.amount AND a.kind='TREASURY' AND a."agencyId"=o."agencyId") OR NOT EXISTS(SELECT FROM "LedgerEntry" e JOIN "TreasuryAccount" a ON a.id=e."accountId" WHERE e."operationId"=op AND e."accountId"=tr."destinationAccountId" AND e.side='DEBIT' AND e.amount=tr.amount AND a.kind='TREASURY') THEN RAISE EXCEPTION 'CAISSEPRO_TRANSFER_INVALID' USING ERRCODE='23514'; END IF;
 END IF;
 IF o.kind='FX' THEN
  SELECT * INTO rate FROM "ExchangeRate" WHERE "companyId"=c AND id=o."exchangeRateId";
  IF rate.id IS NULL OR rate."effectiveAt">o."postedAt" OR n<>4 OR o."targetAmount"<>round(o."sourceAmount"*rate.rate,2) OR (SELECT count(DISTINCT currency) FROM "LedgerEntry" WHERE "operationId"=op)<>2 OR (SELECT count(*) FROM "LedgerEntry" e JOIN "TreasuryAccount" a ON a.id=e."accountId" WHERE e."operationId"=op AND a.kind='TREASURY')<>2 OR NOT EXISTS(SELECT FROM "LedgerEntry" e JOIN "TreasuryAccount" a ON a.id=e."accountId" WHERE e."operationId"=op AND a.kind='TREASURY' AND e.side='CREDIT' AND e.currency=rate."fromCurrency" AND e.amount=o."sourceAmount" AND a."agencyId"=o."agencyId") OR NOT EXISTS(SELECT FROM "LedgerEntry" e JOIN "TreasuryAccount" a ON a.id=e."accountId" WHERE e."operationId"=op AND a.kind='TREASURY' AND e.side='DEBIT' AND e.currency=rate."toCurrency" AND e.amount=o."targetAmount") THEN RAISE EXCEPTION 'CAISSEPRO_FX_INVALID' USING ERRCODE='23514'; END IF;
 END IF;
 IF o.kind='REVERSAL' AND EXISTS(SELECT "accountId",currency FROM "LedgerEntry" WHERE "companyId"=c AND "operationId" IN(op,o."reversalOfId") GROUP BY "accountId",currency HAVING sum(CASE WHEN side='DEBIT' THEN amount ELSE -amount END)<>0) THEN RAISE EXCEPTION 'CAISSEPRO_REVERSAL_INVALID' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION caissepro_op_deferred() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM caissepro_check_operation(NEW."companyId",NEW.id); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER operation_complete AFTER INSERT ON "FinancialOperation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION caissepro_op_deferred();
CREATE FUNCTION caissepro_entry_deferred() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM caissepro_check_operation(NEW."companyId",NEW."operationId"); PERFORM caissepro_check_funds(NEW."companyId",NEW."accountId"); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER entry_complete AFTER INSERT ON "LedgerEntry" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION caissepro_entry_deferred();
CREATE FUNCTION caissepro_expense_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  PERFORM caissepro_assert_permission(NEW."companyId",NEW."requestedById",NEW."agencyId",'expense:request');
  IF NEW.state<>'PENDING' OR NEW.version<>1 OR NOT EXISTS(SELECT FROM "TreasuryAccount" WHERE id=NEW."accountId" AND "companyId"=NEW."companyId" AND active AND kind='TREASURY') THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_INVALID' USING ERRCODE='23514'; END IF;
 ELSE
  IF ROW(NEW.id,NEW."companyId",NEW."agencyId",NEW."accountId",NEW."requestedById",NEW.currency,NEW.amount,NEW.description,NEW."createdAt") IS DISTINCT FROM ROW(OLD.id,OLD."companyId",OLD."agencyId",OLD."accountId",OLD."requestedById",OLD.currency,OLD.amount,OLD.description,OLD."createdAt") OR NEW.version<>OLD.version+1 OR NOT((OLD.state='PENDING' AND NEW.state IN('APPROVED','REJECTED','CANCELLED'))OR(OLD.state='APPROVED' AND NEW.state IN('PAID','CANCELLED'))) THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_TRANSITION' USING ERRCODE='23514'; END IF;
  PERFORM caissepro_assert_permission(NEW."companyId",nullif(current_setting('caissepro.actor_id',true),'')::uuid,NEW."agencyId",CASE WHEN NEW.state='PAID' THEN 'expense:pay' ELSE 'expense:approve' END);
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER expense_guard BEFORE INSERT OR UPDATE OR DELETE ON "ExpenseRequest" FOR EACH ROW EXECUTE FUNCTION caissepro_expense_guard();
CREATE FUNCTION caissepro_approval_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE ex "ExpenseRequest"; BEGIN
 SELECT * INTO ex FROM "ExpenseRequest" WHERE "companyId"=NEW."companyId" AND id=NEW."expenseRequestId" FOR UPDATE;
 IF NOT FOUND OR ex.state<>'PENDING' OR ex."requestedById"=NEW."approverId" OR ex.amount<>NEW.amount OR ex.currency<>NEW.currency THEN RAISE EXCEPTION 'CAISSEPRO_APPROVAL_INVALID' USING ERRCODE='23514'; END IF;
 PERFORM caissepro_assert_permission(NEW."companyId",NEW."approverId",ex."agencyId",'expense:approve'); RETURN NEW;
END $$;
CREATE TRIGGER approval_guard BEFORE INSERT ON "ExpenseApproval" FOR EACH ROW EXECUTE FUNCTION caissepro_approval_guard();
CREATE FUNCTION caissepro_reservation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE ex "ExpenseRequest"; BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CAISSEPRO_RESERVATION_IMMUTABLE' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM "TreasuryAccount" WHERE "companyId"=NEW."companyId" AND id=NEW."accountId" FOR UPDATE;
 SELECT * INTO ex FROM "ExpenseRequest" WHERE "companyId"=NEW."companyId" AND id=NEW."expenseRequestId";
 IF NOT FOUND OR ex."accountId"<>NEW."accountId" OR ex.currency<>NEW.currency OR ex.amount<>NEW.amount THEN RAISE EXCEPTION 'CAISSEPRO_RESERVATION_INVALID' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN IF NEW.state<>'ACTIVE' THEN RAISE EXCEPTION 'CAISSEPRO_RESERVATION_INVALID' USING ERRCODE='23514'; END IF;
 ELSE IF OLD.state<>'ACTIVE' OR NEW.state NOT IN('CONSUMED','RELEASED') OR ROW(NEW.id,NEW."companyId",NEW."expenseRequestId",NEW."accountId",NEW.currency,NEW.amount,NEW."createdAt") IS DISTINCT FROM ROW(OLD.id,OLD."companyId",OLD."expenseRequestId",OLD."accountId",OLD.currency,OLD.amount,OLD."createdAt") THEN RAISE EXCEPTION 'CAISSEPRO_RESERVATION_IMMUTABLE' USING ERRCODE='23514'; END IF; END IF;
 PERFORM caissepro_assert_permission(NEW."companyId",nullif(current_setting('caissepro.actor_id',true),'')::uuid,ex."agencyId",CASE WHEN NEW.state='CONSUMED' THEN 'expense:pay' ELSE 'expense:approve' END); RETURN NEW;
END $$;
CREATE TRIGGER reservation_guard BEFORE INSERT OR UPDATE OR DELETE ON "FundReservation" FOR EACH ROW EXECUTE FUNCTION caissepro_reservation_guard();
CREATE FUNCTION caissepro_check_expense(c uuid,e uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE ex "ExpenseRequest"; BEGIN
 SELECT * INTO ex FROM "ExpenseRequest" WHERE "companyId"=c AND id=e;
 IF NOT EXISTS(SELECT FROM "AuditEvent" WHERE "companyId"=c AND "targetType"='EXPENSE' AND "targetId"=e AND "actorId"=ex."requestedById" AND action='EXPENSE_REQUESTED') THEN RAISE EXCEPTION 'CAISSEPRO_AUDIT_REQUIRED' USING ERRCODE='23514'; END IF;
 IF ex.state IN('APPROVED','PAID') AND(NOT EXISTS(SELECT FROM "ExpenseApproval" WHERE "companyId"=c AND "expenseRequestId"=e AND decision='APPROVE' AND "approverId"<>ex."requestedById" AND amount=ex.amount AND currency=ex.currency) OR NOT EXISTS(SELECT FROM "FundReservation" WHERE "companyId"=c AND "expenseRequestId"=e AND state=CASE WHEN ex.state='PAID' THEN 'CONSUMED'::"ReservationState" ELSE 'ACTIVE'::"ReservationState" END)) THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_INCOMPLETE' USING ERRCODE='23514'; END IF;
 IF ex.state='PAID' AND NOT EXISTS(SELECT FROM "FinancialOperation" WHERE "companyId"=c AND "expenseRequestId"=e AND kind='DISBURSEMENT') THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_INCOMPLETE' USING ERRCODE='23514'; END IF;
 IF ex.state='REJECTED' AND NOT EXISTS(SELECT FROM "ExpenseApproval" WHERE "companyId"=c AND "expenseRequestId"=e AND decision='REJECT') THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_INCOMPLETE' USING ERRCODE='23514'; END IF;
 IF ex.state NOT IN('APPROVED','PAID') AND EXISTS(SELECT FROM "FundReservation" WHERE "companyId"=c AND "expenseRequestId"=e AND state<>'RELEASED') THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_INCOMPLETE' USING ERRCODE='23514'; END IF;
 IF ex.state='PENDING' AND EXISTS(SELECT FROM "ExpenseApproval" WHERE "companyId"=c AND "expenseRequestId"=e) THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_INCOMPLETE' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION caissepro_expense_deferred() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM caissepro_check_expense(NEW."companyId",NEW.id); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER expense_complete AFTER INSERT OR UPDATE ON "ExpenseRequest" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION caissepro_expense_deferred();
CREATE FUNCTION caissepro_reservation_deferred() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM caissepro_check_expense(NEW."companyId",NEW."expenseRequestId"); PERFORM caissepro_check_funds(NEW."companyId",NEW."accountId"); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER reservation_complete AFTER INSERT OR UPDATE ON "FundReservation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION caissepro_reservation_deferred();
CREATE FUNCTION caissepro_approval_deferred() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM caissepro_check_expense(NEW."companyId",NEW."expenseRequestId"); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER approval_complete AFTER INSERT ON "ExpenseApproval" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION caissepro_approval_deferred();
CREATE FUNCTION caissepro_session_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CAISSEPRO_SESSION_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'OPEN' THEN RAISE EXCEPTION 'CAISSEPRO_SESSION_INVALID' USING ERRCODE='23514'; END IF;
  PERFORM caissepro_assert_permission(NEW."companyId",NEW."openedById",NEW."agencyId",'session:manage');
 ELSE
  IF OLD.state<>'OPEN' OR NEW.state<>'CLOSED' OR ROW(NEW.id,NEW."companyId",NEW."agencyId",NEW."cashRegisterId",NEW."openedById",NEW."openedAt") IS DISTINCT FROM ROW(OLD.id,OLD."companyId",OLD."agencyId",OLD."cashRegisterId",OLD."openedById",OLD."openedAt") THEN RAISE EXCEPTION 'CAISSEPRO_SESSION_IMMUTABLE' USING ERRCODE='23514'; END IF;
  PERFORM caissepro_assert_permission(NEW."companyId",NEW."closedById",NEW."agencyId",'session:manage');
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER session_guard BEFORE INSERT OR UPDATE OR DELETE ON "CashSession" FOR EACH ROW EXECUTE FUNCTION caissepro_session_guard();
CREATE FUNCTION caissepro_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW."companyId",NEW."agencyId",NEW."cashRegisterId",NEW.currency,NEW.kind) IS DISTINCT FROM ROW(OLD.id,OLD."companyId",OLD."agencyId",OLD."cashRegisterId",OLD.currency,OLD.kind) THEN RAISE EXCEPTION 'CAISSEPRO_ACCOUNT_IMMUTABLE' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER account_guard BEFORE UPDATE ON "TreasuryAccount" FOR EACH ROW EXECUTE FUNCTION caissepro_account_guard();
CREATE FUNCTION caissepro_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."actorId" IS DISTINCT FROM nullif(current_setting('caissepro.actor_id',true),'')::uuid OR NEW.action NOT IN('OPERATION_POSTED','EXPENSE_REQUESTED','EXPENSE_APPROVED','EXPENSE_REJECTED','DRAFT_RECEIVED') OR NEW."targetType" NOT IN('OPERATION','EXPENSE','DRAFT') THEN RAISE EXCEPTION 'CAISSEPRO_AUDIT_INVALID' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER audit_guard BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION caissepro_audit_guard();
CREATE FUNCTION caissepro_draft_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 PERFORM caissepro_assert_permission(NEW."companyId",NEW."authorId",NEW."agencyId",'draft:receive');
 IF TG_OP='UPDATE' AND(ROW(NEW.id,NEW."companyId",NEW."agencyId",NEW."authorId",NEW."clientDraftId",NEW.kind,NEW."receivedAt") IS DISTINCT FROM ROW(OLD.id,OLD."companyId",OLD."agencyId",OLD."authorId",OLD."clientDraftId",OLD.kind,OLD."receivedAt") OR NEW.version<=OLD.version) THEN RAISE EXCEPTION 'CAISSEPRO_DRAFT_CONFLICT' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER draft_guard BEFORE INSERT OR UPDATE ON "ImportedDraft" FOR EACH ROW EXECUTE FUNCTION caissepro_draft_guard();
CREATE FUNCTION caissepro_attachment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE a uuid; BEGIN
 IF NEW."operationId" IS NOT NULL THEN SELECT "agencyId" INTO a FROM "FinancialOperation" WHERE "companyId"=NEW."companyId" AND id=NEW."operationId"; ELSE SELECT "agencyId" INTO a FROM "ExpenseRequest" WHERE "companyId"=NEW."companyId" AND id=NEW."expenseRequestId"; END IF;
 IF a IS NULL THEN RAISE EXCEPTION 'CAISSEPRO_ATTACHMENT_TARGET' USING ERRCODE='23514'; END IF;
 PERFORM caissepro_assert_permission(NEW."companyId",NEW."uploadedById",a,'attachment:write'); RETURN NEW;
END $$;
CREATE TRIGGER attachment_guard BEFORE INSERT ON "Attachment" FOR EACH ROW EXECUTE FUNCTION caissepro_attachment_guard();
COMMIT;
