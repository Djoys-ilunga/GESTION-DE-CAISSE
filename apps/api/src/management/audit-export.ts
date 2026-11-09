import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import {
  AUDIT_ACTION_LABELS,
  AUDIT_TARGET_LABELS,
  reportFileSchema,
  type AuditPage,
  type AuditQuery,
} from '@caissepro/shared';
import { DataError } from '../data/central-access';
export async function exportAudit(
  data: AuditPage,
  company: { name: string; code: string },
  query: AuditQuery,
  format: 'pdf' | 'xlsx',
) {
  let bytes: Buffer;
  if (format === 'pdf') {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      bufferPages: true,
      info: { Title: 'CaissePro — Journal d’audit', Author: company.name },
    });
    doc.font(join(__dirname, '../../assets/DejaVuSans.ttf'));
    const parts: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (v: Buffer) => parts.push(v));
      doc.on('end', () => resolve(Buffer.concat(parts)));
      doc.on('error', reject);
    });
    doc
      .fontSize(18)
      .text(company.name)
      .fontSize(11)
      .text(company.code + ' | Journal d’audit');
    doc
      .fontSize(9)
      .text('Africa/Kinshasa | Genere : ' + data.generatedAt)
      .text('Filtres : ' + JSON.stringify(query))
      .moveDown();
    for (const r of data.items) {
      if (doc.y > 750) doc.addPage();
      doc
        .fontSize(9)
        .text(
          `${r.createdAt} | ${AUDIT_ACTION_LABELS[r.action] ?? 'Événement métier'} | ${r.actorName} | ${AUDIT_TARGET_LABELS[r.targetType] ?? 'Élément métier'} | ${r.targetId}`,
          {
            width: 515,
          },
        )
        .moveDown(0.4);
    }
    if (!data.items.length) doc.text('Aucun evenement dans ce perimetre.');
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(8)
        .text(`${company.code} | Audit | ${i + 1}/${range.count}`, 40, 790, { lineBreak: false });
    }
    doc.end();
    bytes = await done;
  } else {
    const book = new ExcelJS.Workbook();
    book.creator = 'CaissePro';
    const identity = book.addWorksheet('Identite');
    identity.addRows([
      ['Champ', 'Valeur'],
      ['Entreprise', company.name],
      ['Code', company.code],
      ['Genere', data.generatedAt],
      ['Fuseau', 'Africa/Kinshasa'],
      ['Filtres', JSON.stringify(query)],
      ['Evenements', data.total],
    ]);
    const sheet = book.addWorksheet('Audit');
    sheet.addRow(['Date UTC', 'Événement', 'Responsable', 'Objet', 'Référence']);
    for (const r of data.items)
      sheet.addRow([
        r.createdAt,
        AUDIT_ACTION_LABELS[r.action] ?? r.action,
        r.actorName,
        AUDIT_TARGET_LABELS[r.targetType] ?? r.targetType,
        r.targetId,
      ]);
    for (const ws of book.worksheets) {
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF173E32' } };
      ws.columns.forEach((c) => {
        c.width = 30;
      });
    }
    sheet.autoFilter = { from: 'A1', to: { row: Math.max(1, sheet.rowCount), column: 5 } };
    bytes = Buffer.from(await book.xlsx.writeBuffer());
  }
  if (bytes.length > 1300000) throw new DataError('REPORT_TOO_LARGE');
  return reportFileSchema.parse({
    fileName: `CaissePro-audit-${data.generatedAt.slice(0, 10)}.${format}`,
    mimeType:
      format === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    dataBase64: bytes.toString('base64'),
  });
}
