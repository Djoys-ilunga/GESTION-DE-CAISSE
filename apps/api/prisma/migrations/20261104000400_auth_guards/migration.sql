BEGIN;
ALTER TABLE "Company" ADD CHECK (code=upper(trim(code)) AND code ~ '^[A-Z0-9][A-Z0-9-]{2,31}$');
ALTER TABLE "User" ADD CHECK ("securityVersion">0);
ALTER TABLE "CompanyMember" ADD CHECK ("authorizationVersion">0);
ALTER TABLE "AuthSession" ADD CHECK ("tokenHash" ~ '^[0-9a-f]{64}$' AND "userVersion">0 AND "memberVersion">0 AND "expiresAt">"createdAt" AND "idleExpiresAt"<="expiresAt");
ALTER TABLE "AuthThrottle" ADD CHECK (key ~ '^[0-9a-f]{64}$' AND failures>=0);
ALTER TABLE "UserCredential" ADD CHECK ("passwordHash" LIKE 'scrypt$131072$8$1$%');
ALTER TABLE "ImportedDraft" ADD FOREIGN KEY("companyId","cashRegisterId","agencyId") REFERENCES "CashRegister"("companyId",id,"agencyId") ON DELETE RESTRICT;
INSERT INTO "Permission"(code,description) VALUES ('users:manage','Administrer les utilisateurs de l’entreprise'),('roles:assign','Affecter les rôles et périmètres'),('auth:logs:read','Consulter le journal de sécurité'),('offline:access','Consulter temporairement hors connexion'),('draft:read_own','Consulter ses propres brouillons'),('draft:write_own','Préparer ses propres brouillons');
DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='caissepro_auth_runtime') THEN CREATE ROLE caissepro_auth_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='caissepro_auth_runtime' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN RAISE EXCEPTION 'CAISSEPRO_AUTH_ROLE_INVALID'; END IF; END $$;
GRANT USAGE ON SCHEMA public TO caissepro_auth_runtime;
GRANT SELECT ON "Company","User","UserCredential","CompanyMember","Role","Permission","MemberRole","RolePermission","Agency","AgencyGrant","CashRegister","CashRegisterGrant","AuthSession","AuthThrottle","AuthEvent" TO caissepro_auth_runtime;
GRANT INSERT ON "User","UserCredential","CompanyMember","MemberRole","AgencyGrant","CashRegisterGrant","AuthSession","AuthThrottle","AuthEvent","Role","RolePermission" TO caissepro_auth_runtime;
GRANT UPDATE ON "User","UserCredential","CompanyMember","AuthSession","AuthThrottle" TO caissepro_auth_runtime;
GRANT UPDATE(id) ON "Company" TO caissepro_auth_runtime;
GRANT DELETE ON "MemberRole","AgencyGrant","CashRegisterGrant" TO caissepro_auth_runtime;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['Company','User','CompanyMember','Role','MemberRole','RolePermission','Agency','AgencyGrant','CashRegister'] LOOP
 EXECUTE format('CREATE POLICY auth_directory ON %I TO caissepro_auth_runtime USING (true) WITH CHECK (true)',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['UserCredential','CashRegisterGrant','AuthSession','AuthThrottle','AuthEvent'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY auth_storage ON %I TO caissepro_auth_runtime USING (true) WITH CHECK (true)',t);
 END LOOP; END $$;
CREATE POLICY cash_scope ON "CashRegisterGrant" TO caissepro_runtime USING("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid);
GRANT SELECT ON "CashRegisterGrant" TO caissepro_runtime;
CREATE POLICY session_owner ON "AuthSession" TO caissepro_runtime USING("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid AND "userId"=nullif(current_setting('caissepro.actor_id',true),'')::uuid);
GRANT SELECT(id,"companyId","memberId","userId","expiresAt","idleExpiresAt","revokedAt","lockedAt","userVersion","memberVersion") ON "AuthSession" TO caissepro_runtime;
CREATE FUNCTION caissepro_assert_session(c uuid,u uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE s uuid; BEGIN
 s:=nullif(current_setting('caissepro.session_id',true),'')::uuid;
 IF s IS NOT NULL AND NOT EXISTS(SELECT FROM "AuthSession" a JOIN "User" usr ON usr.id=a."userId" JOIN "CompanyMember" m ON m.id=a."memberId" AND m."companyId"=a."companyId" WHERE a.id=s AND a."companyId"=c AND a."userId"=u AND a."revokedAt" IS NULL AND a."lockedAt" IS NULL AND a."expiresAt">clock_timestamp() AND a."idleExpiresAt">clock_timestamp() AND a."userVersion"=usr."securityVersion" AND a."memberVersion"=m."authorizationVersion" AND usr.active AND m.active) THEN RAISE EXCEPTION 'CAISSEPRO_SESSION_REVOKED' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION caissepro_assert_session(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION caissepro_assert_session(uuid,uuid) TO caissepro_runtime;
ALTER FUNCTION caissepro_assert_permission(uuid,uuid,uuid,text) RENAME TO caissepro_assert_agency_permission;
CREATE FUNCTION caissepro_assert_permission(c uuid,u uuid,a uuid,p text) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN PERFORM caissepro_assert_session(c,u); PERFORM caissepro_assert_agency_permission(c,u,a,p); END $$;
REVOKE ALL ON FUNCTION caissepro_assert_permission(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION caissepro_assert_permission(uuid,uuid,uuid,text) TO caissepro_runtime;
CREATE FUNCTION caissepro_assert_cash_permission(c uuid,u uuid,r uuid,p text) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE a uuid; BEGIN
 SELECT "agencyId" INTO a FROM "CashRegister" WHERE "companyId"=c AND id=r AND active;
 IF a IS NULL OR NOT EXISTS(SELECT FROM "CashRegisterGrant" g JOIN "CompanyMember" m ON m.id=g."memberId" AND m."companyId"=g."companyId" WHERE g."companyId"=c AND g."cashRegisterId"=r AND m."userId"=u AND m.active) THEN RAISE EXCEPTION 'CAISSEPRO_CASH_ACCESS_DENIED' USING ERRCODE='42501'; END IF;
 PERFORM caissepro_assert_permission(c,u,a,p);
END $$;
REVOKE ALL ON FUNCTION caissepro_assert_cash_permission(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION caissepro_assert_cash_permission(uuid,uuid,uuid,text) TO caissepro_runtime;
CREATE FUNCTION caissepro_entry_cash_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE r uuid; o "FinancialOperation"; BEGIN
 SELECT "cashRegisterId" INTO r FROM "TreasuryAccount" WHERE "companyId"=NEW."companyId" AND id=NEW."accountId";
 IF r IS NOT NULL THEN SELECT * INTO o FROM "FinancialOperation" WHERE "companyId"=NEW."companyId" AND id=NEW."operationId"; PERFORM caissepro_assert_cash_permission(NEW."companyId",o."createdById",r,CASE o.kind WHEN 'RECEIPT' THEN 'receipt:post' WHEN 'DISBURSEMENT' THEN 'expense:pay' WHEN 'TRANSFER' THEN 'transfer:post' WHEN 'FX' THEN 'fx:post' ELSE 'ledger:reverse' END); END IF; RETURN NEW;
END $$;
CREATE TRIGGER entry_cash_scope BEFORE INSERT ON "LedgerEntry" FOR EACH ROW EXECUTE FUNCTION caissepro_entry_cash_scope();
CREATE FUNCTION caissepro_session_cash_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN PERFORM caissepro_assert_cash_permission(NEW."companyId",CASE WHEN TG_OP='INSERT' THEN NEW."openedById" ELSE NEW."closedById" END,NEW."cashRegisterId",'session:manage'); RETURN NEW; END $$;
CREATE TRIGGER cash_scope BEFORE INSERT OR UPDATE ON "CashSession" FOR EACH ROW EXECUTE FUNCTION caissepro_session_cash_scope();
CREATE TRIGGER immutable_auth_event BEFORE UPDATE OR DELETE ON "AuthEvent" FOR EACH ROW EXECUTE FUNCTION caissepro_immutable();
ALTER TABLE "AuthEvent" ADD CHECK(code IN('LOGIN_SUCCESS','LOGIN_FAILED','LOGIN_THROTTLED','LOGOUT','LOCK','UNLOCK_SUCCESS','UNLOCK_FAILED','SESSION_EXPIRED','SESSION_REVOKED','USER_CREATED','ACCESS_CHANGED','PASSWORD_CHANGED'));
INSERT INTO "Role"(id,"companyId",code,active) SELECT gen_random_uuid(),c.id,r.code,true FROM "Company" c CROSS JOIN(VALUES ('ADMINISTRATOR'),('DIRECTOR'),('FINANCE_MANAGER'),('ACCOUNTANT'),('CASHIER'),('AUDITOR'))r(code) ON CONFLICT("companyId",code) DO NOTHING;
INSERT INTO "RolePermission"("companyId","roleId","permissionCode") SELECT r."companyId",r.id,p.permission FROM "Role" r JOIN(VALUES ('ADMINISTRATOR','directory:read'),
('ADMINISTRATOR','ledger:read'),
('ADMINISTRATOR','users:manage'),
('ADMINISTRATOR','roles:assign'),
('ADMINISTRATOR','auth:logs:read'),
('DIRECTOR','directory:read'),
('DIRECTOR','ledger:read'),
('DIRECTOR','expense:approve'),
('DIRECTOR','auth:logs:read'),
('DIRECTOR','offline:access'),
('FINANCE_MANAGER','directory:read'),
('FINANCE_MANAGER','ledger:read'),
('FINANCE_MANAGER','draft:receive'),
('FINANCE_MANAGER','draft:read_own'),
('FINANCE_MANAGER','draft:write_own'),
('FINANCE_MANAGER','offline:access'),
('FINANCE_MANAGER','receipt:post'),
('FINANCE_MANAGER','expense:request'),
('FINANCE_MANAGER','expense:approve'),
('FINANCE_MANAGER','expense:pay'),
('FINANCE_MANAGER','transfer:post'),
('FINANCE_MANAGER','fx:post'),
('FINANCE_MANAGER','ledger:reverse'),
('FINANCE_MANAGER','session:manage'),
('FINANCE_MANAGER','auth:logs:read'),
('ACCOUNTANT','directory:read'),
('ACCOUNTANT','ledger:read'),
('ACCOUNTANT','draft:receive'),
('ACCOUNTANT','draft:read_own'),
('ACCOUNTANT','draft:write_own'),
('ACCOUNTANT','offline:access'),
('ACCOUNTANT','receipt:post'),
('ACCOUNTANT','expense:request'),
('ACCOUNTANT','transfer:post'),
('ACCOUNTANT','fx:post'),
('ACCOUNTANT','ledger:reverse'),
('CASHIER','directory:read'),
('CASHIER','ledger:read'),
('CASHIER','draft:receive'),
('CASHIER','draft:read_own'),
('CASHIER','draft:write_own'),
('CASHIER','offline:access'),
('CASHIER','receipt:post'),
('CASHIER','expense:request'),
('CASHIER','expense:pay'),
('CASHIER','session:manage'),
('AUDITOR','directory:read'),
('AUDITOR','ledger:read'),
('AUDITOR','auth:logs:read'),
('AUDITOR','offline:access'))p(role,permission) ON r.code=p.role ON CONFLICT DO NOTHING;
CREATE POLICY draft_owner ON "ImportedDraft" AS RESTRICTIVE TO caissepro_runtime USING("authorId"=nullif(current_setting('caissepro.actor_id',true),'')::uuid) WITH CHECK("authorId"=nullif(current_setting('caissepro.actor_id',true),'')::uuid);
COMMIT;
