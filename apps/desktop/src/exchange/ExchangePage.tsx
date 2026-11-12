import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  BccRates,
  BccHistory,
  ExchangePolicy,
  ExchangeQuote,
  SessionProfile,
} from '@caissepro/shared';
import { type AuthGateway, message } from '../auth/gateway';
import { CurrencyOptions, useMoney } from '../money/MoneyContext';
import { formatDate } from '../cash/CashPage';
import './exchange.css';

const kindLabels = { BUY: 'Acheteur', MEAN: 'Moyen', SELL: 'Vendeur' } as const;
export function ExchangePage({
  gateway,
  profile,
  online,
}: {
  gateway: AuthGateway;
  profile: SessionProfile;
  online: boolean;
}) {
  const [data, setData] = useState<BccRates | null>(null),
    [history, setHistory] = useState<BccHistory | null>(null);
  const [page, setPage] = useState(1),
    [search, setSearch] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const configure = profile.permissions.includes('cash:configure');
  async function load() {
    const request = ++sequence.current;
    try {
      const [rates, past] = await Promise.all([
        gateway.exchangeRates(),
        gateway.exchangeHistory(page),
      ]);
      if (request === sequence.current) {
        setData(rates);
        setHistory(past);
        setError('');
      }
    } catch (e) {
      if (request === sequence.current) {
        setData(null);
        setHistory(null);
        setError(message(e));
      }
    }
  }
  useEffect(() => {
    if (online) void load();
    else {
      setData(null);
      setHistory(null);
    }
    const timer = online ? setInterval(() => void load(), 60000) : undefined;
    return () => {
      ++sequence.current;
      clearInterval(timer);
    };
  }, [gateway, online, page, profile.authorizationVersion]);
  if (!online)
    return (
      <section className="panel">
        <h1>Taux de change</h1>
        <p role="status">
          Hors connexion : cours et simulateur indisponibles. Aucun taux local n’est présenté comme
          actualisé.
        </p>
      </section>
    );
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      await gateway.refreshExchange();
      setNotice(
        'Vérification demandée. Le délai serveur et l’état de la source restent applicables.',
      );
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="exchange-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">BANQUE CENTRALE DU CONGO</p>
          <h1>Taux de change</h1>
          <p>
            Dernière publication disponible ; les cours ne varient pas entre deux publications
            officielles.
          </p>
        </div>
        {configure && (
          <button
            className="secondary-button"
            disabled={busy || data?.source.code === 'BCC_AUTHORIZATION_REQUIRED'}
            onClick={() => void refresh()}
          >
            Actualiser la source BCC
          </button>
        )}
      </header>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!data && !error && <p>Chargement des cours serveur…</p>}
      {data && (
        <>
          <section className="panel">
            <h2>État de la source</h2>
            <p role="status">
              {data.source.code === 'BCC_AUTHORIZATION_REQUIRED'
                ? 'Collecte automatique BCC non autorisée : un accord de la BCC est nécessaire.'
                : !data.source.approved
                  ? 'Source BCC non vérifiée : aucun cours officiel utilisable.'
                  : data.source.state === 'UNAVAILABLE'
                    ? 'Source indisponible. Dernière publication conservée, sous réserve de fraîcheur.'
                    : data.source.state === 'FETCHING'
                      ? 'Actualisation en cours.'
                      : 'Source vérifiée.'}
            </p>
            {data.source.code === 'BCC_AUTHORIZATION_REQUIRED' && (
              <p>
                Les{' '}
                <a href="https://www.bcc.cd/mentions-legales" target="_blank" rel="noreferrer">
                  mentions légales de la BCC
                </a>{' '}
                interdisent la collecte automatisée. Les taux manuels restent soumis à vos
                permissions et à la politique de l’entreprise.
              </p>
            )}
            <p>
              Dernier contrôle :{' '}
              {data.source.checkedAt ? formatDate(data.source.checkedAt) : 'Aucun'} · Dernière
              récupération réussie :{' '}
              {data.source.lastSuccessAt ? formatDate(data.source.lastSuccessAt) : 'Aucune'}
            </p>
            <p>
              Nouvelle tentative autorisée :{' '}
              {data.source.nextAllowedAt
                ? formatDate(data.source.nextAllowedAt)
                : 'Selon disponibilité du connecteur'}
              .
            </p>
            {data.publication ? (
              <p>
                Publication du <strong>{data.publication.publicationDate}</strong> · Récupérée le{' '}
                {formatDate(data.publication.retrievedAt)} · Référence :{' '}
                {data.publication.sourceReference}
              </p>
            ) : (
              <p>Aucune publication officielle vérifiée disponible.</p>
            )}
            <p>
              Source :{' '}
              <a href={data.source.sourceUrl} target="_blank" rel="noreferrer">
                {data.source.sourceUrl}
              </a>
            </p>
            {data.stale && (
              <p className="auth-notice">
                Taux périmé ou indisponible : les conversions BCC sont bloquées.
              </p>
            )}
            <p>
              Fraîcheur maximale : {data.policy.maxAgeHours} heures depuis la date de publication à
              Kinshasa ; aucun nouveau cours n’est supposé les jours sans publication.
            </p>
          </section>
          <section className="panel">
            <h2>Cotations en CDF par unité réelle</h2>
            <label>
              Rechercher une devise
              <input value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Devise</th>
                    <th>Unité publiée</th>
                    <th>Acheteur</th>
                    <th>Moyen</th>
                    <th>Vendeur</th>
                    <th>Disponibilité</th>
                  </tr>
                </thead>
                <tbody>
                  {data.currencies
                    .filter((c) =>
                      `${c.code} ${c.name}`.toLowerCase().includes(search.toLowerCase()),
                    )
                    .map((c) => {
                      const q = data.quotes.find((v) => v.currency === c.code);
                      return (
                        <tr key={c.code}>
                          <td>
                            {c.code} · {c.name}
                            {c.activeForCompany ? ' · Autorisée' : ''}
                          </td>
                          <td title={q?.unitEvidence}>{q ? q.unit : '—'}</td>
                          <td>{q?.buy ?? '—'}</td>
                          <td>{q?.mean ?? '—'}</td>
                          <td>{q?.sell ?? '—'}</td>
                          <td>
                            {c.code === 'CDF'
                              ? 'Base de calcul CDF = 1'
                              : !data.source.approved
                                ? 'Source non vérifiée'
                                : q
                                  ? 'Publication disponible'
                                  : 'Taux BCC indisponible'}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            <p>
              Les valeurs publiées pour 100 unités sont divisées par 100. Aucune moyenne n’est
              inventée à partir des cours acheteur et vendeur.
            </p>
          </section>
          <RateSimulator
            key={`${data.policy.version}:${data.publication?.id ?? 'none'}`}
            gateway={gateway}
            data={data}
            profile={profile}
          />
          {configure && (
            <PolicyForm
              key={data.policy.version}
              policy={data.policy}
              gateway={gateway}
              onSaved={load}
            />
          )}
          <section className="panel">
            <h2>Historique des publications</h2>
            {history?.items.map((p) => (
              <details key={p.id}>
                <summary>
                  {p.publicationDate} · {p.sourceReference} · Récupérée le{' '}
                  {formatDate(p.retrievedAt)}
                </summary>
                <p>
                  Source : {p.sourceUrl} · Empreinte SHA-256 :{' '}
                  <span className="exchange-hash">{p.contentSha256}</span>
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Devise</th>
                        <th>Unité</th>
                        <th>Acheteur brut / normalisé</th>
                        <th>Moyen brut / normalisé</th>
                        <th>Vendeur brut / normalisé</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.quotes.map((q) => (
                        <tr key={q.currency}>
                          <td>{q.currency}</td>
                          <td>
                            {q.unit} · {q.unitEvidence}
                          </td>
                          <td>
                            {q.rawBuy ?? '—'} / {q.buy ?? '—'}
                          </td>
                          <td>
                            {q.rawMean ?? '—'} / {q.mean ?? '—'}
                          </td>
                          <td>
                            {q.rawSell ?? '—'} / {q.sell ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ))}
            {!history?.items.length && <p>Aucune cotation historique vérifiée.</p>}
            <div className="action-buttons">
              <button
                className="secondary-button"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Publications précédentes
              </button>
              <span>Page {page}</span>
              <button
                className="secondary-button"
                disabled={!history || page * 25 >= history.total}
                onClick={() => setPage((p) => p + 1)}
              >
                Publications suivantes
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
function RateSimulator({
  gateway,
  data,
  profile,
}: {
  gateway: AuthGateway;
  data: BccRates;
  profile: SessionProfile;
}) {
  const money = useMoney();
  const [from, setFrom] = useState(money.preferred('USD')),
    [to, setTo] = useState('CDF'),
    [amount, setAmount] = useState('');
  const [mode, setMode] = useState<'BCC' | 'MANUAL'>('BCC'),
    [rate, setRate] = useState(''),
    [source, setSource] = useState(''),
    [reason, setReason] = useState('');
  const [quote, setQuote] = useState<ExchangeQuote | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const inputVersion = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const manual = data.policy.allowManual && profile.permissions.includes('fx:manual');
  async function simulate(e: FormEvent) {
    e.preventDefault();
    const requestVersion = inputVersion.current;
    setQuote(null);
    setBusy(true);
    setError('');
    try {
      const q = await gateway.exchangeQuote({
        fromCurrency: from,
        toCurrency: to,
        amount: amount.replace(',', '.'),
        mode,
        ...(mode === 'MANUAL'
          ? {
              manualRate: rate.replace(',', '.'),
              manualSource: source,
              justification: reason,
              manualEffectiveAt: new Date().toISOString(),
            }
          : {}),
      });
      if (alive.current && requestVersion === inputVersion.current) setQuote(q);
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Simulateur de conversion</h2>
      <p>
        Aucune écriture et aucun solde ne sont modifiés. Cours de référence :{' '}
        {kindLabels[data.policy.quoteKind]}.
      </p>
      <form
        className="form-grid"
        onSubmit={(e) => void simulate(e)}
        onChange={() => {
          inputVersion.current++;
          setQuote(null);
        }}
      >
        <label>
          Devise à convertir
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            <CurrencyOptions include={from} />
          </select>
        </label>
        <label>
          Devise obtenue
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            <CurrencyOptions include={to} />
          </select>
        </label>
        <label>
          Montant à simuler
          <input
            required
            inputMode="decimal"
            pattern={money.pattern(from)}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          Origine du taux
          <select value={mode} onChange={(e) => setMode(e.target.value as 'BCC' | 'MANUAL')}>
            <option value="BCC">Publication BCC</option>
            {manual && <option value="MANUAL">Taux manuel justifié</option>}
          </select>
        </label>
        {mode === 'MANUAL' && (
          <>
            <label>
              Taux manuel
              <input required value={rate} onChange={(e) => setRate(e.target.value)} />
            </label>
            <label>
              Source manuelle
              <input
                required
                minLength={3}
                maxLength={100}
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
            </label>
            <label>
              Justification
              <input
                required
                minLength={3}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <p>
              Le taux manuel est déclaré à la date de cette simulation et reste distinct d’une
              publication officielle.
            </p>
          </>
        )}
        <button
          className="primary-button"
          disabled={
            busy || from === to || (mode === 'BCC' && (!data.source.approved || data.stale))
          }
        >
          Simuler avec le serveur
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {quote && (
        <div role="status">
          <p>
            {money.format(quote.amount)} {quote.fromCurrency} → {money.format(quote.targetAmount)}{' '}
            {quote.toCurrency}
          </p>
          <p>
            Taux de référence : {quote.referenceRate ?? 'BCC indisponible ou non demandé'} · Taux
            appliqué : {quote.appliedRate} · {quote.mode === 'BCC' ? 'Référence BCC' : 'Manuel'} ·{' '}
            {quote.source}
          </p>
          <p>
            Valable jusqu’au {formatDate(quote.expiresAt)}. Arrondi HALF_UP à la précision de
            destination. Une opération nécessite encore sa propre validation serveur.
          </p>
        </div>
      )}
    </section>
  );
}
function PolicyForm({
  policy,
  gateway,
  onSaved,
}: {
  policy: ExchangePolicy;
  gateway: AuthGateway;
  onSaved(): Promise<void>;
}) {
  const [form, setForm] = useState(policy),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!confirmed) return;
    setBusy(true);
    setError('');
    try {
      const { version, ...settings } = form;
      await gateway.exchangePolicy({ ...settings, expectedVersion: version, confirmed: true });
      await onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Politique de change de l’entreprise</h2>
      <form className="form-grid" onSubmit={(e) => void save(e)}>
        <label>
          Type de cours
          <select
            value={form.quoteKind}
            onChange={(e) => {
              setForm({ ...form, quoteKind: e.target.value as ExchangePolicy['quoteKind'] });
              setConfirmed(false);
            }}
          >
            {Object.entries(kindLabels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Fraîcheur maximale en heures
          <input
            type="number"
            required
            min={1}
            max={168}
            value={form.maxAgeHours}
            onChange={(e) => {
              setForm({ ...form, maxAgeHours: Number(e.target.value) });
              setConfirmed(false);
            }}
          />
        </label>
        <label>
          Validité d’une proposition en minutes
          <input
            type="number"
            required
            min={1}
            max={30}
            value={form.quoteTtlMinutes}
            onChange={(e) => {
              setForm({ ...form, quoteTtlMinutes: Number(e.target.value) });
              setConfirmed(false);
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.allowManual}
            onChange={(e) => {
              setForm({ ...form, allowManual: e.target.checked });
              setConfirmed(false);
            }}
          />
          Autoriser les taux manuels aux utilisateurs habilités
        </label>
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          Je confirme cette politique pour les prochaines validations de change.
        </label>
        <button className="primary-button" disabled={busy || !confirmed}>
          Enregistrer la politique de change
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
