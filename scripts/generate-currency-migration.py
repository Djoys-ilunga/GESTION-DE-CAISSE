"""Build the new migration from frozen historical function bodies, never edit them."""
from pathlib import Path
import json
import re
import sys

root = Path(__file__).resolve().parents[1]
directory = root / "apps/api/prisma/migrations/20261111000100_extensible_currencies"
directory.mkdir(exist_ok=True)
catalog = json.loads((root / "data/initial-currencies.json").read_text())
functions = {}
for file in sorted((root / "apps/api/prisma/migrations").glob("*/migration.sql")):
    if file.parent.name >= directory.name:
        continue
    for match in re.finditer(r"CREATE(?: OR REPLACE)? FUNCTION\s+(\w+)\b[^$]*?\$\$.*?\$\$;", file.read_text(), re.S):
        functions[match[1]] = match[0].replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION", 1)

prefix = """-- Stage 12: schema evolution only. No UPDATE of posted monetary values or snapshots.
BEGIN;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtext('caissepro-currency-schema-v2'));
CREATE TEMP TABLE cp_currency_constraints ON COMMIT DROP AS
 SELECT conrelid::regclass::text AS relation,conname,contype,pg_get_constraintdef(oid) AS definition
 FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype IN('f','c');
CREATE TEMP TABLE cp_currency_views ON COMMIT DROP AS
 SELECT relname,pg_get_viewdef(oid) AS definition,pg_get_userbyid(relowner) AS owner,coalesce(relacl,acldefault('r',relowner)) AS acl FROM pg_class
 WHERE relnamespace='public'::regnamespace AND relname IN('AccountBalance','AvailableFunds');
DROP VIEW "AvailableFunds";
DROP VIEW "AccountBalance";
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM cp_currency_constraints LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.relation,r.conname); END LOOP;
END $$;
-- The sole historical function with a Currency argument is rebound to a text domain.
DROP FUNCTION caissepro_assert_expense_limit(uuid,uuid,"Currency",text,numeric);
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT c.oid::regclass AS relation,a.attname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND a.atttypid='"Currency"'::regtype LOOP
  EXECUTE format('ALTER TABLE %s ALTER COLUMN %I TYPE text USING %I::text',r.relation,r.attname,r.attname);
 END LOOP;
 FOR r IN SELECT c.oid::regclass AS relation,a.attname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='numeric(18,2)' LOOP
  EXECUTE format('ALTER TABLE %s ALTER COLUMN %I TYPE numeric(24,8)',r.relation,r.attname);
 END LOOP;
END $$;
DROP TYPE "Currency";
-- Compatibility for existing SQL argument casts; column identifiers are data-driven text.
CREATE DOMAIN "Currency" AS text CHECK(VALUE~'^[A-Z]{3}$');
CREATE TABLE "CurrencyDefinition"(code text PRIMARY KEY CHECK(code~'^[A-Z]{3}$'),"numericCode" varchar(3) NOT NULL CHECK("numericCode"~'^[0-9]{3}$'),name varchar(160) NOT NULL,symbol varchar(20) NOT NULL,"precision" integer NOT NULL CHECK("precision" BETWEEN 0 AND 4),active boolean NOT NULL DEFAULT true,"bccRateStatus" varchar(16) NOT NULL DEFAULT 'UNVERIFIED' CHECK("bccRateStatus" IN('UNVERIFIED','AVAILABLE','UNAVAILABLE')),"sourceDate" varchar(10) NOT NULL);
"""
for row in catalog:
    values = [row[k] for k in ['code','numericCode','name','symbol','precision','active','bccRateStatus','sourceDate']]
    quoted = [str(v).lower() if isinstance(v, (bool, int)) else "'" + v.replace("'", "''") + "'" for v in values]
    prefix += 'INSERT INTO "CurrencyDefinition" VALUES (' + ','.join(quoted) + ');\n'

