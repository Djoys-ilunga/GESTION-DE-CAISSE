import { useReferences } from '../ui/use-references';
import { useFormBuffer, bufferedFields } from '../hybrid/use-form-buffer';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  expenseDetailsSchema,
  MAX_EVIDENCE_BYTES,
  type CashView,
  type FormBuffer,
  type SessionProfile,
} from '@caissepro/shared';
import { createLocalDraft } from '../hybrid/local-store';
import { readSupportingDocument } from '../cash/ReceiptForm';
import { message, type AuthGateway, type SessionDraft } from '../auth/gateway';

export function ExpenseForm({
  gateway,
  online = false,
  profile,
  cashes,
  source,
  buffer,
  copy,
  onSaved,
  onCancel,
}: {
  gateway: AuthGateway;
  online?: boolean;
  profile: SessionProfile;
  cashes: CashView[];
  source: SessionDraft | null;
  buffer?: FormBuffer;
  copy: boolean;
  onSaved(): void;
  onCancel(): void;
}) {
  const editing = copy ? null : source;
  const references = useReferences(gateway, online);
  const fields = bufferedFields(buffer);
  const [formId] = useState(editing?.draft.id ?? buffer?.id ?? crypto.randomUUID());
  const [agency, setAgency] = useState(
      source?.agencyId ?? buffer?.agencyId ?? profile.agencies[0]?.id ?? '',
    ),
    [cash, setCash] = useState(source?.cashRegisterId ?? buffer?.cashRegisterId ?? ''),
    [currency, setCurrency] = useState<'USD' | 'CDF'>(
      (fields.currency === 'USD' || fields.currency === 'CDF'
        ? fields.currency
        : source?.draft.currency) ?? 'USD',
    ),
    [amount, setAmount] = useState(fields.amount ?? source?.draft.amount ?? ''),
    [description, setDescription] = useState(fields.description ?? source?.draft.description ?? ''),
    [beneficiary, setBeneficiary] = useState(
      fields.beneficiary ?? source?.draft.expenseDetails?.beneficiary ?? '',
    ),
    [reference, setReference] = useState(
      fields.reference ?? source?.draft.expenseDetails?.reference ?? '',
    ),
    [category, setCategory] = useState(
      fields.category ?? source?.draft.expenseDetails?.category ?? '',
    ),
    [documents, setDocuments] = useState(source?.draft.expenseDetails?.documents ?? []),
    [files, setFiles] = useState<File[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const capture = useFormBuffer(
    gateway,
    {
      id: formId,
      kind: 'expense-request',
      agencyId: agency,
      cashRegisterId: cash || null,
      expectedLocalVersion: editing?.version ?? null,
      fields: { amount, currency, description, beneficiary, reference, category },
    },
    !busy && Boolean(agency),
  );
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (files.length > 3 || files.reduce((n, f) => n + f.size, 0) > MAX_EVIDENCE_BYTES)
        throw new Error('FILE_INVALID');
      const evidence = files.length
        ? await Promise.all(files.map(readSupportingDocument))
        : documents;
      if (!mounted.current) return;
      const details = expenseDetailsSchema.parse({
        beneficiary,
        reference,
        documents: evidence,
        ...(category.trim() ? { category: category.trim() } : {}),
      });
      const base = {
        kind: 'expense-request' as const,
        currency,
        amount: amount.trim().replace(',', '.'),
        description,
      };
      const draft = editing
        ? { ...editing.draft, ...base, expenseDetails: details }
        : { ...createLocalDraft(base), id: formId, expenseDetails: details };
      if (cash && !cashes.some((c) => c.id === cash && c.active && c.agency.id === agency))
        throw new Error('PERMISSION_DENIED');
      if (!editing && buffer) draft.expiresAt = buffer.expiresAt;
      await gateway.saveDraft({
        draft,
        agencyId: agency,
        cashRegisterId: cash || null,
        expectedVersion: editing?.version ?? null,
      });
      if (mounted.current) onSaved();
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <form className="panel editor-form" onSubmit={save}>
      <h2>
        {editing
          ? 'Modifier le brouillon'
          : copy
            ? 'Nouvelle demande (copie)'
            : 'Préparer une demande de dépense'}
      </h2>
      <p className="auth-notice">
        Non soumis. Enregistrer et synchroniser ce brouillon ne vaut ni approbation ni paiement.
      </p>
      <p className="section-description">
        {capture.state === 'captured'
          ? 'Saisie capturée temporairement dans votre session. Les fichiers doivent être enregistrés avec le brouillon.'
          : capture.state === 'unavailable'
            ? 'Saisie non capturée. Enregistrez le brouillon avant de quitter cet écran.'
            : 'Capture temporaire de la saisie…'}
      </p>
      <fieldset disabled={busy} className="expense-fields">
        <div className="form-grid">
          {profile.agencies.length === 1 ? (
            <div className="cash-choice" role="group" aria-label="Agence de la dépense">
              <span>Agence</span>
              <strong>{profile.agencies[0]?.name}</strong>
            </div>
          ) : (
            <label>
              Agence
              <select
                required
                disabled={Boolean(editing)}
                value={agency}
                onChange={(e) => {
                  setAgency(e.target.value);
                  setCash('');
                }}
              >
                {profile.agencies.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Caisse de paiement
            <select
              value={cash}
              disabled={Boolean(editing)}
              onChange={(e) => setCash(e.target.value)}
            >
              <option value="">Sans caisse / À préciser</option>
              {cashes
                .filter((c) => c.active && c.agency.id === agency)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Devise
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as typeof currency)}
            >
              <option>USD</option>
              <option>CDF</option>
            </select>
          </label>
          <label>
            Montant exact
            <input
              inputMode="decimal"
              required
              value={amount}
              maxLength={19}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </label>
          <label>
            Catégorie de dépense (facultatif)
            <input
              maxLength={80}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              list="expense-categories"
            />
            <datalist id="expense-categories">
              {references?.categories
                .filter((c) => c.kind === 'EXPENSE')
                .map((c) => (
                  <option key={c.id} value={c.name} />
                ))}
            </datalist>
          </label>
          <label>
            Bénéficiaire
            <input
              required
              maxLength={160}
              value={beneficiary}
              onChange={(e) => setBeneficiary(e.target.value)}
            />
          </label>
          <label>
            Référence
            <input
              maxLength={160}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          <label className="full-field">
            Motif
            <textarea
              required
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="full-field">
            Justificatifs (3 maximum, 1 Mio au total)
            <input
              type="file"
              multiple
              accept="application/pdf,image/png,image/jpeg"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          </label>
        </div>
        {documents.length > 0 && (
          <div>
            <p>Justificatifs conservés : {documents.map((d) => d.fileName).join(', ')}</p>
            <button type="button" className="text-button" onClick={() => setDocuments([])}>
              Retirer les justificatifs
            </button>
          </div>
        )}
        {editing && !cash && (
          <p className="auth-notice">
            La caisse d’un brouillon synchronisé reste fixe. Créez une copie avec une caisse pour
            pouvoir soumettre la demande.
          </p>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="action-buttons">
          <button className="primary-button">
            {busy ? 'Enregistrement…' : 'Enregistrer le brouillon'}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              capture.discard();
              onCancel();
            }}
          >
            Annuler
          </button>
        </div>
      </fieldset>
    </form>
  );
}
