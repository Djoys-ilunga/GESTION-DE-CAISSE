BEGIN;
ALTER TABLE "Company" ADD COLUMN address varchar(300) NOT NULL DEFAULT '', ADD COLUMN phone varchar(60) NOT NULL DEFAULT '', ADD COLUMN email varchar(254) NOT NULL DEFAULT '', ADD COLUMN "taxId" varchar(100) NOT NULL DEFAULT '', ADD COLUMN "settingsVersion" integer NOT NULL DEFAULT 1, ADD COLUMN "sessionMinutes" integer NOT NULL DEFAULT 480, ADD COLUMN "idleMinutes" integer NOT NULL DEFAULT 15, ADD COLUMN "offlineMinutes" integer NOT NULL DEFAULT 15,
 ADD CONSTRAINT company_session_limits CHECK("settingsVersion">0 AND "sessionMinutes" BETWEEN 15 AND 480 AND "idleMinutes" BETWEEN 1 AND 15 AND "offlineMinutes" BETWEEN 0 AND 15 AND "idleMinutes"<="sessionMinutes" AND "offlineMinutes"<="idleMinutes");
ALTER TABLE "Agency" ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE "ExpenseRequest" ADD COLUMN category varchar(80) NOT NULL DEFAULT 'Dépenses non catégorisées';
CREATE FUNCTION caissepro_expense_category_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.category IS DISTINCT FROM OLD.category THEN RAISE EXCEPTION 'CAISSEPRO_IMMUTABLE'; END IF; RETURN NEW; END $$;
CREATE TRIGGER expense_category_immutable BEFORE UPDATE ON "ExpenseRequest" FOR EACH ROW EXECUTE FUNCTION caissepro_expense_category_immutable();
CREATE TABLE "FinancialCategory"(id uuid PRIMARY KEY,"companyId" uuid NOT NULL REFERENCES "Company"(id),code varchar(40) NOT NULL,name varchar(80) NOT NULL,kind varchar(10) NOT NULL CHECK(kind IN('RECEIPT','EXPENSE')),active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0), UNIQUE("companyId",code),CHECK(code~'^[A-Z0-9][A-Z0-9_-]{0,39}$' AND length(trim(name))>0));
CREATE TABLE "ReferenceExchangeRate"(id uuid PRIMARY KEY,"companyId" uuid NOT NULL REFERENCES "Company"(id),"fromCurrency" "Currency" NOT NULL,"toCurrency" "Currency" NOT NULL,rate numeric(24,12) NOT NULL CHECK(rate>0),source varchar(100) NOT NULL,"validFrom" timestamptz(3) NOT NULL,"publishedAt" timestamptz(3) NOT NULL DEFAULT now(),"publishedById" uuid NOT NULL REFERENCES "User"(id),CHECK("fromCurrency"<>"toCurrency"));
CREATE INDEX ON "ReferenceExchangeRate"("companyId","validFrom");
CREATE TRIGGER reference_rate_immutable BEFORE UPDATE OR DELETE ON "ReferenceExchangeRate" FOR EACH ROW EXECUTE FUNCTION caissepro_immutable();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['FinancialCategory','ReferenceExchangeRate'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY managed_company ON %I TO caissepro_runtime,caissepro_auth_runtime USING ("companyId"=nullif(current_setting(''caissepro.company_id'',true),'''')::uuid) WITH CHECK ("companyId"=nullif(current_setting(''caissepro.company_id'',true),'''')::uuid)',t);
 END LOOP; END $$;
GRANT SELECT ON "FinancialCategory","ReferenceExchangeRate" TO caissepro_runtime,caissepro_auth_runtime;
GRANT INSERT,UPDATE ON "FinancialCategory" TO caissepro_auth_runtime;
GRANT INSERT ON "ReferenceExchangeRate" TO caissepro_auth_runtime;
GRANT UPDATE(name,address,phone,email,"taxId","settingsVersion","sessionMinutes","idleMinutes","offlineMinutes") ON "Company" TO caissepro_auth_runtime;
GRANT UPDATE(name,active,version) ON "Agency" TO caissepro_auth_runtime;
CREATE FUNCTION caissepro_management_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE c uuid; actor uuid:=nullif(current_setting('caissepro.actor_id',true),'')::uuid; BEGIN
 c:=CASE WHEN TG_TABLE_NAME='Company' THEN NEW.id ELSE NEW."companyId" END;
 PERFORM caissepro_assert_company_permission(c,actor,'cash:configure');
 IF TG_TABLE_NAME='ReferenceExchangeRate' THEN IF NEW."publishedById" IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CAISSEPRO_ACCESS_DENIED'; END IF; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER management_guard BEFORE INSERT OR UPDATE ON "FinancialCategory" FOR EACH ROW EXECUTE FUNCTION caissepro_management_guard();
CREATE TRIGGER management_guard BEFORE INSERT ON "ReferenceExchangeRate" FOR EACH ROW EXECUTE FUNCTION caissepro_management_guard();
-- Company/agency also serve bootstrap and existing directory code. Their updates are checked by the authenticated service transaction.
GRANT EXECUTE ON FUNCTION caissepro_assert_company_permission(uuid,uuid,text) TO caissepro_auth_runtime;
CREATE OR REPLACE FUNCTION caissepro_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."actorId" IS DISTINCT FROM nullif(current_setting('caissepro.actor_id',true),'')::uuid OR NEW.action NOT IN('OPERATION_POSTED','EXPENSE_REQUESTED','EXPENSE_APPROVED','EXPENSE_REJECTED','DRAFT_RECEIVED','CASH_CONFIGURED','AGENCY_CONFIGURED','EXPENSE_POLICY_CONFIGURED','EXPENSE_PAYMENT_CONFIRMED','COMPANY_CONFIGURED','CATEGORY_CONFIGURED','REFERENCE_RATE_PUBLISHED','SESSION_POLICY_CONFIGURED','CASH_SESSION_CLOSED','CASH_SESSION_OPENED','TRANSFER_DRAFT_RECEIVED','TRANSFER_HANDED_OVER','TRANSFER_RECEIVED') OR NEW."targetType" NOT IN('OPERATION','EXPENSE','DRAFT','CASH','AGENCY','COMPANY','CATEGORY','RATE','CLOSURE','TRANSFER') THEN RAISE EXCEPTION 'CAISSEPRO_AUDIT_INVALID' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
COMMIT;
