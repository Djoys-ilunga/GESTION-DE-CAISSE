import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FilePlus2, Paperclip } from 'lucide-react';
import {
  MAX_EVIDENCE_BYTES,
  receiptDetailsSchema,
  type CashView,
  type SupportingDocument,
} from '@caissepro/shared';
import { createLocalDraft } from '../hybrid/local-store';
import { formatMoney } from './CashPage';
import { message, type AuthGateway, type SessionDraft } from '../auth/gateway';

export async function readSupportingDocument(file: File): Promise<SupportingDocument> {
  if (
    !file.size ||
    file.size > MAX_EVIDENCE_BYTES ||
    !['application/pdf', 'image/png', 'image/jpeg'].includes(file.type)
  )
    throw new Error('FILE_INVALID');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return {
    fileName: file.name,
    mimeType: file.type as SupportingDocument['mimeType'],
    dataBase64: btoa(binary),
  };
}
export function ReceiptForm({
  gateway,
  cashes,
  editing,
  onSaved,
  onCancel,
}: {
  gateway: AuthGateway;
  cashes: CashView[];
  editing: SessionDraft | null;
  onSaved(): void;
  onCancel(): void;
}) {
  const [cash, setCash] = useState(
      editing?.cashRegisterId ?? cashes.find((c) => c.active)?.id ?? '',
    ),
    [currency, setCurrency] = useState<'CDF' | 'USD'>(editing?.draft.currency ?? 'CDF'),
    [amount, setAmount] = useState(editing?.draft.amount ?? ''),
    [provenance, setProvenance] = useState(editing?.draft.receiptDetails?.provenance ?? ''),
    [category, setCategory] = useState(editing?.draft.receiptDetails?.category ?? ''),
    [description, setDescription] = useState(editing?.draft.description ?? ''),
    [reference, setReference] = useState(editing?.draft.receiptDetails?.reference ?? '');
  const [file, setFile] = useState<File | null>(null),
    [retained, setRetained] = useState(editing?.draft.receiptDetails?.supportingDocument ?? null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const selected = cashes.find((c) => c.id === cash && c.active);
      if (!selected) throw new Error('PERMISSION_DENIED');
      const document = file ? await readSupportingDocument(file) : retained;
      // Un changement d’utilisateur pendant la lecture du fichier annule l’envoi.
      if (!mounted.current) return;
      const receiptDetails = receiptDetailsSchema.parse({
        provenance,
        category,
        reference,
        supportingDocument: document,
      });
      const base = {
        kind: 'receipt' as const,
        currency,
        amount: amount.trim().replace(',', '.'),
        description,
      };
      const draft = editing
        ? { ...editing.draft, ...base, receiptDetails }
        : { ...createLocalDraft(base), receiptDetails };
      await gateway.saveDraft({
        draft,
        agencyId: selected.agency.id,
        cashRegisterId: selected.id,
        expectedVersion: editing?.version ?? null,
      });
      if (mounted.current) onSaved();
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error && e.message === 'FILE_INVALID'
            ? 'Choisissez un PDF, PNG ou JPEG de 1 Mio maximum.'
            : message(e),
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <form className="panel editor-form receipt-form" onSubmit={submit}>
      <div className="panel-heading">
        <h2>
          <FilePlus2 size={19} /> {editing ? 'Modifier le brouillon' : 'Préparer un encaissement'}
        </h2>
        <span className="receipt-status pending">Brouillon non comptabilisé</span>
      </div>
      <div className="form-grid">
        <label>
          Caisse
          <select
            required
            value={cash}
            disabled={Boolean(editing)}
            onChange={(e) => setCash(e.target.value)}
          >
            <option value="">Sélectionner une caisse</option>
            {cashes
              .filter((c) => c.active)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.agency.name} · {c.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Devise
          <select value={currency} onChange={(e) => setCurrency(e.target.value as typeof currency)}>
            <option>CDF</option>
            <option>USD</option>
          </select>
        </label>
        <label>
          Montant
          <input
            required
            inputMode="decimal"
            placeholder="0,00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            pattern="(?:0|[1-9][0-9]{0,15})[.,][0-9]{2}"
          />
        </label>
        <label>
          Provenance / payeur
          <input
            required
            maxLength={160}
            value={provenance}
            onChange={(e) => setProvenance(e.target.value)}
            placeholder="Client, partenaire…"
          />
        </label>
        <label>
          Catégorie
          <input
            required
            maxLength={80}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            list="receipt-categories"
          />
          <datalist id="receipt-categories">
            <option value="Ventes" />
            <option value="Prestations" />
            <option value="Apport" />
            <option value="Autres recettes" />
          </datalist>
        </label>
        <label>
          Référence
          <input
            maxLength={160}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Facture, contrat…"
          />
        </label>
        <label className="full-width">
          Motif
          <textarea
            required
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="full-width file-field">
          <span>
            <Paperclip size={15} /> Justificatif facultatif · PDF, PNG ou JPEG, 1 Mio maximum
          </span>
          <input
            aria-label="Justificatif"
            type="file"
            accept="application/pdf,image/png,image/jpeg"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {retained && (
            <span>
              {retained.fileName}{' '}
              <button className="text-button" type="button" onClick={() => setRetained(null)}>
                Retirer ce justificatif
              </button>
            </span>
          )}
        </label>
      </div>
      <p className="cash-freshness">
        Solde consulté dans cette devise :{' '}
        {(() => {
          const fund = cashes
            .find((c) => c.id === cash)
            ?.funds.find((f) => f.currency === currency);
          return fund ? `${formatMoney(fund.balance)} ${currency}` : 'indisponible';
        })()}
        . Ce brouillon ne modifie pas ce montant.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="section-description">
        Aucun reçu ni mouvement financier n’est créé ici. Le brouillon reste temporairement en
        mémoire pendant cette session ; transmettez-le au serveur avant son expiration.
      </p>
      <div className="action-buttons">
        <button className="primary-button" disabled={busy}>
          {busy ? 'Enregistrement…' : 'Enregistrer le brouillon'}
        </button>
        <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}