core = """
CREATE TABLE "CompanyCurrency"("companyId" uuid NOT NULL REFERENCES "Company"(id),code text NOT NULL REFERENCES "CurrencyDefinition"(code),active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),PRIMARY KEY("companyId",code));
CREATE TABLE "CompanyMonetarySettings"("companyId" uuid PRIMARY KEY REFERENCES "Company"(id),"reportingCurrency" text,version integer NOT NULL DEFAULT 1 CHECK(version>0),FOREIGN KEY("companyId","reportingCurrency") REFERENCES "CompanyCurrency"("companyId",code));
CREATE TABLE "UserMoneyPreference"("companyId" uuid NOT NULL,"userId" uuid NOT NULL,"displayCurrency" text,"favoriteCurrency" text,locale varchar(10) NOT NULL DEFAULT 'fr-FR' CHECK(locale IN('fr-FR','fr-CD','en-US','en-GB')),version integer NOT NULL DEFAULT 1 CHECK(version>0),PRIMARY KEY("companyId","userId"),FOREIGN KEY("companyId","userId") REFERENCES "CompanyMember"("companyId","userId"),FOREIGN KEY("companyId","displayCurrency") REFERENCES "CompanyCurrency"("companyId",code),FOREIGN KEY("companyId","favoriteCurrency") REFERENCES "CompanyCurrency"("companyId",code));
INSERT INTO "CompanyCurrency" SELECT id,c,true,1 FROM "Company" CROSS JOIN unnest(ARRAY['CDF','USD']) c;
INSERT INTO "CompanyMonetarySettings"("companyId") SELECT id FROM "Company";
GRANT SELECT ON "CurrencyDefinition" TO caissepro_runtime,caissepro_auth_runtime;
CREATE FUNCTION caissepro_currency_precision(c text) RETURNS integer LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$ DECLARE p integer; BEGIN SELECT "precision" INTO p FROM "CurrencyDefinition" WHERE code=c; IF p IS NULL THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_UNKNOWN'; END IF; RETURN p; END $$;
CREATE FUNCTION caissepro_currency_round(v numeric,c text) RETURNS numeric LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$ SELECT round(v,caissepro_currency_precision(c)) $$;
CREATE FUNCTION caissepro_money_text(v numeric,c text) RETURNS text LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$ SELECT caissepro_currency_round(v,c)::text $$;
CREATE FUNCTION caissepro_money_input_valid(v text,c text) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$ DECLARE p integer:=caissepro_currency_precision(c); BEGIN
 IF v IS NULL OR v!~'^(0|[1-9][0-9]{0,15})(\\.[0-9]{1,4})?$' THEN RETURN false; END IF;
 RETURN (CASE WHEN p=0 THEN position('.' in v)=0 ELSE position('.' in v)>0 AND length(split_part(v,'.',2))=p END);
END $$;
DO $$ DECLARE r record; permission record; BEGIN
 FOR r IN SELECT * FROM cp_currency_constraints ORDER BY contype LOOP
  IF r.relation='"TransferOrder"' AND r.definition LIKE '%round(%' THEN
   r.definition:='CHECK (("sourceCurrency"="destinationCurrency" AND rate IS NULL AND "rateSource"='''' AND amount="targetAmount") OR ("sourceCurrency"<>"destinationCurrency" AND rate IS NOT NULL AND rate>0 AND length(trim("rateSource"))>0 AND "targetAmount"=caissepro_currency_round(amount*rate,"destinationCurrency")))';
  END IF;
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',r.relation,r.conname,r.definition);
 END LOOP;
 FOR r IN SELECT * FROM cp_currency_views ORDER BY CASE relname WHEN 'AccountBalance' THEN 0 ELSE 1 END LOOP
  EXECUTE format('CREATE VIEW %I WITH(security_invoker=true) AS %s',r.relname,r.definition);
  FOR permission IN SELECT e.*,p.rolname FROM aclexplode(r.acl) e LEFT JOIN pg_roles p ON p.oid=e.grantee LOOP
   EXECUTE format('GRANT %s ON %I TO %s%s',permission.privilege_type,r.relname,CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(permission.rolname) END,CASE WHEN permission.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  EXECUTE format('ALTER VIEW %I OWNER TO %I',r.relname,r.owner);
 END LOOP;
END $$;
GRANT SELECT ON "AccountBalance","AvailableFunds" TO caissepro_runtime;
-- Every code-bearing column references the catalog, including historical documents.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN('currency','sourceCurrency','destinationCurrency','fromCurrency','toCurrency') AND table_name NOT IN('AccountBalance','AvailableFunds') LOOP
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(%I) REFERENCES "CurrencyDefinition"(code)',r.table_name,r.table_name||'_'||r.column_name||'_catalog_fk',r.column_name);
 END LOOP;
END $$;
CREATE FUNCTION caissepro_company_currency_defaults() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE previous text:=current_setting('caissepro.company_id',true); BEGIN
 PERFORM set_config('caissepro.company_id',NEW.id::text,true);
 INSERT INTO "CompanyCurrency" VALUES(NEW.id,'CDF',true,1),(NEW.id,'USD',true,1);
 INSERT INTO "CompanyMonetarySettings"("companyId") VALUES(NEW.id);
 PERFORM set_config('caissepro.company_id',coalesce(previous,''),true); RETURN NEW;
END $$;
CREATE TRIGGER monetary_defaults AFTER INSERT ON "Company" FOR EACH ROW EXECUTE FUNCTION caissepro_company_currency_defaults();
CREATE FUNCTION caissepro_currency_active(c uuid,cur text) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 PERFORM 1 FROM "CompanyCurrency" cc JOIN "CurrencyDefinition" d ON d.code=cc.code WHERE cc."companyId"=c AND cc.code=cur AND cc.active AND d.active FOR SHARE OF cc;
 IF NOT FOUND THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_INACTIVE'; END IF;
END $$;
CREATE FUNCTION caissepro_currency_record_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE j jsonb:=to_jsonb(NEW); cur text; k text; val numeric; r "ExchangeRate"; reversal boolean:=false; BEGIN
 IF TG_TABLE_NAME='FinancialOperation' THEN reversal:=j->>'kind'='REVERSAL'; END IF;
 IF TG_TABLE_NAME='LedgerEntry' THEN SELECT kind='REVERSAL' INTO reversal FROM "FinancialOperation" WHERE id=NEW."operationId"; END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN('ExpenseRequest','FundReservation') AND j->>'state' IN('REJECTED','CANCELLED','RELEASED') THEN RETURN NEW; END IF;
 FOR k,cur IN SELECT key,value FROM jsonb_each_text(j) WHERE key IN('currency','sourceCurrency','destinationCurrency','fromCurrency','toCurrency') AND value IS NOT NULL LOOP
  IF NOT reversal AND NOT (TG_TABLE_NAME='ExpenseApproval' AND j->>'decision'='REJECT') THEN PERFORM caissepro_currency_active((j->>'companyId')::uuid,cur); END IF;
 END LOOP;
 IF j->>'currency' IS NOT NULL AND j->>'amount' IS NOT NULL THEN
  val:=(j->>'amount')::numeric; IF abs(val)>=10000000000000000 OR val<>caissepro_currency_round(val,j->>'currency') THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_PRECISION'; END IF;
 END IF;
 IF TG_TABLE_NAME='TransferOrder' THEN
  IF NEW.amount<>caissepro_currency_round(NEW.amount,NEW."sourceCurrency") OR NEW."targetAmount"<>caissepro_currency_round(NEW."targetAmount",NEW."destinationCurrency") OR NEW.amount>=10000000000000000 OR NEW."targetAmount">=10000000000000000 THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_PRECISION'; END IF;
 END IF;
 IF TG_TABLE_NAME='FinancialOperation' AND j->>'kind'='FX' THEN
  SELECT * INTO r FROM "ExchangeRate" WHERE id=NEW."exchangeRateId" AND "companyId"=NEW."companyId";
  IF NEW."sourceAmount"<>caissepro_currency_round(NEW."sourceAmount",r."fromCurrency") OR NEW."targetAmount"<>caissepro_currency_round(NEW."targetAmount",r."toCurrency") THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_PRECISION'; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['TreasuryAccount','FinancialOperation','LedgerEntry','ExpenseRequest','ExpenseApproval','FundReservation','Transfer','ExchangeRate','ImportedDraft','CashReceipt','PaymentVoucher','TransferOrder','ReferenceExchangeRate','ExpensePolicy'] LOOP
 EXECUTE format('CREATE TRIGGER currency_record_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION caissepro_currency_record_guard()',t);
 END LOOP;
END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['TransferOrder','ImportedDraft','ExpensePolicy'] LOOP EXECUTE format('CREATE TRIGGER currency_record_guard_update BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION caissepro_currency_record_guard()',t); END LOOP; END $$;
CREATE FUNCTION caissepro_currency_metadata_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.code IS DISTINCT FROM OLD.code OR NEW."precision" IS DISTINCT FROM OLD."precision" THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_METADATA_IMMUTABLE'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER currency_metadata_guard BEFORE UPDATE OR DELETE ON "CurrencyDefinition" FOR EACH ROW EXECUTE FUNCTION caissepro_currency_metadata_guard();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['CompanyCurrency','CompanyMonetarySettings','UserMoneyPreference'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY monetary_tenant ON %I TO caissepro_runtime,caissepro_auth_runtime USING("companyId"=nullif(current_setting(''caissepro.company_id'',true),'''')::uuid) WITH CHECK("companyId"=nullif(current_setting(''caissepro.company_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
CREATE POLICY preference_owner ON "UserMoneyPreference" AS RESTRICTIVE TO caissepro_runtime,caissepro_auth_runtime USING("userId"=nullif(current_setting('caissepro.actor_id',true),'')::uuid) WITH CHECK("userId"=nullif(current_setting('caissepro.actor_id',true),'')::uuid);
GRANT SELECT ON "CompanyCurrency","CompanyMonetarySettings","UserMoneyPreference" TO caissepro_runtime,caissepro_auth_runtime;
GRANT INSERT,UPDATE ON "CompanyCurrency","CompanyMonetarySettings","UserMoneyPreference" TO caissepro_auth_runtime,caissepro_runtime;
CREATE FUNCTION caissepro_currency_in_use(c uuid,cur text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET row_security=on AS $$
 SELECT c=nullif(current_setting('caissepro.company_id',true),'')::uuid AND (EXISTS(SELECT FROM "FundReservation" WHERE "companyId"=c AND currency=cur AND state='ACTIVE') OR EXISTS(SELECT FROM "TransferOrder" WHERE "companyId"=c AND state='HANDED_OVER' AND ("sourceCurrency"=cur OR "destinationCurrency"=cur)))
$$;
GRANT SELECT ON "FundReservation" TO caissepro_transfer_reader;
CREATE POLICY monetary_reservations ON "FundReservation" FOR SELECT TO caissepro_transfer_reader USING("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid);
GRANT CREATE ON SCHEMA public TO caissepro_transfer_reader;
ALTER FUNCTION caissepro_currency_in_use(uuid,text) OWNER TO caissepro_transfer_reader;
REVOKE CREATE ON SCHEMA public FROM caissepro_transfer_reader;
REVOKE ALL ON FUNCTION caissepro_currency_in_use(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION caissepro_currency_in_use(uuid,text) TO caissepro_runtime,caissepro_auth_runtime;
CREATE FUNCTION caissepro_monetary_configuration_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE actor uuid:=nullif(current_setting('caissepro.actor_id',true),'')::uuid; BEGIN
 IF current_user IN('caissepro_runtime','caissepro_auth_runtime') THEN
  PERFORM caissepro_assert_session(NEW."companyId",actor);
  IF TG_TABLE_NAME='UserMoneyPreference' THEN
   IF NEW."userId" IS DISTINCT FROM actor OR NOT EXISTS(SELECT FROM "CompanyMember" WHERE "companyId"=NEW."companyId" AND "userId"=actor AND active) THEN RAISE EXCEPTION 'CAISSEPRO_ACCESS_DENIED'; END IF;
  ELSE PERFORM caissepro_assert_company_permission(NEW."companyId",actor,'cash:configure'); END IF;
 END IF;
 IF TG_OP='UPDATE' AND (NEW."companyId"<>OLD."companyId" OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'CAISSEPRO_SETTINGS_CONFLICT'; END IF;
 IF TG_TABLE_NAME='UserMoneyPreference' THEN
  IF TG_OP='UPDATE' AND NEW."userId"<>OLD."userId" THEN RAISE EXCEPTION 'CAISSEPRO_ACCESS_DENIED'; END IF;
  IF NEW."displayCurrency" IS NOT NULL THEN PERFORM caissepro_currency_active(NEW."companyId",NEW."displayCurrency"); END IF;
  IF NEW."favoriteCurrency" IS NOT NULL THEN PERFORM caissepro_currency_active(NEW."companyId",NEW."favoriteCurrency"); END IF;
 ELSIF TG_TABLE_NAME='CompanyMonetarySettings' THEN
  IF NEW."reportingCurrency" IS NOT NULL THEN PERFORM caissepro_currency_active(NEW."companyId",NEW."reportingCurrency"); END IF;
 ELSE
  IF TG_OP='UPDATE' AND NEW.code<>OLD.code THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_METADATA_IMMUTABLE'; END IF;
  IF NEW.active AND NOT EXISTS(SELECT FROM "CurrencyDefinition" WHERE code=NEW.code AND active) THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_INACTIVE'; END IF;
  IF NOT NEW.active THEN
   IF NOT EXISTS(SELECT FROM "CompanyCurrency" WHERE "companyId"=NEW."companyId" AND code<>NEW.code AND active) OR caissepro_currency_in_use(NEW."companyId",NEW.code) OR EXISTS(SELECT FROM "CompanyMonetarySettings" WHERE "companyId"=NEW."companyId" AND "reportingCurrency"=NEW.code) THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_IN_USE'; END IF;
  END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER monetary_configuration_guard BEFORE INSERT OR UPDATE ON "CompanyCurrency" FOR EACH ROW EXECUTE FUNCTION caissepro_monetary_configuration_guard();
CREATE TRIGGER monetary_configuration_guard BEFORE INSERT OR UPDATE ON "CompanyMonetarySettings" FOR EACH ROW EXECUTE FUNCTION caissepro_monetary_configuration_guard();
CREATE TRIGGER monetary_configuration_guard BEFORE INSERT OR UPDATE ON "UserMoneyPreference" FOR EACH ROW EXECUTE FUNCTION caissepro_monetary_configuration_guard();
"""

