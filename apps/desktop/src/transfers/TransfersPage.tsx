import { StorageNotice } from '../hybrid/StorageNotice';
import { useMoney, CurrencyOptions } from '../money/MoneyContext';
import { currencyPrecision } from '@caissepro/shared';
import { useReferences } from '../ui/use-references';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  transferDraftSchema,
  type SessionProfile,
  type CashSnapshot,
  type FormBuffer,
  type TransferView,
  type ExchangeQuote,
} from '@caissepro/shared';
import { message, type AuthGateway } from '../auth/gateway';
import { formatDate } from '../cash/CashPage';
import { FinancialAction, preparationRestriction } from '../ui/FinancialAccess';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import '../cash/cash.css';
import './transfers.css';
const stateLabel = {
  DRAFT: 'Brouillon transmis',
  HANDED_OVER: 'Remis · fonds réservés',
  RECEIVED: 'Reçu et comptabilisé',
};
export function TransfersPage({
  profile,
  gateway,
  online,
  initialBufferId,
}: {
  profile: SessionProfile;
  gateway: AuthGateway;
  online: boolean;
  initialBufferId?: string;
}) {
  const { format: formatMoney } = useMoney();
  const money = useMoney();
  const references = useReferences(gateway, online);
  const [catalog, setCatalog] = useState<CashSnapshot | null>(null),
    [buffers, setBuffers] = useState<FormBuffer[]>([]),
    [rows, setRows] = useState<TransferView[]>([]);
  const [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [id, setId] = useState<string>(() => crypto.randomUUID()),
    [source, setSource] = useState(''),
    [destination, setDestination] = useState('');
  const [currency, setCurrency] = useState<string>(() => money.preferred('USD')),
    [targetCurrency, setTargetCurrency] = useState<string>(() => money.preferred('USD'));
  const [amount, setAmount] = useState(''),
    [rate, setRate] = useState(''),
    [rateSource, setRateSource] = useState(''),
    [description, setDescription] = useState('');
  const [quote, setQuote] = useState<ExchangeQuote | null>(null),
    [rateMode, setRateMode] = useState<'BCC' | 'MANUAL'>('MANUAL'),
    [rateJustification, setRateJustification] = useState('');
  const [selected, setSelected] = useState<TransferView | null>(null),
    [confirmation, setConfirmation] = useState(false),
    [rateValidated, setRateValidated] = useState(false),
    [slip, setSlip] = useState<TransferView | null>(null);
  const alive = useRef(true),
    latestOnline = useRef(online);
  latestOnline.current = online;
  const canPrepare = profile.permissions.includes('draft:write_own');
  const canExecute = profile.permissions.includes('transfer:post');
  const composer = useRef<HTMLHeadingElement>(null);
  const [newKind, setNewKind] = useState<'transfer' | 'conversion' | null>(null);
  const [resumeBuffer, setResumeBuffer] = useState<FormBuffer | null>(null);
  const initialOpened = useRef(false);
  function resume(b: FormBuffer) {
    if (b.transmissionState) {
      setNotice(
        'Cette préparation a déjà été transmise. Utilisez « Transmettre ou retrouver » pour consulter sa copie serveur.',
      );
      return;
    }
    setId(b.id);
    setSource(b.cashRegisterId ?? '');
    setDestination(b.fields.destinationCashRegisterId ?? '');
    setCurrency(b.fields.currency ?? money.preferred('USD'));
    setTargetCurrency(b.fields.destinationCurrency ?? money.preferred('USD'));
    setAmount(b.fields.amount ?? '');
    setRate(b.fields.rate ?? '');
    setRateSource(b.fields.rateSource ?? '');
    setDescription(b.fields.description ?? '');
    setRateMode(b.fields.rateMode === 'BCC' ? 'BCC' : 'MANUAL');
    setRateJustification(b.fields.rateJustification ?? '');
    setQuote(null);
    setResumeBuffer(null);
    setError('');
    setNotice(
      'Préparation reprise avec son identifiant. Vérifiez à nouveau le taux serveur avant de conserver une conversion en ligne.',
    );
    composer.current?.focus();
    composer.current?.scrollIntoView?.({ block: 'start' });
  }
  function requestResume(b: FormBuffer) {
    if (source || destination || amount || description || rate || rateSource || rateJustification)
      setResumeBuffer(b);
    else resume(b);
  }
  const prepareReason =
    preparationRestriction(profile, online) ||
    (catalog?.data.items.every((c) => !c.active)
      ? 'Aucune caisse active autorisée. Demandez une affectation dans Utilisateurs.'
      : '');
  function start(kind: 'transfer' | 'conversion') {
    if (prepareReason || (kind === 'conversion' && money.active.length < 2)) return;
    const from = money.preferred('USD');
    setId(crypto.randomUUID());
    setSource('');
    setDestination('');
    setAmount('');
    setDescription('');
    setRate('');
    setRateSource('');
    setRateJustification('');
    setRateMode('MANUAL');
    setQuote(null);
    setCurrency(from);
    setTargetCurrency(kind === 'conversion' ? money.active.find((c) => c !== from)! : from);
    setNewKind(null);
    setError('');
    setNotice('');
    composer.current?.focus();
    composer.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }
  function requestStart(kind: 'transfer' | 'conversion') {
    if (
      source ||
      destination ||
      amount ||
      description ||
      rate ||
      rateSource ||
      rateJustification ||
      currency !== money.preferred('USD') ||
      targetCurrency !== money.preferred('USD')
    )
      setNewKind(kind);
    else start(kind);
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function load() {
    const results = await Promise.allSettled([
      gateway.cashCatalog(),
      canPrepare ? gateway.formBuffers() : Promise.resolve([]),
      online ? gateway.transferList(page) : Promise.resolve(null),
    ]);
    if (!alive.current) return;
    if (results[0].status === 'fulfilled') setCatalog(results[0].value);
    if (results[1].status === 'fulfilled') {
      const found = results[1].value.filter((b) => b.kind === 'transfer');
      setBuffers(found);
      if (initialBufferId && !initialOpened.current) {
        initialOpened.current = true;
        const b = found.find((b) => b.id === initialBufferId);
        if (b) resume(b);
        else
          setError(
            'Cette préparation n’est plus accessible. Actualisez les brouillons de votre session.',
          );
      }
    }
    if (results[2].status === 'fulfilled' && results[2].value && latestOnline.current) {
      setRows(results[2].value.items);
      setTotal(results[2].value.total);
    }
    const failed = results.find((r) => r.status === 'rejected');
    if (failed?.status === 'rejected') setError(message(failed.reason));
  }
  useEffect(() => {
    if (!online) {
      setRows([]);
      setSelected(null);
      setSlip(null);
    }
    void load();
  }, [online, page]);
  const items = catalog?.data.items.filter((r) => r.active) ?? [];
  const sourceCash = items.find((r) => r.id === source),
    fx = currency !== targetCurrency;
  useEffect(() => {
    setQuote(null);
  }, [currency, targetCurrency, amount, rateMode, rate, rateSource, rateJustification, online]);
  const rateInput = JSON.stringify([
    currency,
    targetCurrency,
    amount,
    rateMode,
    rate,
    rateSource,
    rateJustification,
  ]);
  const latestRateInput = useRef(rateInput);
  latestRateInput.current = rateInput;
  async function checkRate() {
    const requestedInput = rateInput;
    await action(async () => {
      const q = await gateway.exchangeQuote({
        fromCurrency: currency,
        toCurrency: targetCurrency,
        amount: amount.replace(',', '.'),
        mode: rateMode,
        ...(rateMode === 'MANUAL'
          ? {
              manualRate: rate.replace(',', '.'),
              manualSource: rateSource,
              justification: rateJustification,
              manualEffectiveAt: new Date().toISOString(),
            }
          : {}),
      });
      if (alive.current && latestOnline.current && latestRateInput.current === requestedInput)
        setQuote(q);
    });
  }
  async function checkBufferRate(b: FormBuffer) {
    if (!online) return;
    await action(async () => {
      const mode = b.fields.rateMode ?? 'MANUAL';
      const q = await gateway.exchangeQuote({
        fromCurrency: b.fields.currency!,
        toCurrency: b.fields.destinationCurrency!,
        amount: b.fields.amount!,
        mode,
        ...(mode === 'MANUAL'
          ? {
              manualRate: b.fields.rate!,
              manualSource: b.fields.rateSource!,
              justification: b.fields.rateJustification || b.fields.rateSource!,
              manualEffectiveAt: b.fields.rateEffectiveAt || b.createdAt,
            }
          : {}),
      });
      if (!alive.current || !latestOnline.current) return;
      await gateway.saveFormBuffer({
        id: b.id,
        kind: b.kind,
        agencyId: b.agencyId,
        cashRegisterId: b.cashRegisterId,
        expectedLocalVersion: b.expectedLocalVersion,
        fields: {
          ...b.fields,
          rateQuoteId: q.id,
          rate: q.appliedRate,
          rateSource: q.source,
          rateMode: q.mode,
        },
      });
      setNotice(
        'Taux serveur vérifié pour ce brouillon. Relisez le taux avant de transmettre ; aucune remise effectuée.',
      );
      await load();
    });
  }
  const funds = sourceCash?.funds.find((f) => f.currency === currency);
  const cashName = (cashId: string) =>
    catalog?.data.items.find((r) => r.id === cashId)?.name ??
    profile.cashRegisters.find((r) => r.id === cashId)?.name ??
    cashId;
  const choose = (row: TransferView) => {
    setSelected(row);
    setConfirmation(false);
    setRateValidated(false);
    setSlip(null);
  };
  async function action(run: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await run();
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (fx && online && (!quote || Date.parse(quote.expiresAt) <= Date.now())) {
      setError('Vérifiez un taux serveur avant de conserver cette conversion.');
      return;
    }
    const parsed = transferDraftSchema.safeParse({
      id,
      sourceCashRegisterId: source,
      destinationCashRegisterId: destination,
      sourceCurrency: currency,
      destinationCurrency: targetCurrency,
      amount: amount.replace(',', '.'),
      rate: fx ? (quote?.appliedRate ?? rate.replace(',', '.')) : null,
      rateSource: fx ? (quote?.source ?? rateSource) : '',
      ...(fx && quote ? { rateQuoteId: quote.id } : {}),
      description,
    });
    if (!parsed.success) {
      setError(
        'Vérifiez les caisses, les montants et leur précision et le taux explicite de conversion.',
      );
      return;
    }
    if (!sourceCash) return;
    await action(async () => {
      await gateway.saveFormBuffer({
        id,
        kind: 'transfer',
        agencyId: sourceCash.agency.id,
        cashRegisterId: source,
        expectedLocalVersion: null,
        fields: {
          amount: amount.replace(',', '.'),
          currency,
          destinationCashRegisterId: destination,
          destinationCurrency: targetCurrency,
          rate: fx ? (quote?.appliedRate ?? rate.replace(',', '.')) : '',
          rateSource: fx ? (quote?.source ?? rateSource) : '',
          ...(fx
            ? {
                rateMode,
                rateJustification,
                rateEffectiveAt: quote?.effectiveAt ?? new Date().toISOString(),
              }
            : {}),
          ...(fx && quote ? { rateQuoteId: quote.id } : {}),
          description,
        },
      });
      if (!alive.current) return;
      setNotice(
        'Brouillon reçu par le stockage natif. Consultez son mode de conservation. Aucun mouvement financier ; transmettez-le explicitement après connexion.',
      );
      setQuote(null);
      setId(crypto.randomUUID());
      setAmount('');
      setDescription('');
      await load();
    });
  }
  async function send(buffer: FormBuffer) {
    if (!online) return;
    await action(async () => {
      const row = await gateway.sendTransfer(buffer.id);
      if (!alive.current || !latestOnline.current) return;
      choose(row);
      setNotice(
        'Copie retrouvée sur le serveur. La transmission seule ne remet ni ne comptabilise les fonds.',
      );
      await load();
    });
  }
  async function confirm() {
    if (!selected || !online || !confirmation) return;
    const row = selected;
    await action(async () => {
      const next =
        row.state === 'DRAFT'
          ? await gateway.handoverTransfer(row.id, row.version, true, rateValidated)
          : await gateway.receiveTransfer(row.id, row.version, true);
      if (!alive.current || !latestOnline.current) return;
      choose(next);
      setNotice(
        next.state === 'RECEIVED'
          ? 'Réception et comptabilisation centrales confirmées.'
          : 'Remise confirmée : fonds réservés, réception par un autre utilisateur requise.',
      );
      await load();
    });
  }
  return (
    <div className="transfer-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">MOUVEMENTS INTERNES</p>
          <h1>Transferts et conversions</h1>
          <p>Préparer → transmettre → remettre → recevoir. Un transfert n’est pas une recette.</p>
        </div>
        <div className="action-buttons">
          <FinancialAction
            label="Nouveau transfert"
            reason={prepareReason}
            busy={busy}
            onClick={() => requestStart('transfer')}
          />
          <FinancialAction
            label="Nouvelle conversion"
            reason={
              prepareReason ||
              (money.active.length < 2
                ? 'Deux devises actives sont nécessaires pour une conversion.'
                : '')
            }
            busy={busy}
            onClick={() => requestStart('conversion')}
          />
          <button className="secondary-button" disabled={busy} onClick={() => void action(load)}>
            Actualiser
          </button>
        </div>
      </header>
      {newKind && (
        <ConfirmDialog
          title="Commencer une nouvelle préparation ?"
          onCancel={() => setNewKind(null)}
          onConfirm={() => start(newKind)}
        >
          <p>
            La saisie affichée sera remplacée. Les brouillons déjà conservés et les opérations
            transmises restent disponibles. Annulez pour conserver d’abord votre saisie.
          </p>
        </ConfirmDialog>
      )}
      {resumeBuffer && (
        <ConfirmDialog
          title="Reprendre cette préparation ?"
          onCancel={() => setResumeBuffer(null)}
          onConfirm={() => resume(resumeBuffer)}
        >
          <p>La saisie affichée sera remplacée. Conservez-la d’abord si nécessaire.</p>
        </ConfirmDialog>
      )}
      {canPrepare && (
        <p className="auth-notice">
          Préparation autorisée. Remise et réception :{' '}
          {canExecute ? 'autorisées dans vos caisses' : 'rôle financier de transfert requis'}.{' '}
          Conversion :{' '}
          {profile.permissions.includes('fx:post')
            ? 'validation autorisée'
            : 'rôle de conversion requis'}
          . Le serveur revalide les fonds, les taux et les autorisations ; la réception exige un
          autre utilisateur.
        </p>
      )}
      {!online && (
        <p role="status" className="transfer-warning">
          Hors connexion : préparation uniquement. Soldes non actualisés ; aucune remise, réception
          ou conversion exécutée.
        </p>
      )}
      <StorageNotice gateway={gateway} />
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {canPrepare && (
        <section className="panel">
          <h2 ref={composer} tabIndex={-1}>
            {fx ? 'Préparer une conversion' : 'Préparer un transfert'}
          </h2>
          <form onSubmit={(e) => void save(e)} className="transfer-form">
            <label>
              Caisse source
              <select required value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Choisir la source</option>
                {items.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.agency.name} · {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Caisse destination
              <select required value={destination} onChange={(e) => setDestination(e.target.value)}>
                <option value="">Choisir la destination</option>
                {items.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.agency.name} · {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Devise source
              <select value={currency} onChange={(e) => setCurrency(e.target.value as string)}>
                <CurrencyOptions include={currency} />
              </select>
            </label>
            <label>
              Devise destination
              <select
                value={targetCurrency}
                onChange={(e) => setTargetCurrency(e.target.value as string)}
              >
                <CurrencyOptions include={targetCurrency} />
              </select>
            </label>
            <label>
              Montant à remettre
              <input
                required
                inputMode="decimal"
                pattern={money.pattern(currency)}
                placeholder={money.placeholder(currency)}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            {fx && (
              <>
                <label>
                  Origine du taux de conversion
                  <select
                    value={rateMode}
                    onChange={(e) => setRateMode(e.target.value as 'BCC' | 'MANUAL')}
                  >
                    <option value="MANUAL">Taux manuel justifié</option>
                    <option value="BCC" disabled={!online}>
                      Dernière publication BCC
                    </option>
                  </select>
                </label>
                {rateMode === 'MANUAL' && (
                  <label>
                    Justification du taux manuel
                    <input
                      required
                      minLength={3}
                      maxLength={500}
                      value={rateJustification}
                      onChange={(e) => setRateJustification(e.target.value)}
                    />
                  </label>
                )}
                {online && references && (
                  <label>
                    Taux de référence publié
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        const selected = references.rates.find((r) => r.id === e.target.value);
                        if (selected) {
                          setRate(selected.rate);
                          setRateSource(selected.source);
                        }
                      }}
                    >
                      <option value="">Saisie manuelle ou choix d’un taux</option>
                      {references.rates
                        .filter(
                          (r) => r.fromCurrency === currency && r.toCurrency === targetCurrency,
                        )
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.rate} — {r.source} — {formatDate(r.validFrom)}
                          </option>
                        ))}
                    </select>
                    <small>Le taux retenu reste à valider explicitement à la remise.</small>
                  </label>
                )}
                <label>
                  Taux : 1 {currency} = … {targetCurrency}
                  <input
                    required={rateMode === 'MANUAL'}
                    disabled={rateMode === 'BCC'}
                    inputMode="decimal"
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                  />
                </label>
                <label>
                  Source du taux
                  <input
                    required
                    maxLength={100}
                    disabled={rateMode === 'BCC'}
                    value={rateSource}
                    onChange={(e) => setRateSource(e.target.value)}
                  />
                </label>
                {online && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void checkRate()}
                  >
                    Vérifier le taux serveur
                  </button>
                )}
                {quote && (
                  <p role="status">
                    {quote.mode === 'BCC' ? 'BCC' : 'Manuel'} : 1 {quote.fromCurrency} ={' '}
                    {quote.appliedRate} {quote.toCurrency} · Montant de destination :{' '}
                    {quote.targetAmount} · Valable jusqu’au {formatDate(quote.expiresAt)}.
                  </p>
                )}
                <p>
                  Montant reçu calculé par le serveur, arrondi final HALF_UP à la précision de
                  destination. Aucun taux implicite.
                </p>
              </>
            )}
            <label>
              Motif
              <input
                required
                maxLength={500}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <p>
              Disponible{' '}
              {online && !catalog?.stale ? 'à la dernière consultation' : 'non actualisé'} :{' '}
              {funds ? `${formatMoney(funds.available)} ${currency}` : 'non consulté'}. Le serveur
              revérifie les fonds lors de la remise.
            </p>
            <button className="primary-button" disabled={busy}>
              Conserver le brouillon
            </button>
          </form>
        </section>
      )}
      {canPrepare && (
        <section className="panel">
          <h2>Brouillons locaux de transfert</h2>
          {buffers.length === 0 && <p>Aucun brouillon local.</p>}
          {buffers.map((b) => (
            <div key={b.id} className="transfer-row">
              <span>
                {b.fields.description} · {b.fields.amount} {b.fields.currency}{' '}
                {b.fields.rate &&
                  `· Taux ${b.fields.rate} · ${b.fields.rateMode ?? 'Manuel historique'}`}
              </span>
              {b.transmissionState && (
                <p>
                  {b.transmissionState === 'uncertain'
                    ? 'Accusé non confirmé : retrouvez la copie serveur avant toute suppression.'
                    : 'Copie reçue par le serveur ; consultez son état financier en ligne.'}
                  {b.transmissionChanged
                    ? ' Les corrections locales diffèrent de la copie transmise.'
                    : ''}
                </p>
              )}
              <button
                className="secondary-button"
                disabled={busy || Boolean(b.transmissionState)}
                onClick={() => requestResume(b)}
              >
                Reprendre la préparation
              </button>
              {b.fields.currency !== b.fields.destinationCurrency && (
                <button
                  className="secondary-button"
                  disabled={!online || busy || Boolean(b.transmissionState)}
                  onClick={() => void checkBufferRate(b)}
                >
                  Vérifier le taux de ce brouillon
                </button>
              )}
              <button
                className="secondary-button"
                disabled={
                  !online ||
                  busy ||
                  (!b.transmissionState &&
                    b.fields.currency !== b.fields.destinationCurrency &&
                    !b.fields.rateQuoteId)
                }
                onClick={() => void send(b)}
              >
                Transmettre ou retrouver
              </button>
              <button
                className="secondary-button"
                disabled={busy || b.transmissionState === 'uncertain'}
                onClick={() =>
                  void action(async () => {
                    await gateway.removeFormBuffer(b.id);
                    await load();
                  })
                }
              >
                Supprimer la copie locale
              </button>
            </div>
          ))}
        </section>
      )}
      <section className="panel">
        <h2>Historique serveur</h2>
        <p>
          {online
            ? 'Les deux caisses doivent appartenir à votre périmètre autorisé.'
            : 'Reconnectez-vous pour consulter les transferts.'}
        </p>
        {rows.map((r) => (
          <button
            key={r.id}
            className="transfer-history"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const fresh = await gateway.transferDetail(r.id);
                if (alive.current && latestOnline.current) choose(fresh);
              })
            }
          >
            <span>{r.description}</span>
            <strong>
              {formatMoney(r.amount)} {r.sourceCurrency} → {formatMoney(r.targetAmount)}{' '}
              {r.destinationCurrency}
            </strong>
            <span>{stateLabel[r.state]}</span>
          </button>
        ))}
        {online && (
          <div className="action-buttons">
            <button disabled={busy || page === 1} onClick={() => setPage(page - 1)}>
              Précédent
            </button>
            <span>
              Page {page} · {total} transferts
            </span>
            <button disabled={busy || page * 25 >= total} onClick={() => setPage(page + 1)}>
              Suivant
            </button>
          </div>
        )}
      </section>
      {selected && online && (
        <section className="panel">
          <h2>Détail du transfert</h2>
          <p>
            {selected.description} · {stateLabel[selected.state]}
          </p>
          <p>
            {formatMoney(selected.amount)} {selected.sourceCurrency} →{' '}
            {formatMoney(selected.targetAmount)} {selected.destinationCurrency}
          </p>
          <p>
            {selected.rate
              ? `Taux : ${selected.rate} ${selected.destinationCurrency} pour 1 ${selected.sourceCurrency} · ${selected.rateSource} · HALF_UP à ${money.precision(selected.destinationCurrency)} décimales`
              : 'Même devise, sans conversion.'}
          </p>
          <p>
            Source : {cashName(selected.sourceCashRegisterId)} · Destination :{' '}
            {cashName(selected.destinationCashRegisterId)}
          </p>
          <p>Référence : {selected.id}</p>
          {selected.rate && (
            <p>
              Origine : {selected.rateOrigin ?? 'MANUAL'} · Proposition serveur :{' '}
              {selected.rateQuoteId ?? 'Déclaration manuelle historique'}.
            </p>
          )}
          {selected.rateEvidence && (
            <details>
              <summary>Traçabilité immuable du taux</summary>
              <dl className="rate-evidence">
                {[
                  ['publicationDate', 'Publication officielle'],
                  ['quoteKind', 'Type de cours'],
                  ['referenceRate', 'Taux de référence'],
                  ['appliedRate', 'Taux appliqué'],
                  ['source', 'Source'],
                  ['justification', 'Justification manuelle'],
                  ['confirmedAt', 'Fixé à la remise le'],
                  ['publicationSourceUrl', 'Document officiel'],
                ].map(([key, label]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>{String(selected.rateEvidence?.[key!] ?? '—')}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
          {selected.state === 'HANDED_OVER' && (
            <p>
              Remise le {formatDate(selected.handedOverAt!)}. Les fonds sont indisponibles à la
              source, sans crédit anticipé à destination.
            </p>
          )}
          {canExecute &&
            (selected.state === 'DRAFT'
              ? selected.authorId === profile.user.id
              : selected.state === 'HANDED_OVER' &&
                selected.handedOverById !== profile.user.id) && (
              <>
                {selected.state === 'DRAFT' && selected.rate && (
                  <label className="transfer-check">
                    <input
                      type="checkbox"
                      checked={rateValidated}
                      onChange={(e) => setRateValidated(e.target.checked)}
                    />
                    Je valide explicitement ce taux et le montant de destination.
                  </label>
                )}
                <label className="transfer-check">
                  <input
                    type="checkbox"
                    checked={confirmation}
                    onChange={(e) => setConfirmation(e.target.checked)}
                  />
                  {selected.state === 'DRAFT'
                    ? 'Je confirme la remise effective des fonds indiqués.'
                    : 'Je confirme la réception effective du montant de destination indiqué.'}
                </label>
                <button
                  className="primary-button"
                  disabled={
                    busy ||
                    !confirmation ||
                    (!!selected.rate &&
                      (!profile.permissions.includes('fx:post') ||
                        (selected.state === 'DRAFT' && !rateValidated)))
                  }
                  onClick={() => void confirm()}
                >
                  {selected.state === 'DRAFT'
                    ? 'Confirmer la remise'
                    : 'Confirmer la réception et comptabiliser'}
                </button>
              </>
            )}
          {selected.state === 'HANDED_OVER' && selected.handedOverById === profile.user.id && (
            <p>Un autre utilisateur autorisé doit confirmer la réception.</p>
          )}
          {selected.slip && (
            <button className="primary-button" disabled={busy} onClick={() => setSlip(selected)}>
              Voir le bordereau
            </button>
          )}
        </section>
      )}
      {slip?.slip && online && <TransferSlip row={slip} onClose={() => setSlip(null)} />}
    </div>
  );
}
function TransferSlip({ row, onClose }: { row: TransferView; onClose(): void }) {
  const { format: formatMoney } = useMoney();
  const slip = row.slip!;
  return createPortal(
    <div className="receipt-overlay">
      <section
        className="receipt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="transfer-slip-title"
      >
        <div className="receipt-tools">
          <button onClick={() => window.print()}>Imprimer le bordereau</button>
          <button onClick={onClose}>Fermer le bordereau</button>
        </div>
        <article className="official-receipt" id="official-receipt">
          <header>
            <h2>{slip.companyName}</h2>
          </header>
          <h1 id="transfer-slip-title">Bordereau de transfert</h1>
          <strong>{slip.number}</strong>
          <p>Reçu et comptabilisé · Mouvement interne, hors recettes</p>
          <dl>
            {[
              ['Source', `${slip.sourceAgencyName} · ${slip.sourceCashName}`],
              ['Destination', `${slip.destinationAgencyName} · ${slip.destinationCashName}`],
              ['Montant remis', `${formatMoney(row.amount)} ${row.sourceCurrency}`],
              ['Montant reçu', `${formatMoney(row.targetAmount)} ${row.destinationCurrency}`],
              ['Taux', row.rate ? `${row.rate} · ${row.rateSource}` : 'Sans conversion'],
              ...(row.rate
                ? [
                    ['Origine du taux', row.rateOrigin ?? 'MANUAL'],
                    [
                      'Publication BCC',
                      String(
                        row.rateEvidence?.publicationDate ?? 'Aucune publication BCC vérifiée',
                      ),
                    ],
                    [
                      'Taux de référence',
                      String(row.rateEvidence?.referenceRate ?? 'Non renseigné'),
                    ],
                    [
                      'Justification manuelle',
                      String(row.rateEvidence?.justification ?? 'Sans objet'),
                    ],
                  ]
                : []),
              [
                'Arrondi',
                `HALF_UP final à ${currencyPrecision(row.destinationCurrency)} décimales`,
              ],
              ['Motif', row.description],
              ['Remis par', `${slip.handedOverByName} · ${formatDate(slip.handedOverAt)}`],
              ['Reçu par', `${slip.receivedByName} · ${formatDate(slip.receivedAt)}`],
              ['Référence comptable', row.operationId!],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <footer>
            Document central immuable. Toute correction exige une contre-écriture traçable.
          </footer>
        </article>
      </section>
    </div>,
    document.body,
  );
}
