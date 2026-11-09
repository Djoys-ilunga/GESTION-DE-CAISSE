import { SupervisionPanel } from '../management/Supervision';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Wallet,
  Clock3,
  Download,
  RefreshCw,
  Printer,
  ShieldCheck,
} from 'lucide-react';
import type {
  ReportQuery,
  ReportSnapshot,
  SessionProfile,
  CashSnapshot,
  Supervision,
} from '@caissepro/shared';
import { message, type AuthGateway } from '../auth/gateway';
import { formatMoney } from '../cash/CashPage';
import './reports.css';
const formatDate = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { timeZone: 'Africa/Kinshasa' });
const labels = {
  RECEIPT: 'Encaissement',
  DISBURSEMENT: 'Décaissement',
  TRANSFER: 'Transfert',
  FX: 'Conversion',
  REVERSAL: 'Contre-écriture',
};
function cents(v: string) {
  return BigInt(v.replace('.', ''));
}
function axisMoney(n: bigint) {
  const abs = n < 0n ? -n : n;
  return (
    (n < 0n ? '-' : '') + (abs / 100n).toString() + '.' + (abs % 100n).toString().padStart(2, '0')
  );
}
function Curve({ data, currency }: { data: ReportSnapshot['daily']; currency: 'USD' | 'CDF' }) {
  const values = data.filter((p) => p.currency === currency);
  if (!values.length) return <p>Aucun point observé pour cette période.</p>;
  const amounts = values.map((p) => cents(p.balance));
  let min = amounts[0]!,
    max = min;
  for (const v of amounts) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const points = amounts
    .map(
      (v, i) =>
        `${20 + (i * 560) / Math.max(1, amounts.length - 1)},${max === min ? 85 : 145 - Number(((v - min) * 12000n) / (max - min)) / 100}`,
    )
    .join(' ');
  return (
    <figure className="report-curve">
      <figcaption>
        <strong>{currency}</strong>
        <span>
          {formatMoney(values.at(-1)!.balance)} {currency}
        </span>
      </figcaption>
      <svg
        viewBox="0 0 600 175"
        role="img"
        aria-label={`Évolution observée de trésorerie en ${currency}`}
      >
        <path d="M20 25H580 M20 85H580 M20 145H580" stroke="#e2e8e4" fill="none" />
        <polyline
          points={points}
          fill="none"
          stroke={currency === 'USD' ? '#17634d' : '#9c7b3b'}
          strokeWidth="3"
          strokeLinejoin="round"
        />
        {values.length === 1 && <circle cx="20" cy="85" r="4" fill="#17634d" />}
      </svg>
      <div>
        <span>{values[0]!.date}</span>
        <span>{values.at(-1)!.date}</span>
      </div>
      <small>
        Amplitude : {formatMoney(axisMoney(min))} à {formatMoney(axisMoney(max))} {currency}
      </small>
    </figure>
  );
}
export function ReportsPage({
  profile,
  gateway,
  online,
  reports = false,
  supervision,
  supervisionError,
}: {
  profile: SessionProfile;
  gateway: AuthGateway;
  online: boolean;
  reports?: boolean;
  supervision?: Supervision | null;
  supervisionError?: string;
}) {
  const [data, setData] = useState<ReportSnapshot | null>(null),
    [query, setQuery] = useState<ReportQuery>({ period: 'month' }),
    [draft, setDraft] = useState<ReportQuery>({ period: 'month' }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [tab, setTab] = useState<
      'journal' | 'category' | 'agency' | 'user' | 'decisions' | 'closures'
    >('journal'),
    [currency, setCurrency] = useState('ALL'),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(1);
  const generation = useRef(0),
    alive = useRef(true),
    onlineRef = useRef(online);
  onlineRef.current = online;
  const [cash, setCash] = useState<CashSnapshot | null>(null),
    [closeId, setCloseId] = useState(''),
    [countUSD, setCountUSD] = useState(''),
    [countCDF, setCountCDF] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  async function load(q: ReportQuery) {
    const seq = ++generation.current;
    setError('');
    setData(null);
    setBusy(true);
    try {
      const value = await gateway.reportSnapshot(q);
      if (alive.current && seq === generation.current && onlineRef.current) {
        setData(value);
        setQuery(q);
        setPage(1);
      }
    } catch (e) {
      if (alive.current && seq === generation.current) setError(message(e));
    } finally {
      if (alive.current && seq === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (!online) {
      generation.current++;
      setData(null);
      setCash(null);
      setBusy(false);
      return;
    }
    void load(query);
    return () => {
      generation.current++;
    }; /* initial fetch, explicit Apply for subsequent filters */
  }, [online, gateway, profile.authorizationVersion]);
  const authorized = profile.permissions.includes('ledger:read');
  async function prepareClosure() {
    if (!online || busy || !profile.permissions.includes('session:manage')) return;
    const seq = ++generation.current;
    setBusy(true);
    setError('');
    setCash(null);
    setCloseId('');
    setCountUSD('');
    setCountCDF('');
    setConfirmed(false);
    try {
      const value = await gateway.cashCatalog();
      if (alive.current && seq === generation.current && onlineRef.current) setCash(value);
    } catch (e) {
      if (alive.current && seq === generation.current) setError(message(e));
    } finally {
      if (alive.current && seq === generation.current) setBusy(false);
    }
  }
  async function save(format: 'pdf' | 'xlsx') {
    if (!data || !online || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await gateway.saveReport(format, data.query);
      if (alive.current && onlineRef.current)
        setNotice(
          result.saved ? 'Rapport enregistré à l’emplacement choisi.' : 'Enregistrement annulé.',
        );
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function close(e: FormEvent) {
    e.preventDefault();
    const selected = cash?.data.items.find((c) => c.id === closeId);
    if (!online || !selected?.session || !confirmed) return;
    setBusy(true);
    setError('');
    try {
      await gateway.closeCash({
        cashRegisterId: closeId,
        sessionId: selected.session.id,
        confirmed: true,
        countedUSD: countUSD,
        countedCDF: countCDF,
      });
      if (!alive.current || !onlineRef.current) return;
      setConfirmed(false);
      setCountUSD('');
      setCountCDF('');
      setCash(null);
      setNotice('Clôture et procès-verbal enregistrés. Aucun solde corrigé automatiquement.');
      await load(query);
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const orderedRows = reports ? data?.rows : [...(data?.rows ?? [])].reverse();
  const filtered =
    orderedRows?.filter(
      (r) =>
        (currency === 'ALL' || r.currency === currency) &&
        (!search ||
          `${r.reference} ${r.cashName} ${r.userName} ${r.category}`
            .toLocaleLowerCase('fr')
            .includes(search.toLocaleLowerCase('fr'))),
    ) ?? [];
  function apply(e: FormEvent) {
    e.preventDefault();
    setNotice('');
    void load(draft);
  }
  return (
    <div className="reports-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">PILOTAGE FINANCIER · {profile.company.code}</p>
          <h1>
            {reports
              ? 'Rapports financiers'
              : `Bienvenue, ${profile.user.displayName.split(' ')[0]}`}
          </h1>
          <p>
            {reports
              ? 'Journal, décisions et clôtures de vos caisses.'
              : 'Votre trésorerie, dans chaque devise et chaque caisse autorisée.'}
          </p>
        </div>
        <button
          className="secondary-button"
          disabled={!online || busy || !authorized}
          onClick={() => void load(query)}
        >
          <RefreshCw size={16} /> Actualiser
        </button>
      </header>
      {!online && (
        <section className="panel" role="status">
          <h2>Rapports indisponibles hors connexion</h2>
          <p>
            Reconnectez-vous pour obtenir les indicateurs vérifiés par le serveur. Aucune
            statistique de remplacement n’est affichée.
          </p>
        </section>
      )}
      {error && (
        <p className="auth-notice" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!authorized && <p>Votre rôle ne permet pas de consulter les rapports financiers.</p>}
      {online && authorized && (
        <>
          <form className="panel report-filters" onSubmit={apply} aria-label="Filtres du rapport">
            <label>
              Période
              <select
                value={draft.period ?? 'month'}
                onChange={(e) =>
                  setDraft({ ...draft, period: e.target.value as ReportQuery['period'] })
                }
              >
                {[
                  ['day', 'Quotidien'],
                  ['week', 'Hebdomadaire'],
                  ['month', 'Mensuel'],
                  ['year', 'Annuel'],
                  ['custom', 'Personnalisé'],
                ].map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            {draft.period === 'custom' ? (
              <>
                <label>
                  Du
                  <input
                    required
                    type="date"
                    value={draft.from ?? ''}
                    onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                  />
                </label>
                <label>
                  Au
                  <input
                    required
                    type="date"
                    value={draft.to ?? ''}
                    onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                  />
                </label>
              </>
            ) : (
              <label>
                Date de référence
                <input
                  type="date"
                  value={draft.date ?? ''}
                  onChange={(e) => setDraft({ ...draft, date: e.target.value || undefined })}
                />
              </label>
            )}
            <label>
              Agence
              <select
                value={draft.agencyId ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    agencyId: e.target.value || undefined,
                    cashRegisterId: undefined,
                  })
                }
              >
                <option value="">Toutes les agences autorisées</option>
                {profile.agencies.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Caisse
              <select
                value={draft.cashRegisterId ?? ''}
                onChange={(e) =>
                  setDraft({ ...draft, cashRegisterId: e.target.value || undefined })
                }
              >
                <option value="">Toutes les caisses autorisées</option>
                {profile.cashRegisters
                  .filter((c) => !draft.agencyId || c.agencyId === draft.agencyId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Utilisateur
              <select
                value={draft.userId ?? ''}
                onChange={(e) => setDraft({ ...draft, userId: e.target.value || undefined })}
              >
                <option value="">Tous les utilisateurs du périmètre</option>
                {data?.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Catégorie
              <select
                value={draft.category ?? ''}
                onChange={(e) => setDraft({ ...draft, category: e.target.value || undefined })}
              >
                <option value="">Toutes les catégories</option>
                {[...new Set(data?.rows.map((r) => r.category))].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              Type
              <select
                value={draft.kind ?? ''}
                onChange={(e) =>
                  setDraft({ ...draft, kind: (e.target.value || undefined) as ReportQuery['kind'] })
                }
              >
                <option value="">Tous les mouvements</option>
                {Object.entries(labels).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary-button" disabled={busy}>
              Appliquer
            </button>
          </form>
          {busy && !data && <p role="status">Chargement des données serveur…</p>}
          {data && (
            <>
              <div className="report-context">
                <span>
                  <ShieldCheck size={15} /> Serveur · {data.from} au {data.to} · {data.timezone}
                </span>
                <span>Actualisé le {formatDate(data.generatedAt)}</span>
              </div>
              <p className="report-caption">
                Les soldes et courbes couvrent toutes les écritures des caisses choisies. Les
                filtres utilisateur, catégorie et type s’appliquent au journal et aux mouvements de
                période. Aucun total ne mélange CDF et USD.
              </p>
              <div className="report-kpis">
                {[
                  { title: 'Trésorerie actuelle', field: 'balance', icon: Wallet },
                  { title: 'Encaissements du jour', field: 'todayReceipts', icon: ArrowDownLeft },
                  {
                    title: 'Décaissements du jour',
                    field: 'todayDisbursements',
                    icon: ArrowUpRight,
                  },
                ].map((card) => (
                  <article className="panel report-kpi" key={card.field}>
                    <card.icon size={22} />
                    <h2>{card.title}</h2>
                    {data.totals.map((t) => (
                      <div key={t.currency}>
                        <span className="currency-pill">{t.currency}</span>
                        <strong>
                          {formatMoney(
                            t[card.field as 'balance' | 'todayReceipts' | 'todayDisbursements'],
                          )}
                        </strong>
                      </div>
                    ))}
                  </article>
                ))}
                <article className="panel report-kpi">
                  <Clock3 size={22} />
                  <h2>Demandes en attente</h2>
                  {data.pending.map((p) => (
                    <div key={p.currency}>
                      <span className="currency-pill">{p.currency}</span>
                      <strong>{p.count}</strong>
                      <small>
                        {formatMoney(p.amount)} {p.currency}
                      </small>
                    </div>
                  ))}
                </article>
              </div>
              {!reports && supervision !== undefined && (
                <SupervisionPanel data={supervision} error={supervisionError} />
              )}
              <section className="panel">
                <h2>Évolution de la trésorerie</h2>
                <p className="report-caption">
                  Soldes de fin de journée observés, corrections et mouvements internes inclus. Les
                  jours futurs ne sont pas projetés.
                </p>
                <div className="report-charts">
                  <Curve data={data.daily} currency="CDF" />
                  <Curve data={data.daily} currency="USD" />
                </div>
              </section>
              <section className="panel">
                <h2>Soldes de vos caisses</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Caisse / agence</th>
                        <th>Devise</th>
                        <th>Comptable</th>
                        <th>Réservé</th>
                        <th>Disponible</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.cash.map((c) => (
                        <tr key={c.id + c.currency}>
                          <td>
                            {c.name}
                            <small>{c.agencyName}</small>
                          </td>
                          <td>{c.currency}</td>
                          <td>{formatMoney(c.balance)}</td>
                          <td>{formatMoney(c.reserved)}</td>
                          <td>{formatMoney(c.available)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!data.cash.length && <p>Aucune caisse autorisée dans ce périmètre.</p>}
              </section>
              <section className="panel">
                <h2>Écarts de caisse constatés — net par devise</h2>
                <p className="report-caption">
                  Comptages de la période sélectionnée ; aucune correction automatique des soldes.{' '}
                  {data.unmeasuredClosures} clôture(s) sans comptage.
                </p>
                <div className="report-charts">
                  {data.discrepancies.map((v) => (
                    <div key={v.currency}>
                      <strong>
                        {v.currency} : {v.net === null ? 'Non mesuré' : formatMoney(v.net)}
                      </strong>
                      <p>
                        {v.measured} comptage(s), {v.count} clôture(s) avec écart.
                      </p>
                    </div>
                  ))}
                </div>
              </section>
              <section className="panel report-doc">
                <header className="report-doc-header">
                  <div>
                    <p className="eyebrow">{data.company.code}</p>
                    <h2>{data.company.name}</h2>
                    <p>
                      Rapports du {data.from} au {data.to}
                    </p>
                  </div>
                  <div className="action-buttons report-tools">
                    <button disabled={busy} onClick={() => void save('pdf')}>
                      <Download size={15} /> PDF
                    </button>
                    <button disabled={busy} onClick={() => void save('xlsx')}>
                      <Download size={15} /> Excel
                    </button>
                    <button disabled={busy} onClick={() => window.print()}>
                      <Printer size={15} /> Imprimer la vue
                    </button>
                  </div>
                </header>
                <div className="report-tabs report-tools" role="tablist" aria-label="Rapports">
                  {[
                    ['journal', 'Journal de caisse'],
                    ['category', 'Par catégorie'],
                    ['agency', 'Par agence'],
                    ['user', 'Par utilisateur'],
                    ['decisions', 'Dépenses approuvées / rejetées'],
                    ['closures', 'Clôtures et écarts'],
                  ].map(([v, l]) => (
                    <button
                      key={v}
                      role="tab"
                      aria-selected={tab === v}
                      onClick={() => {
                        setTab(v as typeof tab);
                        setPage(1);
                      }}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                <div className="report-tools report-search">
                  <label>
                    Devise affichée
                    <select
                      value={currency}
                      onChange={(e) => {
                        setCurrency(e.target.value);
                        setPage(1);
                      }}
                    >
                      <option value="ALL">CDF et USD séparés</option>
                      <option>CDF</option>
                      <option>USD</option>
                    </select>
                  </label>
                  <label>
                    Rechercher dans le journal
                    <input
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setPage(1);
                      }}
                      placeholder="Référence, caisse, utilisateur…"
                    />
                  </label>
                </div>
                {tab === 'journal' && (
                  <>
                    <h3>{reports ? 'Journal de caisse' : 'Opérations récentes'}</h3>
                    <p>
                      {filtered.length} mouvement(s) de trésorerie · un transfert peut avoir deux
                      lignes si ses deux caisses sont dans votre périmètre.
                    </p>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th>Caisse / utilisateur</th>
                            <th>Nature / catégorie</th>
                            <th>Entrée</th>
                            <th>Sortie</th>
                            <th>Devise</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...filtered]
                            .reverse()
                            .slice((page - 1) * 25, page * 25)
                            .map((r) => (
                              <tr key={r.id}>
                                <td>
                                  {formatDate(r.postedAt)}
                                  <small>{r.reference}</small>
                                </td>
                                <td>
                                  {r.cashName}
                                  <small>{r.userName}</small>
                                </td>
                                <td>
                                  {labels[r.kind]}
                                  <small>{r.category}</small>
                                </td>
                                <td>{r.side === 'DEBIT' ? formatMoney(r.amount) : '—'}</td>
                                <td>{r.side === 'CREDIT' ? formatMoney(r.amount) : '—'}</td>
                                <td>{r.currency}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                    {!filtered.length && <p>Aucun mouvement pour ces critères.</p>}
                    <div className="report-tools action-buttons">
                      <button disabled={page === 1} onClick={() => setPage(page - 1)}>
                        Précédent
                      </button>
                      <span>
                        Page {page} / {Math.max(1, Math.ceil(filtered.length / 25))}
                      </span>
                      <button
                        disabled={page * 25 >= filtered.length}
                        onClick={() => setPage(page + 1)}
                      >
                        Suivant
                      </button>
                    </div>
                    <p className="report-caption">
                      PDF et Excel sont recalculés par le serveur lors de l’export, toutes pages et
                      devises incluses. L’heure du fichier fait foi. La recherche et la devise
                      affichée sont des filtres de consultation locale.
                    </p>
                  </>
                )}
                {['category', 'agency', 'user'].includes(tab) && (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Regroupement</th>
                          <th>Devise</th>
                          <th>Entrées</th>
                          <th>Sorties</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.groups
                          .filter(
                            (g) =>
                              g.dimension === tab &&
                              (currency === 'ALL' || g.currency === currency),
                          )
                          .map((g, i) => (
                            <tr key={i}>
                              <td>{g.name}</td>
                              <td>{g.currency}</td>
                              <td>{formatMoney(g.incoming)}</td>
                              <td>{formatMoney(g.outgoing)}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                    <p>
                      Les entrées/sorties incluent les mouvements internes ; elles ne constituent
                      pas des recettes de vente.
                    </p>
                  </div>
                )}
                {tab === 'decisions' && (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Décision / date</th>
                          <th>Demandeur</th>
                          <th>Approbateur</th>
                          <th>Montant</th>
                          <th>Devise</th>
                          <th>Demande</th>
                          <th>État de la demande</th>
                          <th>Motif de décision</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.decisions
                          .filter((d) => currency === 'ALL' || d.currency === currency)
                          .map((d) => (
                            <tr key={d.id}>
                              <td>
                                {d.state === 'APPROVE' ? 'Approuvée' : 'Rejetée'}
                                <small>{d.decidedAt && formatDate(d.decidedAt)}</small>
                              </td>
                              <td>{d.requester}</td>
                              <td>{d.approver}</td>
                              <td>{formatMoney(d.amount)}</td>
                              <td>{d.currency}</td>
                              <td>{d.description}</td>
                              <td>
                                {
                                  {
                                    PENDING: 'En attente',
                                    APPROVED: 'Approuvée',
                                    REJECTED: 'Rejetée',
                                    PAID: 'Payée',
                                    CANCELLED: 'Annulée',
                                  }[d.requestState]
                                }
                              </td>
                              <td>{d.reason ?? 'Non renseigné'}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                    {!data.decisions.length && <p>Aucune décision dans cette période.</p>}
                  </div>
                )}
                {tab === 'closures' && (
                  <>
                    <h3>Procès-verbaux et écarts de caisse</h3>
                    <p>
                      {data.unmeasuredClosures} clôture(s) historique(s) sans comptage : écart non
                      mesuré.
                    </p>
                    {data.closures.map((c) => (
                      <article key={c.id} className="report-closure">
                        <h4>{c.number}</h4>
                        <p>
                          {c.cashName} · {c.closedBy} · {formatDate(c.closedAt)}
                        </p>
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>Devise</th>
                                <th>Comptable figé</th>
                                <th>Compté physiquement</th>
                                <th>Écart constaté</th>
                              </tr>
                            </thead>
                            <tbody>
                              {c.counts.map((v) => (
                                <tr key={v.currency}>
                                  <td>{v.currency}</td>
                                  <td>{formatMoney(v.book)}</td>
                                  <td>{formatMoney(v.counted)}</td>
                                  <td>{formatMoney(v.difference)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </article>
                    ))}
                    {profile.permissions.includes('session:manage') && (
                      <div className="report-tools">
                        <button
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => void prepareClosure()}
                        >
                          Préparer une clôture avec comptage
                        </button>
                        {cash && (
                          <form className="report-filters" onSubmit={(e) => void close(e)}>
                            <label>
                              Caisse à clôturer
                              <select
                                required
                                value={closeId}
                                onChange={(e) => {
                                  if (e.target.value === closeId) return;
                                  setCloseId(e.target.value);
                                  setCountUSD('');
                                  setCountCDF('');
                                  setConfirmed(false);
                                  setNotice(
                                    'Le choix de la caisse exige un nouveau comptage et une nouvelle confirmation.',
                                  );
                                }}
                              >
                                <option value="">Choisir une session ouverte</option>
                                {cash.data.items
                                  .filter((c) => c.session)
                                  .map((c) => (
                                    <option key={c.id} value={c.id}>
                                      {c.name}
                                    </option>
                                  ))}
                              </select>
                            </label>
                            <label>
                              USD comptés
                              <input
                                required
                                pattern="[0-9]+\.[0-9]{2}"
                                value={countUSD}
                                onChange={(e) => setCountUSD(e.target.value)}
                                placeholder="0.00"
                              />
                            </label>
                            <label>
                              CDF comptés
                              <input
                                required
                                pattern="[0-9]+\.[0-9]{2}"
                                value={countCDF}
                                onChange={(e) => setCountCDF(e.target.value)}
                                placeholder="0.00"
                              />
                            </label>
                            <label>
                              <input
                                type="checkbox"
                                checked={confirmed}
                                onChange={(e) => setConfirmed(e.target.checked)}
                              />
                              Je confirme le comptage physique et la clôture définitive de cette
                              session.
                            </label>
                            <button disabled={busy || !confirmed} className="primary-button">
                              Clôturer et établir le PV
                            </button>
                          </form>
                        )}
                      </div>
                    )}
                  </>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
