import { useMoney } from '../money/MoneyContext';
import { createPortal } from 'react-dom';
import type { PaymentVoucher } from '@caissepro/shared';
import { formatDate } from '../cash/CashPage';
export function VoucherViewer({
  voucher,
  onClose,
  online,
}: {
  voucher: PaymentVoucher;
  onClose(): void;
  online: boolean;
}) {
  const { format: formatMoney } = useMoney();
  return createPortal(
    <div className="receipt-overlay">
      <section
        className="receipt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="voucher-title"
      >
        <div className="receipt-tools">
          <span>Bon émis par le serveur</span>
          <div className="action-buttons">
            <button className="secondary-button" disabled={!online} onClick={() => window.print()}>
              Imprimer le bon
            </button>
            <button className="secondary-button" onClick={onClose}>
              Fermer le bon
            </button>
          </div>
        </div>
        <article className="official-receipt" id="official-receipt">
          <header>
            <div>
              <p className="eyebrow">CAISSEPRO · {voucher.companyCode}</p>
              <h2>{voucher.companyName}</h2>
              <p>
                {voucher.agencyName} · {voucher.cashName}
              </p>
            </div>
          </header>
          <div className="receipt-title">
            <h1 id="voucher-title">Bon de sortie</h1>
            <strong>{voucher.number}</strong>
            <span className="receipt-status posted">Payé et comptabilisé</span>
          </div>
          <div className="receipt-amount">
            <span>Montant payé</span>
            <strong>
              {formatMoney(voucher.amount)} <small>{voucher.currency}</small>
            </strong>
          </div>
          <dl>
            {[
              ['Bénéficiaire', voucher.beneficiary],
              ['Motif', voucher.description],
              ['Référence', voucher.reference || 'Non renseignée'],
              ['Demandeur', voucher.requesterName],
              ['Approuvé par', voucher.approverName],
              ['Date d’approbation', formatDate(voucher.approvedAt)],
              ['Paiement confirmé par', voucher.cashierName],
              ['Date de comptabilisation', formatDate(voucher.postedAt)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <footer>
            <p>Référence de la demande : {voucher.expenseRequestId}</p>
            <p>Référence comptable : {voucher.operationId}</p>
            <p>
              Document issu d’une opération centrale immuable. Toute correction exige une
              contre-écriture traçable.
            </p>
          </footer>
        </article>
      </section>
    </div>,
    document.body,
  );
}
