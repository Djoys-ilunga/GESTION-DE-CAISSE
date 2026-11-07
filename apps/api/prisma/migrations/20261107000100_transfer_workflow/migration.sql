BEGIN;
CREATE UNIQUE INDEX "CashRegister_companyId_id_key" ON "CashRegister"("companyId",id);
CREATE TABLE "TransferOrder" (
 id uuid PRIMARY KEY, "companyId" uuid NOT NULL REFERENCES "Company"(id), "authorId" uuid NOT NULL REFERENCES "User"(id),
 "sourceCashRegisterId" uuid NOT NULL, "destinationCashRegisterId" uuid NOT NULL,
 "sourceAccountId" uuid NOT NULL, "destinationAccountId" uuid NOT NULL,
 "sourceCurrency" "Currency" NOT NULL, "destinationCurrency" "Currency" NOT NULL,
 amount numeric(18,2) NOT NULL CHECK(amount>0), "targetAmount" numeric(18,2) NOT NULL CHECK("targetAmount">0),
 rate numeric(24,12), "rateSource" varchar(100) NOT NULL, description varchar(500) NOT NULL CHECK(length(trim(description))>0),
 "payloadHash" char(64) NOT NULL CHECK("payloadHash" ~ '^[0-9a-f]{64}$'),
 state varchar(20) NOT NULL DEFAULT 'DRAFT' CHECK(state IN('DRAFT','HANDED_OVER','RECEIVED')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
 "handedOverAt" timestamptz(3), "receivedAt" timestamptz(3), "handedOverById" uuid REFERENCES "User"(id), "receivedById" uuid REFERENCES "User"(id),
 "operationId" uuid UNIQUE, slip jsonb,
 UNIQUE("companyId",id),
 FOREIGN KEY("companyId","sourceCashRegisterId") REFERENCES "CashRegister"("companyId",id),
 FOREIGN KEY("companyId","destinationCashRegisterId") REFERENCES "CashRegister"("companyId",id),
 FOREIGN KEY("companyId","sourceAccountId","sourceCurrency") REFERENCES "TreasuryAccount"("companyId",id,currency),
 FOREIGN KEY("companyId","destinationAccountId","destinationCurrency") REFERENCES "TreasuryAccount"("companyId",id,currency),
 FOREIGN KEY("companyId","operationId") REFERENCES "FinancialOperation"("companyId",id),
 CHECK("sourceAccountId"<>"destinationAccountId"),
 CHECK(("sourceCurrency"="destinationCurrency" AND rate IS NULL AND "rateSource"='' AND amount="targetAmount") OR
 ("sourceCurrency"<>"destinationCurrency" AND rate IS NOT NULL AND rate>0 AND length(trim("rateSource"))>0 AND "targetAmount"=round(amount*rate,2))),
 CHECK((state='DRAFT' AND "handedOverAt" IS NULL AND "handedOverById" IS NULL AND "receivedAt" IS NULL AND "receivedById" IS NULL AND "operationId" IS NULL AND slip IS NULL) OR
 (state='HANDED_OVER' AND "handedOverAt" IS NOT NULL AND "handedOverById" IS NOT NULL AND "receivedAt" IS NULL AND "receivedById" IS NULL AND "operationId" IS NULL AND slip IS NULL) OR
 (state='RECEIVED' AND "receivedAt" IS NOT NULL AND "handedOverAt" IS NOT NULL AND "handedOverById" IS NOT NULL AND "receivedAt">="handedOverAt" AND "receivedById" IS NOT NULL AND "receivedById"<>"handedOverById" AND "operationId" IS NOT NULL AND slip IS NOT NULL))
);
CREATE INDEX ON "TransferOrder"("companyId","createdAt",id);
ALTER TABLE "TransferOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TransferOrder" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "TransferOrder" TO caissepro_runtime USING("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid) WITH CHECK("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid);
-- Scope is required for BOTH endpoints, including read access to history.
CREATE POLICY transfer_cash_scope ON "TransferOrder" AS RESTRICTIVE TO caissepro_runtime USING(
 NOT EXISTS(SELECT r FROM unnest(ARRAY["sourceCashRegisterId","destinationCashRegisterId"]) r WHERE NOT EXISTS(
 SELECT FROM "CashRegisterGrant" g JOIN "CompanyMember" m ON m."companyId"=g."companyId" AND m.id=g."memberId"
 JOIN "AgencyGrant" a ON a."companyId"=m."companyId" AND a."memberId"=m.id AND a."agencyId"=g."agencyId"
 WHERE g."companyId"="TransferOrder"."companyId" AND g."cashRegisterId"=r AND m.active AND m."userId"=nullif(current_setting('caissepro.actor_id',true),'')::uuid)));
GRANT SELECT,INSERT,UPDATE ON "TransferOrder" TO caissepro_runtime;
-- Dedicated NOLOGIN, NOBYPASSRLS owner: only a tenant aggregate is exposed.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='caissepro_transfer_reader') THEN
  CREATE ROLE caissepro_transfer_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
 END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='caissepro_transfer_reader' AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreatedb OR rolcreaterole)) THEN RAISE EXCEPTION 'CAISSEPRO_TRANSFER_READER_INVALID'; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO caissepro_transfer_reader;
