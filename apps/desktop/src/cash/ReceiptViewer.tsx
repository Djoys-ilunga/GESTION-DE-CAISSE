import { createPortal } from 'react-dom';
import { useState } from 'react';
import { CheckCircle2, Printer, X, Paperclip } from 'lucide-react';
import type { ConfirmedReceipt, SupportingDocument } from '@caissepro/shared';
import { message, type AuthGateway } from '../auth/gateway';
import { formatDate, formatMoney } from './CashPage';
export function ReceiptViewer({
  receipt,
  gateway,
  online,
  onClose,
}: {
  receipt: ConfirmedReceipt;
  gateway: AuthGateway;
  online: boolean;
  onClose(): void;
}) {
  const [evidence, setEvidence] = useState<SupportingDocument | null>(null),
    [error, setError] = useState('');
  return createPortal(
    <div className="receipt-overlay">
      <section
        className="receipt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="receipt-title"
      >
        <div className="receipt-tools">
          <span>Reçu émis par le serveur</span>
          <div className="action-buttons">
            <button className="secondary-button" disabled={!online} onClick={() => window.print()}>
              <Printer size={15} />
              Imprimer
            </button>
            <button className="secondary-button" onClick={onClose} aria-label="Fermer le reçu">
              <X size={17} />
            </button>
          </div>
        </div>
        <article className="official-receipt" id="official-receipt">
          <header>
            <div>
              <p className="eyebrow">CAISSEPRO · {receipt.companyCode}</p>
              <h2>{receipt.companyName}</h2>
              <p>
                {receipt.agencyName} · {receipt.cashName}
              </p>
            </div>
            <CheckCircle2 size={34} />
          </header>
          <div className="receipt-title">
            <h1 id="receipt-title">Reçu d’encaissement</h1>
            <strong>{receipt.number}</strong>
            <span className="receipt-status posted">Confirmé et comptabilisé</span>
          </div>
          <div className="receipt-amount">
            <span>Montant reçu</span>
            <strong>
              {formatMoney(receipt.amount)} <small>{receipt.currency}</small>
            </strong>
          </div>
          <dl>
            <div>
              <dt>Reçu de</dt>
              <dd>{receipt.provenance}</dd>
            </div>
            <div>
              <dt>Catégorie</dt>
              <dd>{receipt.category}</dd>
            </div>
            <div>
              <dt>Motif</dt>
              <dd>{receipt.description}</dd>
            </div>
            <div>
              <dt>Référence</dt>
              <dd>{receipt.reference || 'Non renseignée'}</dd>
            </div>
            <div>
              <dt>Date de comptabilisation</dt>
              <dd>{formatDate(receipt.postedAt)} · Kinshasa</dd>
            </div>
            <div>
              <dt>Encaissement confirmé par</dt>
              <dd>{receipt.cashierName}</dd>
            </div>
          </dl>
          {receipt.evidence && (
            <div className="receipt-evidence">
              <Paperclip size={16} />
              <span>
                Justificatif : {receipt.evidence.fileName}
                <small>
                  {receipt.evidence.byteLength} octets · SHA-256 {receipt.evidence.sha256}
                </small>
              </span>
            </div>
          )}
          <footer>
            <p>Référence comptable : {receipt.operationId}</p>
            <p>
              Ce reçu correspond à une opération centrale immuable. Toute correction exige une
              contre-écriture traçable.
            </p>
          </footer>
        </article>
        {receipt.evidence && (
          <div className="receipt-attachment">
            <button
              className="secondary-button"
              disabled={!online}
              onClick={() =>
                void gateway
                  .receiptEvidence(receipt.id)
                  .then(setEvidence)
                  .catch((e) => setError(message(e)))
              }
            >
              Consulter le justificatif
            </button>
            {evidence &&
              (evidence.mimeType.startsWith('image/') ? (
                <img
                  alt="Justificatif de l’encaissement"
                  src={`data:${evidence.mimeType};base64,${evidence.dataBase64}`}
                />
              ) : (
                <p>
                  PDF conservé sur le serveur : {evidence.fileName}. La prévisualisation PDF et
                  l’export sur disque ne sont pas activés dans cette version.
                </p>
              ))}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}
