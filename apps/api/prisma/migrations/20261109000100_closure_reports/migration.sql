BEGIN;
CREATE TABLE "CashClosureReport"(id uuid PRIMARY KEY,"companyId" uuid NOT NULL REFERENCES "Company"(id),"cashRegisterId" uuid NOT NULL,"sessionId" uuid NOT NULL UNIQUE,"closedById" uuid NOT NULL REFERENCES "User"(id),"closedAt" timestamptz(3) NOT NULL,snapshot jsonb NOT NULL,
 FOREIGN KEY("companyId","cashRegisterId") REFERENCES "CashRegister"("companyId",id),
 FOREIGN KEY("companyId","sessionId") REFERENCES "CashSession"("companyId",id));
CREATE INDEX ON "CashClosureReport"("companyId","closedAt");
ALTER TABLE "CashClosureReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CashClosureReport" FORCE ROW LEVEL SECURITY;
CREATE POLICY closure_scope ON "CashClosureReport" TO caissepro_runtime USING("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid AND EXISTS(SELECT FROM "CashRegisterGrant" g JOIN "CompanyMember" m ON m.id=g."memberId" AND m."companyId"=g."companyId" WHERE g."companyId"="CashClosureReport"."companyId" AND g."cashRegisterId"="CashClosureReport"."cashRegisterId" AND m.active AND m."userId"=nullif(current_setting('caissepro.actor_id',true),'')::uuid));
GRANT SELECT,INSERT ON "CashClosureReport" TO caissepro_runtime;
CREATE TRIGGER closure_immutable BEFORE UPDATE OR DELETE ON "CashClosureReport" FOR EACH ROW EXECUTE FUNCTION caissepro_immutable();
CREATE FUNCTION caissepro_closure_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE s "CashSession"; c "Company"; r "CashRegister"; u "User"; counts jsonb:='[]'::jsonb; f record; counted numeric; BEGIN
 PERFORM caissepro_assert_cash_permission(NEW."companyId",NEW."closedById",NEW."cashRegisterId",'session:manage');
 IF NEW."closedById" IS DISTINCT FROM nullif(current_setting('caissepro.actor_id',true),'')::uuid THEN RAISE EXCEPTION 'CAISSEPRO_ACCESS_DENIED'; END IF;
 SELECT * INTO s FROM "CashSession" WHERE "companyId"=NEW."companyId" AND id=NEW."sessionId" FOR UPDATE;
 IF s.id IS NULL OR s.state<>'CLOSED' OR s."cashRegisterId"<>NEW."cashRegisterId" OR s."closedById"<>NEW."closedById" OR (s."closedAt" IS NULL OR s."closedAt"<transaction_timestamp()) THEN RAISE EXCEPTION 'CAISSEPRO_CLOSURE_INVALID'; END IF;
 FOR f IN SELECT a.currency,b.balance,b.reserved FROM "TreasuryAccount" a JOIN "AvailableFunds" b ON b."accountId"=a.id AND b."companyId"=a."companyId" WHERE a."companyId"=NEW."companyId" AND a."cashRegisterId"=NEW."cashRegisterId" AND a.kind='TREASURY' ORDER BY a.currency LOOP
  IF f.reserved<>0 THEN RAISE EXCEPTION 'CAISSEPRO_CLOSURE_RESERVED_FUNDS'; END IF;
  IF (NEW.snapshot->>f.currency::text) IS NULL OR (NEW.snapshot->>f.currency::text)!~'^(0|[1-9][0-9]{0,15})\.[0-9]{2}$' THEN RAISE EXCEPTION 'CAISSEPRO_CLOSURE_INVALID'; END IF;
  counted:=(NEW.snapshot->>f.currency::text)::numeric;
  counts:=counts||jsonb_build_array(jsonb_build_object('currency',f.currency,'book',round(f.balance,2)::text,'counted',counted::numeric(18,2)::text,'difference',round(counted-f.balance,2)::text));
 END LOOP;
 IF jsonb_array_length(counts)<>2 THEN RAISE EXCEPTION 'CAISSEPRO_CLOSURE_INVALID'; END IF;
 SELECT * INTO c FROM "Company" WHERE id=NEW."companyId"; SELECT * INTO r FROM "CashRegister" WHERE id=NEW."cashRegisterId"; SELECT * INTO u FROM "User" WHERE id=NEW."closedById";
 NEW."closedAt":=s."closedAt";
 NEW.snapshot:=jsonb_build_object('id',NEW.id,'cashRegisterId',r.id,'cashName',r.name,'closedAt',to_char(s."closedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'closedBy',u."displayName",'number','PV-'||c.code||'-'||s.id::text,'counts',counts);
 RETURN NEW;
END $$;
CREATE TRIGGER closure_guard BEFORE INSERT ON "CashClosureReport" FOR EACH ROW EXECUTE FUNCTION caissepro_closure_guard();
COMMIT;
