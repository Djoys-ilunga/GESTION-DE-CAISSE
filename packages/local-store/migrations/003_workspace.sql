-- Additive local migration. The financial PostgreSQL history is never touched.
-- Full broker records include immutable UUIDs, real currency, ownership/scope,
-- revisions, server links, supporting documents and the exact pending sync body.
CREATE TABLE workspace_checkpoint(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  revision INTEGER NOT NULL CHECK(revision>0),
  updated_at INTEGER NOT NULL,
  retained_until INTEGER NOT NULL CHECK(retained_until>updated_at),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=33554432)
);
