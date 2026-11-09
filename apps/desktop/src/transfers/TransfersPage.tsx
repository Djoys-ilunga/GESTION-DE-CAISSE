import { useReferences } from '../ui/use-references';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  transferDraftSchema,
  type SessionProfile,
  type CashSnapshot,
  type FormBuffer,
  type TransferView,
} from '@caissepro/shared';
import { message, type AuthGateway } from '../auth/gateway';
import { formatDate, formatMoney } from '../cash/CashPage';
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
}: {
  profile: SessionProfile;
  gateway: AuthGateway;
  online: boolean;
}) {
  const references = useReferences(gateway, online);
  const [catalog, setCatalog] = useState<CashSnapshot | null>(null),
    [buffers, setBuffers] = useState<FormBuffer[]>([]),
    [rows, setRows] = useState<TransferView[]>([]);
  const [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [id, setId] = useState(() => crypto.randomUUID()),
    [source, setSource] = useState(''),
    [destination, setDestination] = useState('');
  const [currency, setCurrency] = useState<'CDF' | 'USD'>('USD'),
    [targetCurrency, setTargetCurrency] = useState<'CDF' | 'USD'>('USD');
  const [amount, setAmount] = useState(''),
    [rate, setRate] = useState(''),
    [rateSource, setRateSource] = useState(''),
    [description, setDescription] = useState('');
  const [selected, setSelected] = useState<TransferView | null>(null),
    [confirmation, setConfirmation] = useState(false),
    [rateValidated, setRateValidated] = useState(false),
    [slip, setSlip] = useState<TransferView | null>(null);
  const alive = useRef(true),
    latestOnline = useRef(online);
  latestOnline.current = online;
  const canPrepare = profile.permissions.includes('draft:write_own');
  const canExecute = profile.permissions.includes('transfer:post');
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
    if (results[1].status === 'fulfilled')
      setBuffers(results[1].value.filter((b) => b.kind === 'transfer'));
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
    const parsed = transferDraftSchema.safeParse({
      id,
      sourceCashRegisterId: source,
      destinationCashRegisterId: destination,
      sourceCurrency: currency,
      destinationCurrency: targetCurrency,
      amount,
      rate: fx ? rate : null,
      rateSource: fx ? rateSource : '',
      description,
    });
    if (!parsed.success) {
      setError(
        'Vérifiez les caisses, les montants (ex. 25.00) et le taux explicite de conversion.',
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
          amount,
          currency,
          destinationCashRegisterId: destination,
          destinationCurrency: targetCurrency,
          rate: fx ? rate : '',
          rateSource: fx ? rateSource : '',
          description,
        },
      });
      if (!alive.current) return;
      setNotice(
        'Brouillon conservé en mémoire native. Aucun mouvement financier. Transmettez-le explicitement après connexion.',
      );
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
        <button className="secondary-button" disabled={busy} onClick={() => void action(load)}>
          Actualiser
        </button>
      </header>
      {!online && (
        <p role="status" className="transfer-warning">
          Hors connexion : préparation uniquement. Soldes non actualisés ; aucune remise, réception
          ou conversion exécutée.
        </p>
      )}
      <p>
        Les brouillons locaux restent en mémoire native pendant 15 minutes au maximum et
        disparaissent à la fermeture. Les copies transmises se retrouvent dans l’historique serveur.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {canPrepare && (
        <section className="panel">
          <h2>Préparer un transfert</h2>
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
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value as 'CDF' | 'USD')}
              >
                <option>USD</option>
                <option>CDF</option>
              </select>
            </label>
            <label>
              Devise destination
              <select
                value={targetCurrency}
                onChange={(e) => setTargetCurrency(e.target.value as 'CDF' | 'USD')}
              >
                <option>USD</option>
                <option>CDF</option>
              </select>
            </label>
            <label>
              Montant à remettre
              <input
                required
                inputMode="decimal"
                placeholder="25.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            {fx && (
              <>
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
                    required
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
                    value={rateSource}
                    onChange={(e) => setRateSource(e.target.value)}
                  />
                </label>
                <p>
                  Montant reçu calculé par le serveur, arrondi final au centime, moitié supérieure
                  (HALF_UP). Aucun taux implicite.
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
                {b.fields.description} · {b.fields.amount} {b.fields.currency}
              </span>
              <button
                className="secondary-button"
                disabled={!online || busy}
                onClick={() => void send(b)}
              >
                Transmettre ou retrouver
              </button>
              <button
                className="secondary-button"
                disabled={busy}
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
              ? `Taux : ${selected.rate} ${selected.destinationCurrency} pour 1 ${selected.sourceCurrency} · ${selected.rateSource} · HALF_UP à 2 décimales`
              : 'Même devise, sans conversion.'}
          </p>
          <p>
            Source : {cashName(selected.sourceCashRegisterId)} · Destination :{' '}
            {cashName(selected.destinationCashRegisterId)}
          </p>
          <p>Référence : {selected.id}</p>
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
              ['Arrondi', 'HALF_UP final à 2 décimales'],
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
