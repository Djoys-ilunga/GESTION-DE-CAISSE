BEGIN;
-- Un CHECK nullable ne suffit pas : un justificatif doit avoir un type non nul
-- et un en-tête correspondant, même en cas d'accès direct par le rôle de données.
ALTER TABLE "ImportedDraft" ADD CONSTRAINT receipt_evidence_complete CHECK (
 "evidenceBytes" IS NULL OR (
  "evidenceMime" IS NOT NULL AND "evidenceName" IS NOT NULL AND length(trim("evidenceName"))>0
  AND "evidenceSha" IS NOT NULL
  AND CASE "evidenceMime"
   WHEN 'application/pdf' THEN substring("evidenceBytes" FROM 1 FOR 5)=decode('255044462d','hex')
   WHEN 'image/png' THEN substring("evidenceBytes" FROM 1 FOR 8)=decode('89504e470d0a1a0a','hex')
   WHEN 'image/jpeg' THEN substring("evidenceBytes" FROM 1 FOR 3)=decode('ffd8ff','hex')
   ELSE false END
 )
);
COMMIT;