GRANT SELECT ON "TransferOrder" TO caissepro_transfer_reader;
CREATE POLICY reservation_aggregate ON "TransferOrder" FOR SELECT TO caissepro_transfer_reader USING("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid);
-- RLS of workflow must not hide a reservation from a different authorized spender.
-- This narrow function exposes only the aggregate, never transfer details.
CREATE FUNCTION caissepro_transfer_reserved(c uuid,a uuid) RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET row_security=on AS $$
 SELECT coalesce(sum(amount),0) FROM "TransferOrder" WHERE "companyId"=c AND "sourceAccountId"=a AND state='HANDED_OVER'
 AND c=nullif(current_setting('caissepro.company_id',true),'')::uuid
$$;
GRANT CREATE ON SCHEMA public TO caissepro_transfer_reader;
ALTER FUNCTION caissepro_transfer_reserved(uuid,uuid) OWNER TO caissepro_transfer_reader;
REVOKE CREATE ON SCHEMA public FROM caissepro_transfer_reader;
REVOKE ALL ON FUNCTION caissepro_transfer_reserved(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION caissepro_transfer_reserved(uuid,uuid) TO caissepro_runtime;
CREATE OR REPLACE VIEW "AvailableFunds" WITH(security_invoker=true) AS
 SELECT b.*,(COALESCE(r.reserved,0)+caissepro_transfer_reserved(b."companyId",b."accountId"))::numeric AS reserved,
 (b.balance-COALESCE(r.reserved,0)-caissepro_transfer_reserved(b."companyId",b."accountId"))::numeric AS available
 FROM "AccountBalance" b LEFT JOIN(SELECT "companyId","accountId",sum(amount) reserved FROM "FundReservation" WHERE state='ACTIVE' GROUP BY "companyId","accountId") r ON r."companyId"=b."companyId" AND r."accountId"=b."accountId";
CREATE FUNCTION caissepro_transfer_order_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('caissepro.actor_id',true),'')::uuid; src "TreasuryAccount"; dst "TreasuryAccount";
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CAISSEPRO_IMMUTABLE_RECORD'; END IF;
 PERFORM caissepro_assert_session(NEW."companyId",actor);
 SELECT * INTO src FROM "TreasuryAccount" WHERE "companyId"=NEW."companyId" AND id=NEW."sourceAccountId";
 SELECT * INTO dst FROM "TreasuryAccount" WHERE "companyId"=NEW."companyId" AND id=NEW."destinationAccountId";
 IF src.id IS NULL OR dst.id IS NULL OR NOT src.active OR NOT dst.active OR src.kind<>'TREASURY' OR dst.kind<>'TREASURY' OR src."cashRegisterId" IS DISTINCT FROM NEW."sourceCashRegisterId" OR dst."cashRegisterId" IS DISTINCT FROM NEW."destinationCashRegisterId" THEN RAISE EXCEPTION 'CAISSEPRO_TRANSFER_INVALID'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'DRAFT' OR NEW.version<>1 OR NEW."authorId"<>actor THEN RAISE EXCEPTION 'CAISSEPRO_TRANSFER_INVALID'; END IF;
  PERFORM caissepro_assert_cash_permission(NEW."companyId",actor,NEW."sourceCashRegisterId",'draft:receive');
  PERFORM caissepro_assert_cash_permission(NEW."companyId",actor,NEW."destinationCashRegisterId",'draft:receive');
  NEW."createdAt":=clock_timestamp();
 ELSE
  IF OLD.state='RECEIVED' OR NEW.version<>OLD.version+1 OR
   (to_jsonb(NEW)-ARRAY['state','version','handedOverAt','receivedAt','handedOverById','receivedById','operationId','slip']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['state','version','handedOverAt','receivedAt','handedOverById','receivedById','operationId','slip']) THEN RAISE EXCEPTION 'CAISSEPRO_TRANSFER_CONFLICT'; END IF;
  PERFORM caissepro_assert_cash_permission(NEW."companyId",actor,NEW."sourceCashRegisterId",'transfer:post');
  PERFORM caissepro_assert_cash_permission(NEW."companyId",actor,NEW."destinationCashRegisterId",'transfer:post');
  IF NEW."sourceCurrency"<>NEW."destinationCurrency" THEN
   PERFORM caissepro_assert_cash_permission(NEW."companyId",actor,NEW."sourceCashRegisterId",'fx:post');
   PERFORM caissepro_assert_cash_permission(NEW."companyId",actor,NEW."destinationCashRegisterId",'fx:post');
  END IF;
  IF OLD.state='DRAFT' AND NEW.state='HANDED_OVER' AND actor=OLD."authorId" AND NEW."handedOverById"=actor THEN
   NEW."handedOverAt":=clock_timestamp();
  ELSIF OLD.state='HANDED_OVER' AND NEW.state='RECEIVED' AND actor<>OLD."handedOverById" AND NEW."receivedById"=actor
   AND ROW(NEW."handedOverAt",NEW."handedOverById") IS NOT DISTINCT FROM ROW(OLD."handedOverAt",OLD."handedOverById") THEN
   NEW."receivedAt":=clock_timestamp();
   SELECT jsonb_build_object('number','TRF-'||c.code||'-'||NEW.id::text,'companyName',c.name,'companyCode',c.code,
    'sourceCashName',sr.name,'destinationCashName',dr.name,'sourceAgencyName',sa.name,'destinationAgencyName',da.name,
    'handedOverByName',hu."displayName",'receivedByName',ru."displayName",'handedOverAt',to_char(NEW."handedOverAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'receivedAt',to_char(NEW."receivedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'rounding','HALF_UP_2') INTO NEW.slip
   FROM "Company" c, "CashRegister" sr, "CashRegister" dr, "Agency" sa, "Agency" da, "User" hu, "User" ru
   WHERE c.id=NEW."companyId" AND sr.id=NEW."sourceCashRegisterId" AND dr.id=NEW."destinationCashRegisterId" AND sa.id=src."agencyId" AND da.id=dst."agencyId" AND hu.id=NEW."handedOverById" AND ru.id=actor;
  ELSE RAISE EXCEPTION 'CAISSEPRO_TRANSFER_CONFLICT'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER transfer_order_guard BEFORE INSERT OR UPDATE OR DELETE ON "TransferOrder" FOR EACH ROW EXECUTE FUNCTION caissepro_transfer_order_guard();
CREATE FUNCTION caissepro_transfer_order_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE t "TransferOrder"; o "FinancialOperation"; r "ExchangeRate";
BEGIN
 SELECT * INTO t FROM "TransferOrder" WHERE id=NEW.id AND "companyId"=NEW."companyId";
 PERFORM caissepro_check_funds(t."companyId",t."sourceAccountId");
 IF t.state='RECEIVED' THEN
  SELECT * INTO o FROM "FinancialOperation" WHERE "companyId"=t."companyId" AND id=t."operationId";
  IF o.id IS NULL OR o."transactionId"<>txid_current() OR o."idempotencyKey"<>t.id OR o."createdById"<>t."receivedById" THEN RAISE EXCEPTION 'CAISSEPRO_TRANSFER_INVALID'; END IF;
  IF t."sourceCurrency"=t."destinationCurrency" THEN
   IF o.kind<>'TRANSFER' OR o.currency<>t."sourceCurrency" THEN RAISE EXCEPTION 'CAISSEPRO_TRANSFER_INVALID'; END IF;
  ELSE
   SELECT * INTO r FROM "ExchangeRate" WHERE "companyId"=t."companyId" AND id=o."exchangeRateId";
   IF o.kind<>'FX' OR r.id IS NULL OR r.rate<>t.rate OR r."fromCurrency"<>t."sourceCurrency" OR r."toCurrency"<>t."destinationCurrency" OR o."sourceAmount"<>t.amount OR o."targetAmount"<>t."targetAmount" THEN RAISE EXCEPTION 'CAISSEPRO_TRANSFER_INVALID'; END IF;
  END IF;
  IF NOT EXISTS(SELECT FROM "LedgerEntry" WHERE "companyId"=t."companyId" AND "operationId"=o.id AND "accountId"=t."sourceAccountId" AND currency=t."sourceCurrency" AND side='CREDIT' AND amount=t.amount)
   OR NOT EXISTS(SELECT FROM "LedgerEntry" WHERE "companyId"=t."companyId" AND "operationId"=o.id AND "accountId"=t."destinationAccountId" AND currency=t."destinationCurrency" AND side='DEBIT' AND amount=t."targetAmount") THEN RAISE EXCEPTION 'CAISSEPRO_TRANSFER_INVALID'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER transfer_order_complete AFTER INSERT OR UPDATE ON "TransferOrder" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION caissepro_transfer_order_complete();
GRANT INSERT ON "ExchangeRate" TO caissepro_runtime;
CREATE FUNCTION caissepro_transfer_rate_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('caissepro.actor_id',true),'')::uuid; t "TransferOrder";
BEGIN
 IF current_user='caissepro_runtime' THEN
  SELECT * INTO t FROM "TransferOrder" WHERE "companyId"=NEW."companyId" AND state='HANDED_OVER' AND rate=NEW.rate
   AND "sourceCurrency"=NEW."fromCurrency" AND "destinationCurrency"=NEW."toCurrency" AND "rateSource"=NEW.source AND "handedOverAt"=NEW."effectiveAt" AND "handedOverById"<>actor LIMIT 1;
  IF t.id IS NULL THEN RAISE EXCEPTION 'CAISSEPRO_TRANSFER_INVALID'; END IF;
  PERFORM caissepro_assert_cash_permission(NEW."companyId",actor,t."sourceCashRegisterId",'fx:post');
  PERFORM caissepro_assert_cash_permission(NEW."companyId",actor,t."destinationCashRegisterId",'fx:post');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER transfer_rate_guard BEFORE INSERT ON "ExchangeRate" FOR EACH ROW EXECUTE FUNCTION caissepro_transfer_rate_guard();
COMMIT;
