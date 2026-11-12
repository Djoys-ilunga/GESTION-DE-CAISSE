import { useMoney, CurrencyOptions } from '../money/MoneyContext';
import { useReferences } from '../ui/use-references';
import { useFormBuffer, bufferedFields } from '../hybrid/use-form-buffer';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FilePlus2, Paperclip } from 'lucide-react';
import {
  MAX_EVIDENCE_BYTES,
  receiptDetailsSchema,
  type CashView,
  type FormBuffer,
  type SupportingDocument,
} from '@caissepro/shared';
import { createLocalDraft } from '../hybrid/local-store';
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
  online = false,
  cashes,
  editing,
  buffer,
  onSaved,
  onCancel,
}: {
  gateway: AuthGateway;
  online?: boolean;
  cashes: CashView[];
  editing: SessionDraft | null;
  buffer?: FormBuffer;
  onSaved(): void;
  onCancel(): void;
}) {
  const { format: formatMoney } = useMoney();
  const money = useMoney();
  const references = useReferences(gateway, online);
  const fields = bufferedFields(buffer);
  const [formId] = useState(editing?.draft.id ?? buffer?.id ?? crypto.randomUUID());
  const [cash, setCash] = useState(
      editing?.cashRegisterId ?? buffer?.cashRegisterId ?? cashes.find((c) => c.active)?.id ?? '',
    ),
    [currency, setCurrency] = useState<string>(
      fields.currency ?? editing?.draft.currency ?? money.preferred('CDF'),
    ),
    [amount, setAmount] = useState(fields.amount ?? editing?.draft.amount ?? ''),
    [provenance, setProvenance] = useState(
      fields.provenance ?? editing?.draft.receiptDetails?.provenance ?? '',
    ),
    [category, setCategory] = useState(
      fields.category ?? editing?.draft.receiptDetails?.category ?? '',
    ),
    [description, setDescription] = useState(
      fields.description ?? editing?.draft.description ?? '',
    ),
    [reference, setReference] = useState(
      fields.reference ?? editing?.draft.receiptDetails?.reference ?? '',
    );
  const [file, setFile] = useState<File | null>(null),
    [retained, setRetained] = useState(editing?.draft.receiptDetails?.supportingDocument ?? null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const availableCashes = cashes.filter((c) => c.active);
  const onlyCash = availableCashes.length === 1 ? availableCashes[0] : undefined;
  const onlyCashId = onlyCash?.id;
  // Mémoriser le choix initial, même si le catalogue arrive après le formulaire.
  // L'ajout d'une seconde caisse ne doit pas réaffecter le brouillon en cours.
  useEffect(() => {
    if (!cash && !editing && onlyCashId) setCash(onlyCashId);
  }, [cash, editing, onlyCashId]);
  const selectedAgency = cashes.find((c) => c.id === cash)?.agency.id ?? buffer?.agencyId;
  const capture = useFormBuffer(
    gateway,
    {
      id: formId,
      kind: 'receipt',
      agencyId: selectedAgency ?? '00000000-0000-4000-8000-000000000000',
      cashRegisterId: cash || null,
      expectedLocalVersion: editing?.version ?? null,
      fields: { amount, currency, description, provenance, category, reference },
    },
    !busy && Boolean(selectedAgency),
  );
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
        : { ...createLocalDraft(base), id: formId, receiptDetails };
      if (!editing && buffer) {
        draft.createdAt = buffer.createdAt;
        draft.expiresAt = buffer.expiresAt;
      }
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
      <p className="section-description">
        {capture.state === 'captured'
          ? 'Saisie reçue par le stockage natif. Vérifiez son mode dans le centre de synchronisation. Les fichiers doivent être enregistrés avec le brouillon.'
          : capture.state === 'unavailable'
            ? 'Saisie non capturée. Enregistrez le brouillon avant de quitter cet écran.'
            : 'Enregistrement de la saisie en cours…'}
      </p>
      <div className="form-grid">
        {onlyCash && cash === onlyCash.id ? (
          <div className="cash-choice" role="group" aria-label="Caisse d’encaissement">
            <span>Caisse</span>
            <strong>{onlyCash.name}</strong>
            <small>{onlyCash.agency.name}</small>
          </div>
        ) : (
          <label>
            Caisse
            <select
              required
              value={cash}
              disabled={Boolean(editing)}
              onChange={(e) => setCash(e.target.value)}
            >
              <option value="">Sélectionner une caisse</option>
              {availableCashes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.agency.name} · {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Devise
          <select value={currency} onChange={(e) => setCurrency(e.target.value as typeof currency)}>
            <CurrencyOptions include={currency} />
          </select>
        </label>
        <label>
          Montant
          <input
            required
            inputMode="decimal"
            placeholder={money.placeholder(currency)}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            pattern={money.pattern(currency)}
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
            {references?.categories
              .filter((c) => c.kind === 'RECEIPT')
              .map((c) => (
                <option key={c.id} value={c.name} />
              ))}
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
        Aucun reçu ni mouvement financier n’est créé ici. Le centre de synchronisation précise le
        mode de stockage. Transmettez le brouillon avant son expiration.
      </p>
      <div className="action-buttons">
        <button className="primary-button" disabled={busy}>
          {busy ? 'Enregistrement…' : 'Enregistrer le brouillon'}
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={() => {
            capture.discard();
            onCancel();
          }}
        >
          Annuler
        </button>
      </div>
    </form>
  );
}
