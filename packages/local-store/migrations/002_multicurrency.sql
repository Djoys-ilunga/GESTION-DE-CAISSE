-- Keep the original migration and every draft/sync acknowledgement intact.
CREATE TEMP TABLE cp_sync_backup AS SELECT * FROM sync_metadata;
DROP TABLE sync_metadata;
DROP TRIGGER draft_identity;
CREATE TABLE drafts_v2(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN('receipt','expense-request')),currency TEXT NOT NULL CHECK(length(currency)=3 AND currency NOT GLOB '*[^A-Z]*'),amount TEXT NOT NULL,description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 500),version INTEGER NOT NULL CHECK(version>0),state TEXT NOT NULL CHECK(state IN('local','synced','conflict','error')),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,CHECK(expires_at>created_at AND expires_at-created_at<=900000));
INSERT INTO drafts_v2 SELECT * FROM drafts;
DROP TABLE drafts;
ALTER TABLE drafts_v2 RENAME TO drafts;
CREATE TABLE sync_metadata(draft_id TEXT PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,idempotency_key TEXT UNIQUE NOT NULL CHECK(idempotency_key=draft_id),last_attempt_at INTEGER,last_attempt_version INTEGER,server_version INTEGER,result_code TEXT CHECK(result_code IN('draft-received','conflict','validation-failed','offline','transport-error')));
INSERT INTO sync_metadata SELECT * FROM cp_sync_backup;
DROP TABLE cp_sync_backup;
CREATE TRIGGER draft_identity BEFORE UPDATE ON drafts WHEN NEW.id<>OLD.id OR NEW.kind<>OLD.kind OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at BEGIN SELECT RAISE(ABORT,'LOCAL_IDENTITY_IMMUTABLE'); END;
