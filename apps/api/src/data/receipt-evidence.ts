import { createHash } from 'node:crypto';
import { MAX_EVIDENCE_BYTES, type SupportingDocument } from '@caissepro/shared';
import { DataError } from './central-access';
export function decodeEvidence(document: SupportingDocument | null | undefined) {
  if (!document)
    return { evidenceName: null, evidenceMime: null, evidenceSha: null, evidenceBytes: null };
  const bytes = Buffer.from(document.dataBase64, 'base64');
  const magic =
    document.mimeType === 'application/pdf'
      ? bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
      : document.mimeType === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (
    !bytes.length ||
    bytes.length > MAX_EVIDENCE_BYTES ||
    bytes.toString('base64') !== document.dataBase64 ||
    !magic
  )
    throw new DataError('EVIDENCE_INVALID');
  return {
    evidenceName: document.fileName,
    evidenceMime: document.mimeType,
    evidenceSha: createHash('sha256').update(bytes).digest('hex'),
    evidenceBytes: bytes,
  };
}
