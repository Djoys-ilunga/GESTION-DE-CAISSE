import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { reportFileSchema, type ReportSnapshot } from '@caissepro/shared';
import { DataError } from '../data/central-access';
const text = (s: unknown) => String(s ?? '').replace(/[\u202f\u00a0]/g, ' ');
export async function exportReport(s: ReportSnapshot, format: 'pdf' | 'xlsx') {
  let bytes: Buffer;
  if (format === 'pdf') {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      bufferPages: true,
      info: { Title: 'CaissePro — Rapport financier', Author: s.company.name },
    });
    doc.font(join(__dirname, '../../assets/DejaVuSans.ttf'));
    const chunks: Buffer[] = [];
    const completed = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (b: Buffer) => chunks.push(b));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    const line = (value: string) => {
      if (doc.y > 755) doc.addPage();
      doc.fontSize(9).fillColor('#183e32').text(text(value), { width: 515 });
      doc.moveDown(0.35);
    };
    doc.fontSize(20).text(text(s.company.name));
    doc.fontSize(11).text(text(s.company.code + ' | Rapport financier'));
    if (s.company.address) line(s.company.address);
    if (s.company.email || s.company.phone)
      line([s.company.email, s.company.phone].filter(Boolean).join(' | '));
    if (s.company.taxId) line('Identification fiscale : ' + s.company.taxId);
    line(s.from + ' au ' + s.to + ' | Africa/Kinshasa');
    line('Genere le ' + s.generatedAt + ' | Perimetre autorise uniquement');
    line('Filtres : ' + JSON.stringify(s.query));
    for (const t of s.totals)
      line(
        `${t.currency} | Solde actuel ${t.balance} | Disponible ${t.available} | Ouverture ${t.opening} | Cloture de periode ${t.closing} | Encaissements ${t.receipts} | Decaissements ${t.disbursements}`,
      );
    for (const d of s.discrepancies)
      line(
        `${d.currency} | Ecarts : ${d.net ?? 'Non mesure'} | ${d.measured} comptages | ${d.count} clotures avec ecart`,
      );
    line('JOURNAL DE CAISSE — une ligne par mouvement de tresorerie');
    for (const r of s.rows)
      line(
        `${r.postedAt} | ${r.cashName} | ${r.agencyName} | ${r.userName} | ${r.kind} | ${r.side} ${r.amount} ${r.currency} | ${r.category} | ${r.reference}`,
      );
    for (const dimension of ['category', 'agency', 'user']) {
      line('MOUVEMENTS PAR ' + dimension.toUpperCase());
      for (const g of s.groups.filter((g) => g.dimension === dimension))
        line(`${g.name} | ${g.currency} | Entrees ${g.incoming} | Sorties ${g.outgoing}`);
    }
    line('DECISIONS DE DEPENSES');
    for (const d of s.decisions)
      line(
        `${d.decidedAt} | ${d.state} | ${d.amount} ${d.currency} | ${d.requester} | ${d.approver} | ${d.description} | ${d.requestState} | ${d.reason ?? 'Non renseigne'}`,
      );
    line('PROCES-VERBAUX DE CLOTURE');
    for (const c of s.closures) {
      line(`${c.number} | ${c.cashName} | ${c.closedBy} | ${c.closedAt}`);
      for (const v of c.counts)
        line(`${v.currency} | Comptable ${v.book} | Compte ${v.counted} | Ecart ${v.difference}`);
    }
    line(`${s.unmeasuredClosures} cloture(s) historique(s) sans comptage : ecart non mesure.`);
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(8)
        .text(`${text(s.company.code)} | ${s.from} - ${s.to} | ${i + 1}/${range.count}`, 40, 790, {
          lineBreak: false,
        });
    }
    doc.end();
    bytes = await completed;
  } else {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'CaissePro';
    workbook.title = 'Rapports financiers — ' + s.company.name;
    const sheet = (name: string, headers: string[], rows: (string | number)[][]) => {
      const ws = workbook.addWorksheet(name);
      ws.addRow(headers);
      for (const row of rows) ws.addRow(row);
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF183E32' } };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: Math.max(1, ws.rowCount), column: headers.length },
      };
      ws.columns.forEach((c) => {
        c.width = 24;
      });
      return ws;
    };
    sheet(
      'Identite',
      ['Champ', 'Valeur'],
      [
        ['Entreprise', s.company.name],
        ['Code', s.company.code],
        ['Adresse', s.company.address ?? ''],
        ['Telephone', s.company.phone ?? ''],
        ['Courriel', s.company.email ?? ''],
        ['Identification fiscale', s.company.taxId ?? ''],
        ['Debut', s.from],
        ['Fin', s.to],
        ['Fuseau', s.timezone],
        ['Genere', s.generatedAt],
        ['Filtres', JSON.stringify(s.query)],
        [
          'Regles de filtre',
          'Soldes/courbes: toutes ecritures des caisses choisies. Utilisateur/categorie/type: journal et mouvements. Decisons: demandeur.',
        ],
        ['Montants', 'Chaines decimales exactes, devises separees'],
      ],
    );
    sheet(
      'Synthese',
      [
        'Devise',
        'Solde actuel',
        'Reserve',
        'Disponible',
        'Ouverture',
        'Cloture periode',
        'Encaissements',
        'Decaissements',
      ],
      s.totals.map((t) => [
        t.currency,
        t.balance,
        t.reserved,
        t.available,
        t.opening,
        t.closing,
        t.receipts,
        t.disbursements,
      ]),
    );
    sheet(
      'Ecarts',
      ['Devise', 'Comptages', 'Clotures avec ecart', 'Ecart net'],
      s.discrepancies.map((d) => [d.currency, d.measured, d.count, d.net ?? 'Non mesure']),
    );
    sheet(
      'Journal',
      [
        'Date UTC',
        'Operation',
        'Caisse',
        'Agence',
        'Utilisateur',
        'Type',
        'Sens',
        'Montant exact',
        'Devise',
        'Categorie',
        'Reference',
      ],
      s.rows.map((r) => [
        r.postedAt,
        r.operationId,
        r.cashName,
        r.agencyName,
        r.userName,
        r.kind,
        r.side,
        r.amount,
        r.currency,
        r.category,
        r.reference,
      ]),
    );
    sheet(
      'Evolution',
      ['Date locale', 'Devise', 'Solde'],
      s.daily.map((d) => [d.date, d.currency, d.balance]),
    );
    sheet(
      'Regroupements',
      ['Dimension', 'Nom', 'Devise', 'Entrees', 'Sorties'],
      s.groups.map((g) => [g.dimension, g.name, g.currency, g.incoming, g.outgoing]),
    );
    sheet(
      'Decisions',
      [
        'Demande',
        'Decision',
        'Devise',
        'Montant',
        'Demandeur',
        'Approbateur',
        'Date',
        'Motif',
        'Etat de demande',
        'Motif de decision',
      ],
      s.decisions.map((d) => [
        d.id,
        d.state,
        d.currency,
        d.amount,
        d.requester,
        d.approver ?? '',
        d.decidedAt ?? '',
        d.description,
        d.requestState,
        d.reason ?? '',
      ]),
    );
    sheet(
      'Clotures',
      ['PV', 'Caisse', 'Utilisateur', 'Date', 'Devise', 'Comptable', 'Compte', 'Ecart'],
      s.closures.flatMap((c) =>
        c.counts.map((v) => [
          c.number,
          c.cashName,
          c.closedBy,
          c.closedAt,
          v.currency,
          v.book,
          v.counted,
          v.difference,
        ]),
      ),
    );
    bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  }
  if (bytes.length > 1300000) throw new DataError('REPORT_TOO_LARGE');
  return reportFileSchema.parse({
    fileName: `CaissePro-${s.from}-${s.to}.${format}`,
    mimeType:
      format === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    dataBase64: bytes.toString('base64'),
  });
}
