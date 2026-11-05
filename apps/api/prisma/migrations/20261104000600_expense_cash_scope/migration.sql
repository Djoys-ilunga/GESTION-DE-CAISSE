BEGIN;
CREATE FUNCTION caissepro_expense_cash_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE r uuid; actor uuid; permission text; BEGIN
 SELECT "cashRegisterId" INTO r FROM "TreasuryAccount" WHERE "companyId"=NEW."companyId" AND id=NEW."accountId";
 IF r IS NOT NULL THEN
  actor:=CASE WHEN TG_OP='INSERT' THEN NEW."requestedById" ELSE nullif(current_setting('caissepro.actor_id',true),'')::uuid END;
  permission:=CASE WHEN TG_OP='INSERT' THEN 'expense:request' WHEN NEW.state='PAID' THEN 'expense:pay' ELSE 'expense:approve' END;
  PERFORM caissepro_assert_cash_permission(NEW."companyId",actor,r,permission);
 END IF; RETURN NEW; END $$;
CREATE TRIGGER cash_scope BEFORE INSERT OR UPDATE ON "ExpenseRequest" FOR EACH ROW EXECUTE FUNCTION caissepro_expense_cash_scope();
CREATE FUNCTION caissepro_approval_cash_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE r uuid; BEGIN
 SELECT a."cashRegisterId" INTO r FROM "ExpenseRequest" e JOIN "TreasuryAccount" a ON a.id=e."accountId" AND a."companyId"=e."companyId" WHERE e.id=NEW."expenseRequestId" AND e."companyId"=NEW."companyId";
 IF r IS NOT NULL THEN PERFORM caissepro_assert_cash_permission(NEW."companyId",NEW."approverId",r,'expense:approve'); END IF; RETURN NEW; END $$;
CREATE TRIGGER cash_scope BEFORE INSERT ON "ExpenseApproval" FOR EACH ROW EXECUTE FUNCTION caissepro_approval_cash_scope();
COMMIT;
