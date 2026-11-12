BEGIN;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtext('caissepro-bcc-schema-v1'));
-- Source approval belongs to the operator/migration owner; no HTTP API can
-- approve a connector or promote user-supplied rates to official BCC rates.
CREATE TABLE "BccSourceApproval"(id varchar(20) PRIMARY KEY CHECK(id='bcc'),"sourceUrl" varchar(300) NOT NULL CHECK("sourceUrl" IN('https://www.bcc.cd/marche-des-changes/cours-de-change','https://www.bcc.cd/marche-des-changes/convertisseur','https://www.bcc.cd/statistiques/secteur-exterieur/cours-de-change')),"contractVersion" varchar(100),approved boolean NOT NULL DEFAULT false,"approvedAt" timestamptz(3),evidence varchar(1000),CHECK(NOT approved OR("approvedAt" IS NOT NULL AND length(trim(evidence))>=10 AND length(trim("contractVersion"))>0 AND "contractVersion"<>'UNVERIFIED')));
INSERT INTO "BccSourceApproval"(id,"sourceUrl")VALUES('bcc','https://www.bcc.cd/marche-des-changes/cours-de-change');
CREATE TABLE "BccRefreshState"(id varchar(20) PRIMARY KEY CHECK(id='bcc'),state varchar(20) NOT NULL DEFAULT 'UNVERIFIED' CHECK(state IN('UNVERIFIED','READY','FETCHING','UNAVAILABLE')),code varchar(80) NOT NULL DEFAULT 'SOURCE_CONTRACT_UNVERIFIED',"checkedAt" timestamptz(3),"lastSuccessAt" timestamptz(3),"nextAllowedAt" timestamptz(3),"leaseToken" uuid,"leaseUntil" timestamptz(3),failures integer NOT NULL DEFAULT 0 CHECK(failures>=0));
INSERT INTO "BccRefreshState"(id)VALUES('bcc');
CREATE TABLE "BccPublication"(id uuid PRIMARY KEY,"ingestionTxId" bigint NOT NULL DEFAULT txid_current(),"sourceId" varchar(20) NOT NULL DEFAULT 'bcc' REFERENCES "BccSourceApproval"(id),"sourceUrl" varchar(300) NOT NULL,"sourceReference" varchar(160) NOT NULL CHECK(length(trim("sourceReference"))>0),"publicationDate" varchar(10) NOT NULL CHECK("publicationDate"~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),"publishedAt" timestamptz(3),"retrievedAt" timestamptz(3) NOT NULL,"contentSha256" char(64) NOT NULL CHECK("contentSha256"~'^[0-9a-f]{64}$'),"connectorVersion" varchar(100) NOT NULL,UNIQUE("sourceId","contentSha256","connectorVersion"));
CREATE INDEX ON "BccPublication"("publicationDate","retrievedAt");
CREATE TABLE "BccQuotation"("publicationId" uuid NOT NULL REFERENCES "BccPublication"(id),currency varchar(3) NOT NULL REFERENCES "CurrencyDefinition"(code) CHECK(currency<>'CDF'),unit varchar(3) NOT NULL CHECK(unit IN('1','100')),"unitEvidence" varchar(160) NOT NULL CHECK(length(trim("unitEvidence"))>0),"rawBuy" numeric(30,12),"rawMean" numeric(30,12),"rawSell" numeric(30,12),buy numeric(38,18),mean numeric(38,18),sell numeric(38,18),PRIMARY KEY("publicationId",currency),CHECK(buy IS NOT NULL OR mean IS NOT NULL OR sell IS NOT NULL),CHECK((buy IS NULL)=("rawBuy" IS NULL) AND(mean IS NULL)=("rawMean" IS NULL) AND(sell IS NULL)=("rawSell" IS NULL)),CHECK((buy IS NULL OR(buy>0 AND buy*unit::numeric="rawBuy")) AND(mean IS NULL OR(mean>0 AND mean*unit::numeric="rawMean")) AND(sell IS NULL OR(sell>0 AND sell*unit::numeric="rawSell"))),CHECK(buy IS NULL OR sell IS NULL OR buy<=sell),CHECK(mean IS NULL OR buy IS NULL OR sell IS NULL OR mean BETWEEN buy AND sell));
ALTER TABLE "BccQuotation" ADD CHECK (("rawBuy" IS NULL OR "rawBuy"<1000000000000000000) AND ("rawMean" IS NULL OR "rawMean"<1000000000000000000) AND ("rawSell" IS NULL OR "rawSell"<1000000000000000000) AND (buy IS NULL OR buy<1000000000000000000) AND (mean IS NULL OR mean<1000000000000000000) AND (sell IS NULL OR sell<1000000000000000000));
CREATE TABLE "BccRefreshEvent"(id uuid PRIMARY KEY,state varchar(20) NOT NULL,code varchar(80) NOT NULL,"checkedAt" timestamptz(3) NOT NULL,"retrievedAt" timestamptz(3),"publicationId" uuid REFERENCES "BccPublication"(id));
CREATE INDEX ON "BccRefreshEvent"("checkedAt");
CREATE TABLE "ExchangeRatePolicy"("companyId" uuid PRIMARY KEY REFERENCES "Company"(id),"allowManual" boolean NOT NULL DEFAULT true,"quoteKind" varchar(5) NOT NULL DEFAULT 'MEAN' CHECK("quoteKind" IN('BUY','MEAN','SELL')),"maxAgeHours" integer NOT NULL DEFAULT 96 CHECK("maxAgeHours" BETWEEN 1 AND 168),"quoteTtlMinutes" integer NOT NULL DEFAULT 15 CHECK("quoteTtlMinutes" BETWEEN 1 AND 30),version integer NOT NULL DEFAULT 1 CHECK(version>0),"updatedAt" timestamptz(3) NOT NULL DEFAULT now(),"updatedById" uuid REFERENCES "User"(id));
INSERT INTO "ExchangeRatePolicy"("companyId")SELECT id FROM "Company";
CREATE TABLE "RateQuote"(id uuid PRIMARY KEY,"companyId" uuid NOT NULL,"createdById" uuid NOT NULL,"fromCurrency" varchar(3) NOT NULL REFERENCES "CurrencyDefinition"(code),"toCurrency" varchar(3) NOT NULL REFERENCES "CurrencyDefinition"(code),amount numeric(24,8) NOT NULL CHECK(amount>0 AND amount<10000000000000000),"targetAmount" numeric(24,8) NOT NULL CHECK("targetAmount">0 AND "targetAmount"<10000000000000000),mode varchar(6) NOT NULL CHECK(mode IN('BCC','MANUAL')),"quoteKind" varchar(5) NOT NULL CHECK("quoteKind" IN('BUY','MEAN','SELL')),"referenceRate" numeric(24,12),"appliedRate" numeric(24,12) NOT NULL CHECK("appliedRate">0),source varchar(100) NOT NULL,justification varchar(500),"effectiveAt" timestamptz(3) NOT NULL,"createdAt" timestamptz(3) NOT NULL,"expiresAt" timestamptz(3) NOT NULL,"publicationId" uuid REFERENCES "BccPublication"(id),"policyVersion" integer NOT NULL,snapshot jsonb NOT NULL,UNIQUE("companyId",id),FOREIGN KEY("companyId","createdById")REFERENCES "CompanyMember"("companyId","userId"),CHECK("fromCurrency"<>"toCurrency"),CHECK(amount=caissepro_currency_round(amount,"fromCurrency") AND "targetAmount"=caissepro_currency_round(amount*"appliedRate","toCurrency")));
CREATE INDEX ON "RateQuote"("companyId","createdAt");
ALTER TABLE "TransferOrder" ADD COLUMN "rateQuoteId" uuid,ADD COLUMN "rateOrigin" varchar(10),ADD COLUMN "rateEvidence" jsonb,ADD FOREIGN KEY("companyId","rateQuoteId")REFERENCES "RateQuote"("companyId",id),ADD CHECK("rateOrigin" IS NULL OR "rateOrigin" IN('MANUAL','BCC'));
ALTER TABLE "ExchangeRate" ADD COLUMN "transferOrderId" uuid,ADD COLUMN "rateEvidence" jsonb,ADD FOREIGN KEY("companyId","transferOrderId")REFERENCES "TransferOrder"("companyId",id),ADD UNIQUE("companyId","transferOrderId");
INSERT INTO "Permission"(code,description)VALUES('fx:manual','Appliquer un taux manuel justifié')ON CONFLICT DO NOTHING;
-- Existing FX capabilities are preserved, but can now be restricted by policy.
INSERT INTO "RolePermission"("companyId","roleId","permissionCode")SELECT "companyId","roleId",'fx:manual' FROM "RolePermission" WHERE "permissionCode"='fx:post' ON CONFLICT DO NOTHING;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='caissepro_bcc_worker')THEN CREATE ROLE caissepro_bcc_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='caissepro_bcc_worker' AND(rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole))THEN RAISE EXCEPTION 'CAISSEPRO_BCC_WORKER_INVALID';END IF;
END $$;
GRANT caissepro_bcc_worker TO caissepro_auth_runtime WITH INHERIT FALSE;
GRANT USAGE ON SCHEMA public TO caissepro_bcc_worker;
GRANT SELECT ON "BccSourceApproval","BccRefreshState","BccPublication","BccQuotation","BccRefreshEvent" TO caissepro_runtime,caissepro_auth_runtime,caissepro_bcc_worker;
GRANT SELECT ON "CurrencyDefinition" TO caissepro_bcc_worker;
GRANT INSERT ON "BccPublication","BccQuotation","BccRefreshEvent" TO caissepro_bcc_worker;
GRANT UPDATE ON "BccRefreshState" TO caissepro_bcc_worker;
GRANT UPDATE("bccRateStatus")ON "CurrencyDefinition" TO caissepro_bcc_worker;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['BccPublication','BccQuotation','BccRefreshEvent']LOOP EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION caissepro_immutable()',t);END LOOP;END $$;
ALTER TABLE "ExchangeRatePolicy" ENABLE ROW LEVEL SECURITY;ALTER TABLE "ExchangeRatePolicy" FORCE ROW LEVEL SECURITY;
CREATE POLICY rate_policy_tenant ON "ExchangeRatePolicy" TO caissepro_runtime,caissepro_auth_runtime USING("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid)WITH CHECK("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON "ExchangeRatePolicy" TO caissepro_runtime,caissepro_auth_runtime;
ALTER TABLE "RateQuote" ENABLE ROW LEVEL SECURITY;ALTER TABLE "RateQuote" FORCE ROW LEVEL SECURITY;
CREATE POLICY rate_quote_owner ON "RateQuote" TO caissepro_runtime USING("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid AND "createdById"=nullif(current_setting('caissepro.actor_id',true),'')::uuid)WITH CHECK("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid AND "createdById"=nullif(current_setting('caissepro.actor_id',true),'')::uuid);
GRANT SELECT,INSERT ON "RateQuote" TO caissepro_runtime;
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON "RateQuote" FOR EACH ROW EXECUTE FUNCTION caissepro_immutable();
CREATE FUNCTION caissepro_exchange_policy_defaults()RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$DECLARE previous text:=current_setting('caissepro.company_id',true);BEGIN PERFORM set_config('caissepro.company_id',NEW.id::text,true);INSERT INTO "ExchangeRatePolicy"("companyId")VALUES(NEW.id);PERFORM set_config('caissepro.company_id',coalesce(previous,''),true);RETURN NEW;END $$;
CREATE TRIGGER rate_policy_defaults AFTER INSERT ON "Company" FOR EACH ROW EXECUTE FUNCTION caissepro_exchange_policy_defaults();
CREATE FUNCTION caissepro_exchange_policy_guard()RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$DECLARE actor uuid:=nullif(current_setting('caissepro.actor_id',true),'')::uuid;BEGIN
 IF current_user IN('caissepro_runtime','caissepro_auth_runtime')THEN PERFORM caissepro_assert_session(NEW."companyId",actor);PERFORM caissepro_assert_company_permission(NEW."companyId",actor,'cash:configure');NEW."updatedById":=actor;END IF;
 IF(TG_OP='INSERT' AND NEW.version<>1)OR(TG_OP='UPDATE' AND(NEW."companyId"<>OLD."companyId" OR NEW.version<>OLD.version+1))THEN RAISE EXCEPTION 'CAISSEPRO_SETTINGS_CONFLICT';END IF;NEW."updatedAt":=clock_timestamp();RETURN NEW;END $$;
CREATE TRIGGER policy_guard BEFORE INSERT OR UPDATE ON "ExchangeRatePolicy" FOR EACH ROW EXECUTE FUNCTION caissepro_exchange_policy_guard();
CREATE FUNCTION caissepro_bcc_publication_guard()RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$BEGIN
 NEW."ingestionTxId":=txid_current();
 PERFORM 1 FROM "BccSourceApproval" WHERE id=NEW."sourceId" AND approved AND "sourceUrl"=NEW."sourceUrl" AND "contractVersion"=NEW."connectorVersion" FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CAISSEPRO_BCC_SOURCE_UNVERIFIED';END IF;
 IF NEW."publicationDate"::date>(clock_timestamp()AT TIME ZONE'Africa/Kinshasa')::date OR NEW."retrievedAt">clock_timestamp()+interval'30 seconds' OR(NEW."publishedAt"IS NOT NULL AND(NEW."publishedAt">NEW."retrievedAt"+interval'30 seconds' OR NEW."publishedAt"<(NEW."publicationDate"::date::timestamp AT TIME ZONE'Africa/Kinshasa')))THEN RAISE EXCEPTION 'CAISSEPRO_BCC_DATE_INVALID';END IF;RETURN NEW;END $$;
CREATE TRIGGER publication_guard BEFORE INSERT ON "BccPublication" FOR EACH ROW EXECUTE FUNCTION caissepro_bcc_publication_guard();
-- One publication and one quote kind per cross rate. CDF=1 is a base identity,
-- never an invented BCC quotation. No mean is inferred from buy/sell values.
CREATE FUNCTION caissepro_bcc_cross(p uuid,f text,t text,k text)RETURNS numeric LANGUAGE plpgsql SET search_path=public,pg_temp AS $$DECLARE s numeric;d numeric;pub "BccPublication";latest uuid;BEGIN
 IF k NOT IN('BUY','MEAN','SELL')THEN RAISE EXCEPTION 'CAISSEPRO_BCC_RATE_UNAVAILABLE';END IF;
 SELECT * INTO pub FROM "BccPublication" WHERE id=p;
 PERFORM 1 FROM "BccSourceApproval" WHERE id=pub."sourceId" AND approved AND "sourceUrl"=pub."sourceUrl" AND "contractVersion"=pub."connectorVersion" FOR SHARE;
 IF NOT FOUND OR pub.id IS NULL THEN RAISE EXCEPTION 'CAISSEPRO_BCC_SOURCE_UNVERIFIED';END IF;
 SELECT id INTO latest FROM "BccPublication" ORDER BY "publicationDate" DESC,"publishedAt" DESC NULLS LAST,"retrievedAt" DESC,id DESC LIMIT 1;
 IF latest IS DISTINCT FROM p THEN RAISE EXCEPTION 'CAISSEPRO_RATE_QUOTE_STALE';END IF;
 IF f='CDF'THEN s:=1;ELSE SELECT CASE k WHEN'BUY'THEN buy WHEN'MEAN'THEN mean ELSE sell END INTO s FROM "BccQuotation" WHERE "publicationId"=p AND currency=f;END IF;
 IF t='CDF'THEN d:=1;ELSE SELECT CASE k WHEN'BUY'THEN buy WHEN'MEAN'THEN mean ELSE sell END INTO d FROM "BccQuotation" WHERE "publicationId"=p AND currency=t;END IF;
 IF s IS NULL OR d IS NULL OR s<=0 OR d<=0 THEN RAISE EXCEPTION 'CAISSEPRO_BCC_RATE_UNAVAILABLE';END IF;RETURN round(s/d,12);END $$;
CREATE FUNCTION caissepro_rate_quote_guard()RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$DECLARE actor uuid:=nullif(current_setting('caissepro.actor_id',true),'')::uuid;p "ExchangeRatePolicy";b "BccPublication";reference numeric;fresh timestamptz;BEGIN
 IF NEW."createdById" IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CAISSEPRO_ACCESS_DENIED';END IF;PERFORM caissepro_assert_session(NEW."companyId",actor);PERFORM caissepro_assert_company_permission(NEW."companyId",actor,'ledger:read');
 SELECT * INTO p FROM "ExchangeRatePolicy" WHERE "companyId"=NEW."companyId" FOR SHARE;
 IF p.version IS NULL OR NEW."policyVersion"<>p.version OR NEW."quoteKind"<>p."quoteKind" THEN RAISE EXCEPTION 'CAISSEPRO_RATE_POLICY_CHANGED';END IF;
 PERFORM caissepro_currency_active(NEW."companyId",NEW."fromCurrency");PERFORM caissepro_currency_active(NEW."companyId",NEW."toCurrency");
 NEW."createdAt":=clock_timestamp();
 IF NEW."publicationId" IS NOT NULL THEN reference:=caissepro_bcc_cross(NEW."publicationId",NEW."fromCurrency",NEW."toCurrency",NEW."quoteKind");SELECT * INTO b FROM "BccPublication" WHERE id=NEW."publicationId";fresh:=(b."publicationDate"::date::timestamp AT TIME ZONE'Africa/Kinshasa')+make_interval(hours=>p."maxAgeHours");NEW."referenceRate":=reference;ELSE NEW."referenceRate":=NULL;END IF;
 IF NEW.mode='BCC'THEN
  IF b.id IS NULL OR NEW."appliedRate" IS DISTINCT FROM reference THEN RAISE EXCEPTION 'CAISSEPRO_BCC_RATE_UNAVAILABLE';END IF;
  NEW.source:='BCC '||b."publicationDate"||' '||NEW."quoteKind";NEW.justification:=NULL;NEW."effectiveAt":=b."publicationDate"::date::timestamp AT TIME ZONE'Africa/Kinshasa';
 ELSE
  PERFORM caissepro_assert_company_permission(NEW."companyId",actor,'fx:manual');
  IF NOT p."allowManual" OR length(trim(coalesce(NEW.justification,'')))<3 OR length(trim(NEW.source))<3 THEN RAISE EXCEPTION 'CAISSEPRO_MANUAL_RATE_FORBIDDEN';END IF;
  IF NEW."effectiveAt">clock_timestamp()+interval'30 seconds'THEN RAISE EXCEPTION 'CAISSEPRO_RATE_QUOTE_STALE';END IF;
  fresh:=least(coalesce(fresh,'infinity'::timestamptz),NEW."effectiveAt"+make_interval(hours=>p."maxAgeHours"));
 END IF;
 IF fresh IS NULL OR fresh<=clock_timestamp()THEN RAISE EXCEPTION 'CAISSEPRO_RATE_QUOTE_STALE';END IF;
 NEW."expiresAt":=least(NEW."createdAt"+make_interval(mins=>p."quoteTtlMinutes"),fresh);
 NEW."targetAmount":=caissepro_currency_round(NEW.amount*NEW."appliedRate",NEW."toCurrency");
 NEW.snapshot:=jsonb_build_object('kind',NEW.mode,'quoteKind',NEW."quoteKind",'publicationId',NEW."publicationId",'publicationDate',b."publicationDate",'publicationSourceUrl',b."sourceUrl",'contentSha256',b."contentSha256",'publicationRetrievedAt',b."retrievedAt",'sourceReference',b."sourceReference",'fromCurrency',NEW."fromCurrency",'toCurrency',NEW."toCurrency",'referenceRate',NEW."referenceRate"::text,'appliedRate',NEW."appliedRate"::text,'source',NEW.source,'justification',NEW.justification,'effectiveAt',NEW."effectiveAt",'preparedById',actor,'preparedAt',NEW."createdAt",'policyVersion',p.version,'rounding','RATE_HALF_UP_12_THEN_AMOUNT_DESTINATION','quotations',(SELECT coalesce(jsonb_agg(jsonb_build_object('currency',q.currency,'unit',q.unit,'unitEvidence',q."unitEvidence",'rawBuy',q."rawBuy"::text,'rawMean',q."rawMean"::text,'rawSell',q."rawSell"::text,'buy',q.buy::text,'mean',q.mean::text,'sell',q.sell::text)ORDER BY q.currency),'[]'::jsonb)FROM "BccQuotation"q WHERE q."publicationId"=NEW."publicationId" AND q.currency IN(NEW."fromCurrency",NEW."toCurrency")));
 RETURN NEW;END $$;
CREATE TRIGGER rate_quote_guard BEFORE INSERT ON "RateQuote" FOR EACH ROW EXECUTE FUNCTION caissepro_rate_quote_guard();
CREATE FUNCTION caissepro_assert_rate_quote(c uuid,u uuid,qid uuid,f text,t text,a numeric)RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$DECLARE q "RateQuote";p "ExchangeRatePolicy";b "BccPublication";BEGIN
 SELECT * INTO q FROM "RateQuote" WHERE "companyId"=c AND id=qid AND "createdById"=u;
 IF q.id IS NULL OR q."fromCurrency"<>f OR q."toCurrency"<>t OR q.amount<>a THEN RAISE EXCEPTION 'CAISSEPRO_RATE_QUOTE_INVALID';END IF;
 SELECT * INTO p FROM "ExchangeRatePolicy" WHERE "companyId"=c FOR SHARE;
 IF q."policyVersion"<>p.version OR q."quoteKind"<>p."quoteKind"THEN RAISE EXCEPTION 'CAISSEPRO_RATE_POLICY_CHANGED';END IF;
 IF q."expiresAt"<=clock_timestamp()THEN RAISE EXCEPTION 'CAISSEPRO_RATE_QUOTE_STALE';END IF;
 IF q."publicationId" IS NOT NULL THEN PERFORM caissepro_bcc_cross(q."publicationId",f,t,q."quoteKind");SELECT * INTO b FROM "BccPublication"WHERE id=q."publicationId";IF(b."publicationDate"::date::timestamp AT TIME ZONE'Africa/Kinshasa')+make_interval(hours=>p."maxAgeHours")<=clock_timestamp()THEN RAISE EXCEPTION 'CAISSEPRO_RATE_QUOTE_STALE';END IF;END IF;
 IF q.mode='MANUAL'THEN PERFORM caissepro_assert_company_permission(c,u,'fx:manual');IF NOT p."allowManual"THEN RAISE EXCEPTION 'CAISSEPRO_MANUAL_RATE_FORBIDDEN';END IF;END IF;
END $$;
CREATE FUNCTION caissepro_order_rate_evidence()RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$DECLARE q "RateQuote";p "ExchangeRatePolicy";actor uuid:=nullif(current_setting('caissepro.actor_id',true),'')::uuid;BEGIN
 IF NEW.rate IS NULL THEN IF NEW."rateQuoteId" IS NOT NULL OR NEW."rateOrigin" IS NOT NULL OR NEW."rateEvidence" IS NOT NULL THEN RAISE EXCEPTION 'CAISSEPRO_RATE_QUOTE_INVALID';END IF;RETURN NEW;END IF;
 IF TG_OP='INSERT' OR(OLD.state='DRAFT' AND NEW.state='HANDED_OVER')THEN
  SELECT * INTO p FROM "ExchangeRatePolicy"WHERE "companyId"=NEW."companyId" FOR SHARE;
  IF NEW."rateQuoteId" IS NOT NULL THEN
   PERFORM caissepro_assert_rate_quote(NEW."companyId",actor,NEW."rateQuoteId",NEW."sourceCurrency",NEW."destinationCurrency",NEW.amount);
   SELECT * INTO q FROM "RateQuote"WHERE "companyId"=NEW."companyId" AND id=NEW."rateQuoteId";
   IF NEW.rate<>q."appliedRate" OR NEW."targetAmount"<>q."targetAmount" OR NEW."rateSource"<>q.source THEN RAISE EXCEPTION 'CAISSEPRO_RATE_QUOTE_INVALID';END IF;NEW."rateOrigin":=q.mode;
  ELSE
   PERFORM caissepro_assert_company_permission(NEW."companyId",actor,'fx:manual');IF NOT p."allowManual"THEN RAISE EXCEPTION 'CAISSEPRO_MANUAL_RATE_FORBIDDEN';END IF;
   IF TG_OP='UPDATE' AND NEW."createdAt"+make_interval(hours=>p."maxAgeHours")<=clock_timestamp()THEN RAISE EXCEPTION 'CAISSEPRO_RATE_QUOTE_STALE';END IF;NEW."rateOrigin":='MANUAL';
  END IF;
  IF TG_OP='INSERT'THEN NEW."rateEvidence":=NULL;
  ELSE NEW."rateEvidence":=coalesce(q.snapshot,jsonb_build_object('kind','MANUAL','quoteKind',NULL,'referenceRate',NULL,'appliedRate',NEW.rate::text,'source',NEW."rateSource",'justification',NEW."rateSource",'preparedById',NEW."authorId",'preparedAt',NEW."createdAt",'legacyDeclaration',true,'policyVersion',p.version))||jsonb_build_object('confirmedById',actor,'confirmedAt',NEW."handedOverAt",'fromCurrency',NEW."sourceCurrency",'toCurrency',NEW."destinationCurrency",'amount',caissepro_money_text(NEW.amount,NEW."sourceCurrency"),'targetAmount',caissepro_money_text(NEW."targetAmount",NEW."destinationCurrency"));END IF;
 END IF;RETURN NEW;END $$;
-- Runs after the historical immutable-fields check. The snapshot is generated
-- only during handover; subsequent changes still fail that historical guard.
CREATE TRIGGER zz_rate_evidence BEFORE INSERT OR UPDATE ON "TransferOrder"FOR EACH ROW EXECUTE FUNCTION caissepro_order_rate_evidence();
CREATE FUNCTION caissepro_exchange_rate_evidence()RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$DECLARE t "TransferOrder";BEGIN
 IF NEW."transferOrderId"IS NOT NULL THEN
  SELECT * INTO t FROM "TransferOrder"WHERE "companyId"=NEW."companyId" AND id=NEW."transferOrderId";
  IF t.id IS NULL OR t.state<>'HANDED_OVER' OR t.rate<>NEW.rate OR t."sourceCurrency"<>NEW."fromCurrency" OR t."destinationCurrency"<>NEW."toCurrency" OR t."rateSource"<>NEW.source OR t."handedOverAt"<>NEW."effectiveAt"THEN RAISE EXCEPTION 'CAISSEPRO_RATE_QUOTE_INVALID';END IF;
  NEW."rateEvidence":=coalesce(t."rateEvidence",jsonb_build_object('kind','MANUAL','legacyDeclaration',true,'appliedRate',t.rate::text,'source',t."rateSource",'justification',t."rateSource",'confirmedById',t."handedOverById",'confirmedAt',t."handedOverAt"));
 ELSE
  IF current_user='caissepro_runtime'THEN RAISE EXCEPTION 'CAISSEPRO_RATE_QUOTE_INVALID';END IF;
  NEW."rateEvidence":=jsonb_build_object('kind','MANUAL','legacyDeclaration',true,'appliedRate',NEW.rate::text,'source',NEW.source,'justification',NEW.source,'effectiveAt',NEW."effectiveAt");
 END IF;RETURN NEW;END $$;
CREATE TRIGGER zz_rate_evidence BEFORE INSERT ON "ExchangeRate"FOR EACH ROW EXECUTE FUNCTION caissepro_exchange_rate_evidence();
CREATE FUNCTION caissepro_fx_rate_policy()RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$DECLARE r "ExchangeRate";p "ExchangeRatePolicy";t "TransferOrder";BEGIN
 IF NEW.kind<>'FX'THEN RETURN NEW;END IF;SELECT * INTO r FROM "ExchangeRate"WHERE "companyId"=NEW."companyId" AND id=NEW."exchangeRateId";
 IF r."transferOrderId"IS NOT NULL THEN SELECT * INTO t FROM "TransferOrder"WHERE "companyId"=NEW."companyId"AND id=r."transferOrderId";IF t.state<>'HANDED_OVER' OR NEW."idempotencyKey"<>t.id OR NEW."sourceAmount"<>t.amount OR NEW."targetAmount"<>t."targetAmount"THEN RAISE EXCEPTION 'CAISSEPRO_RATE_QUOTE_INVALID';END IF;
 ELSE SELECT * INTO p FROM "ExchangeRatePolicy"WHERE "companyId"=NEW."companyId"FOR SHARE;PERFORM caissepro_assert_company_permission(NEW."companyId",NEW."createdById",'fx:manual');IF NOT p."allowManual"THEN RAISE EXCEPTION 'CAISSEPRO_MANUAL_RATE_FORBIDDEN';END IF;IF r."effectiveAt"+make_interval(hours=>p."maxAgeHours")<=clock_timestamp()THEN RAISE EXCEPTION 'CAISSEPRO_RATE_QUOTE_STALE';END IF;END IF;RETURN NEW;END $$;
CREATE TRIGGER zz_fx_policy BEFORE INSERT ON "FinancialOperation"FOR EACH ROW EXECUTE FUNCTION caissepro_fx_rate_policy();
CREATE FUNCTION caissepro_manual_reference_policy()RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$BEGIN
 IF NOT EXISTS(SELECT FROM "ExchangeRatePolicy"WHERE "companyId"=NEW."companyId"AND "allowManual")THEN RAISE EXCEPTION 'CAISSEPRO_MANUAL_RATE_FORBIDDEN';END IF;RETURN NEW;END $$;
CREATE TRIGGER zz_manual_policy BEFORE INSERT ON "ReferenceExchangeRate"FOR EACH ROW EXECUTE FUNCTION caissepro_manual_reference_policy();
REVOKE ALL ON FUNCTION caissepro_assert_rate_quote(uuid,uuid,uuid,text,text,numeric),caissepro_bcc_cross(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION caissepro_assert_rate_quote(uuid,uuid,uuid,text,text,numeric),caissepro_bcc_cross(uuid,text,text,text) TO caissepro_runtime;
-- UPDATE(id) permits row SHARE locks, not changes to source approval data.
GRANT UPDATE(id)ON "BccSourceApproval" TO caissepro_runtime,caissepro_auth_runtime,caissepro_bcc_worker;
CREATE FUNCTION caissepro_bcc_approval_readonly()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF current_user IN('caissepro_runtime','caissepro_auth_runtime','caissepro_bcc_worker')THEN RAISE EXCEPTION 'CAISSEPRO_ACCESS_DENIED';END IF;RETURN NEW;END $$;
CREATE TRIGGER source_approval_owner BEFORE UPDATE OR DELETE ON "BccSourceApproval"FOR EACH ROW EXECUTE FUNCTION caissepro_bcc_approval_readonly();

CREATE OR REPLACE FUNCTION caissepro_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."actorId" IS DISTINCT FROM nullif(current_setting('caissepro.actor_id',true),'')::uuid OR NEW.action NOT IN('OPERATION_POSTED','EXPENSE_REQUESTED','EXPENSE_APPROVED','EXPENSE_REJECTED','DRAFT_RECEIVED','CASH_CONFIGURED','AGENCY_CONFIGURED','EXPENSE_POLICY_CONFIGURED','EXPENSE_PAYMENT_CONFIRMED','COMPANY_CONFIGURED','MONETARY_SETTINGS_CONFIGURED','EXCHANGE_POLICY_CONFIGURED','RATE_QUOTE_PREPARED','BCC_REFRESH_REQUESTED','CATEGORY_CONFIGURED','REFERENCE_RATE_PUBLISHED','SESSION_POLICY_CONFIGURED','CASH_SESSION_CLOSED','CASH_SESSION_OPENED','TRANSFER_DRAFT_RECEIVED','TRANSFER_HANDED_OVER','TRANSFER_RECEIVED') OR NEW."targetType" NOT IN('OPERATION','EXPENSE','DRAFT','CASH','AGENCY','COMPANY','CATEGORY','RATE','CLOSURE','TRANSFER') THEN RAISE EXCEPTION 'CAISSEPRO_AUDIT_INVALID' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE FUNCTION caissepro_bcc_quotation_insert()RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$BEGIN
 IF NOT EXISTS(SELECT FROM "BccPublication"WHERE id=NEW."publicationId"AND "ingestionTxId"=txid_current())THEN RAISE EXCEPTION 'CAISSEPRO_BCC_PUBLICATION_IMMUTABLE';END IF;RETURN NEW;END $$;
CREATE TRIGGER quotation_insert BEFORE INSERT ON "BccQuotation"FOR EACH ROW EXECUTE FUNCTION caissepro_bcc_quotation_insert();
CREATE FUNCTION caissepro_bcc_publication_complete()RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$BEGIN
 IF NOT EXISTS(SELECT FROM "BccQuotation"WHERE "publicationId"=NEW.id)THEN RAISE EXCEPTION 'CAISSEPRO_BCC_PUBLICATION_EMPTY';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER publication_complete AFTER INSERT ON "BccPublication"DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION caissepro_bcc_publication_complete();
COMMIT;