patched = []
for name in ['caissepro_assert_expense_limit','caissepro_check_operation','caissepro_expense_policy_guard','caissepro_transfer_order_guard','caissepro_closure_guard','caissepro_audit_guard']:
    source = functions[name]
    source = source.replace('round(o."sourceAmount"*rate.rate,2)', 'caissepro_currency_round(o."sourceAmount"*rate.rate,rate."toCurrency")')
    source = source.replace("'HALF_UP_2'", "'HALF_UP_'||caissepro_currency_precision(NEW.\"destinationCurrency\")::text")
    source = source.replace("(item->>'maximum') !~ '^(0|[1-9][0-9]{0,15})\\.[0-9]{2}$'", "NOT caissepro_money_input_valid(item->>'maximum',NEW.currency)")
    source = source.replace("(NEW.snapshot->>f.currency::text)!~'^(0|[1-9][0-9]{0,15})\\.[0-9]{2}$'", "NOT caissepro_money_input_valid(NEW.snapshot->>f.currency::text,f.currency)")
    source = source.replace("'book',round(f.balance,2)::text,'counted',counted::numeric(18,2)::text,'difference',round(counted-f.balance,2)::text", "'book',caissepro_money_text(f.balance,f.currency),'counted',caissepro_money_text(counted,f.currency),'difference',caissepro_money_text(counted-f.balance,f.currency)")
    source = source.replace('jsonb_array_length(counts)<>2', 'jsonb_array_length(counts)=0')
    if name=='caissepro_audit_guard':
        source=source.replace("'COMPANY_CONFIGURED'", "'COMPANY_CONFIGURED','MONETARY_SETTINGS_CONFIGURED'")
    patched.append(source)

suffix = """
REVOKE ALL ON FUNCTION caissepro_assert_expense_limit(uuid,uuid,"Currency",text,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION caissepro_assert_expense_limit(uuid,uuid,"Currency",text,numeric) TO caissepro_runtime;
COMMIT;
"""
output = prefix + core + '\n'.join(patched) + suffix
if '--check' in sys.argv:
    if (directory / 'migration.sql').read_text() != output:
        raise SystemExit('Migration differs from frozen catalog/historical functions')
else:
    (directory / 'migration.sql').write_text(output)
print('Migration generated:', directory.name, 'catalog:',len(catalog),'functions:',len(patched))
