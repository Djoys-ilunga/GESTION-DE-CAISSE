import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowDownToLine,
  CheckCircle2,
  FilePenLine,
  Plus,
  RefreshCw,
  Search,
  ReceiptText,
} from 'lucide-react';
import type {
  CashSnapshot,
  ConfirmedReceipt,
  ReceiptDraftList,
  ReceiptHistory,
  ReceiptQuery,
  ServerReceiptDraft,
  SessionProfile,
} from '@caissepro/shared';
import { message, type AuthGateway, type SessionDraft } from '../auth/gateway';
import { formatDate, formatMoney } from './CashPage';
import { ReceiptForm } from './ReceiptForm';
import { ReceiptViewer } from './ReceiptViewer';
import './cash.css';
export function ReceiptsPage({
  gateway,
  profile,
  online,
}: {
  gateway: AuthGateway;
  profile: SessionProfile;
  online: boolean;
}) {
  const canDraft = profile.permissions.includes('draft:read_own'),
    canWrite = profile.permissions.includes('draft:write_own'),
    canPost = profile.permissions.includes('receipt:post');
  const [tab, setTab] = useState(canDraft ? 'local' : 'history'),
    [local, setLocal] = useState<SessionDraft[]>([]),
    [cash, setCash] = useState<CashSnapshot | null>(null),
    [server, setServer] = useState<ReceiptDraftList | null>(null),
    [history, setHistory] = useState<ReceiptHistory | null>(null);
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState<SessionDraft | null>(null),
    [selected, setSelected] = useState<ServerReceiptDraft | null>(null),
    [received, setReceived] = useState(false),
    [receipt, setReceipt] = useState<ConfirmedReceipt | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [page, setPage] = useState(1),
    [query, setQuery] = useState<ReceiptQuery>({}),
    [filterCash, setFilterCash] = useState(''),
    [filterCurrency, setFilterCurrency] = useState(''),
    [filterCategory, setFilterCategory] = useState(''),
    [search, setSearch] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState('');
  useEffect(() => {
    let active = true;
    const update = () => {
      void gateway
        .cashCatalog()
        .then((v) => {
          if (active) setCash(v);
        })
        .catch((e) => {
          if (active) setError(message(e));
        });
      if (canDraft)
        void gateway
          .drafts()
          .then((v) => {
            if (active) setLocal(v.filter((r) => r.draft.kind === 'receipt'));
          })
          .catch((e) => {
            if (active) setError(message(e));
          });
    };
    update();
    const timer = setInterval(update, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [gateway, online, canDraft, profile.authorizationVersion]);
  useEffect(() => {
    let active = true;
    if (online) {
      if (tab === 'server' && canDraft)
        void gateway
          .receiptDrafts(page)
          .then((v) => {
            if (active) setServer(v);
          })
          .catch((e) => {
            if (active) setError(message(e));
          });
      if (tab === 'history')
        void gateway
          .receiptHistory({ ...query, page })
          .then((v) => {
            if (active) setHistory(v);
          })
          .catch((e) => {
            if (active) setError(message(e));
          });
    }
    return () => {
      active = false;
    };
  }, [gateway, online, tab, page, query, canDraft]);
  const cashName = (id: string) =>
    cash?.data.items.find((c) => c.id === id)?.name ??
    profile.cashRegisters.find((c) => c.id === id)?.name ??
    'Caisse affectée';
  async function refresh() {
    const [catalog, drafts] = await Promise.all([
      gateway.cashCatalog(),
      canDraft ? gateway.drafts() : Promise.resolve([]),
    ]);
    setCash(catalog);
    setLocal(drafts.filter((r) => r.draft.kind === 'receipt'));
  }
  async function sync() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const results = await gateway.synchronize();
      setNotice(
        results.length
          ? results
              .map(
                (r) =>
                  `${r.draftId.slice(0, 8)} : ${r.outcome === 'accepted-as-draft' ? 'transmis, non comptabilisé' : r.outcome === 'conflict' ? 'conflit à résoudre' : 'transmission refusée'}`,
              )
              .join(' · ')
          : 'Aucun nouveau brouillon à transmettre.',
      );
      await refresh();
      setServer(await gateway.receiptDrafts(page));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function restore(id: string) {
    setBusy(true);
    setError('');
    try {
      const draft = await gateway.restoreReceiptDraft(id);
      setEditing(draft);
      setOpen(true);
      setTab('local');
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!selected || !received || !online) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const confirmed = await gateway.confirmReceipt(selected.id, selected.version, true);
      setReceipt(confirmed);
      setSelected(null);
      setReceived(false);
      setNotice(`Encaissement comptabilisé. Reçu ${confirmed.number}.`);
      await refresh();
      setServer(await gateway.receiptDrafts(page));
    } catch (e) {
      setError(
        `Confirmation non vérifiée. ${message(e)} Consultez le suivi serveur avant de réessayer.`,
      );
    } finally {
      setBusy(false);
    }
  }
  async function viewReceipt(id: string) {
    setError('');
    try {
      setReceipt(await gateway.receipt(id));
    } catch (e) {
      setError(message(e));
    }
  }
  function filter(e: FormEvent) {
    e.preventDefault();
    setQuery({
      ...(filterCash ? { cashRegisterId: filterCash } : {}),
      ...(filterCurrency ? { currency: filterCurrency as 'CDF' | 'USD' } : {}),
      ...(filterCategory ? { category: filterCategory } : {}),
      ...(search ? { search } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
    setPage(1);
  }
  const selectedCash = selected
    ? cash?.data.items.find((c) => c.id === selected.cashRegisterId)
    : undefined;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">RECETTES DE L’ENTREPRISE</p>
          <h1>Encaissements</h1>
          <p>Préparer, transmettre, puis confirmer la réception effective des fonds.</p>
        </div>
        {canWrite && (
          <button
            className="primary-button"
            onClick={() => {
              setEditing(null);
              setOpen(true);
              setTab('local');
            }}
          >
            <Plus size={16} />
            Nouveau brouillon d’encaissement
          </button>
        )}
      </div>
      <div className="cash-tabs" role="tablist" aria-label="Encaissements">
        {canDraft && (
          <>
            <button
              role="tab"
              aria-selected={tab === 'local'}
              className={tab === 'local' ? 'selected' : ''}
              onClick={() => {
                setTab('local');
                setPage(1);
              }}
            >
              Brouillons locaux
            </button>
            <button
              role="tab"
              aria-selected={tab === 'server'}
              className={tab === 'server' ? 'selected' : ''}
              onClick={() => {
                setTab('server');
                setPage(1);
              }}
            >
              Suivi serveur
            </button>
          </>
        )}
        <button
          role="tab"
          aria-selected={tab === 'history'}
          className={tab === 'history' ? 'selected' : ''}
          onClick={() => {
            setTab('history');
            setPage(1);
          }}
        >
          Historique des encaissements
        </button>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="cash-success">
          {notice}
        </p>
      )}
      {cash && (
        <p className={`cash-freshness ${cash.stale || !online ? 'stale' : ''}`}>
          <RefreshCw size={14} />
          {cash.stale || !online
            ? 'Derniers soldes connus, non actualisés'
            : 'Soldes consultés sur le serveur'}{' '}
          : {formatDate(cash.data.synchronizedAt)} (Kinshasa). Les brouillons ne les modifient
          jamais.
        </p>
      )}
      {tab === 'local' ? (
        <>
          {open && canWrite && (
            <ReceiptForm
              key={`${editing?.draft.id ?? 'new'}:${editing?.version ?? 0}`}
              gateway={gateway}
              cashes={cash?.data.items ?? []}
              editing={editing}
              onSaved={() => {
                setOpen(false);
                setEditing(null);
                setNotice(
                  'Brouillon non comptabilisé enregistré en mémoire. Aucun reçu n’a été émis.',
                );
                void refresh().catch((e) => setError(message(e)));
              }}
              onCancel={() => {
                setOpen(false);
                setEditing(null);
              }}
            />
          )}
          <div className="receipt-workflow">
            <span>
              <FilePenLine size={17} />
              1. Brouillon
            </span>
            <span>
              <ArrowDownToLine size={17} />
              2. Transmission
            </span>
            <span>
              <CheckCircle2 size={17} />
              3. Confirmation en ligne
            </span>
            <span>
              <ReceiptText size={17} />
              4. Reçu numéroté
            </span>
          </div>
          <section className="panel">
            <div className="panel-heading">
              <h2>Brouillons de cette session</h2>
              <button
                className="secondary-button"
                disabled={!online || busy}
                onClick={() => void sync()}
              >
                <RefreshCw size={15} />
                Transmettre les brouillons
              </button>
            </div>
            <p className="section-description">
              Mémoire temporaire, 15 minutes maximum. Fermer l’application ou changer d’utilisateur
              efface les données locales. Les brouillons déjà transmis restent disponibles dans le
              suivi serveur.
            </p>
            {local.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Provenance et motif</th>
                      <th>Caisse</th>
                      <th>Montant</th>
                      <th>Statut</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {local.map((row) => (
                      <tr key={row.draft.id}>
                        <td>
                          <strong>{row.draft.receiptDetails?.provenance ?? 'À compléter'}</strong>
                          <small className="block">{row.draft.description}</small>
                          <small className="block">
                            Expire le {formatDate(row.draft.expiresAt)}
                          </small>
                        </td>
                        <td>{cashName(row.cashRegisterId ?? '')}</td>
                        <td className="money-cell">
                          {formatMoney(row.draft.amount)} {row.draft.currency}
                        </td>
                        <td>
                          <span
                            className={`receipt-status ${row.state === 'confirmed' ? 'posted' : 'pending'}`}
                          >
                            {row.state === 'confirmed'
                              ? `Comptabilisé · ${row.receiptNumber ?? ''}`
                              : 'Brouillon non comptabilisé'}
                          </span>
                          <small className="block">
                            {row.state === 'synced'
                              ? 'Transmis au serveur'
                              : row.state === 'conflict'
                                ? 'Conflit de version'
                                : row.state === 'error'
                                  ? 'Transmission refusée'
                                  : row.state === 'confirmed'
                                    ? 'Reçu émis par le serveur'
                                    : 'En mémoire locale'}
                          </small>
                        </td>
                        <td>
                          {row.state === 'confirmed' && row.confirmedReceiptId ? (
                            <button
                              className="text-button"
                              disabled={!online}
                              onClick={() => void viewReceipt(row.confirmedReceiptId!)}
                            >
                              Voir le reçu
                            </button>
                          ) : (
                            canWrite && (
                              <button
                                className="text-button"
                                disabled={busy}
                                onClick={() => {
                                  setEditing(row);
                                  setOpen(true);
                                }}
                              >
                                Modifier le brouillon
                              </button>
                            )
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-state">
                <FilePenLine size={30} />
                <h3>Aucun brouillon local</h3>
                <p>Un brouillon ne constitue jamais une preuve de paiement.</p>
              </div>
            )}
          </section>
        </>
      ) : tab === 'server' ? (
        <>
          {!online ? (
            <p className="auth-notice">
              La consultation des transmissions et la confirmation exigent une connexion au serveur.
            </p>
          ) : (
            <section className="panel">
              <div className="panel-heading">
                <h2>Encaissements transmis</h2>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    void gateway
                      .receiptDrafts(page)
                      .then(setServer)
                      .catch((e) => setError(message(e)))
                  }
                >
                  <RefreshCw size={15} />
                  Actualiser le suivi
                </button>
              </div>
              <p className="section-description">
                Une transmission est un brouillon central. Vérifiez le montant, le justificatif et
                la réception de l’argent avant toute confirmation.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Transmission</th>
                      <th>Montant</th>
                      <th>État central</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {server?.items.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <strong>{row.provenance ?? 'Provenance à compléter'}</strong>
                          <small className="block">
                            {cashName(row.cashRegisterId)} ·{' '}
                            {row.category ?? 'Catégorie à compléter'}
                          </small>
                          <small className="block">{row.description}</small>
                          <small className="block">
                            Référence : {row.reference || '—'} · Version {row.version}
                          </small>
                        </td>
                        <td className="money-cell">
                          {formatMoney(row.amount)} {row.currency}
                        </td>
                        <td>
                          <span
                            className={`receipt-status ${row.receiptId ? 'posted' : 'pending'}`}
                          >
                            {row.receiptId
                              ? 'Confirmé et comptabilisé'
                              : 'Brouillon non comptabilisé'}
                          </span>
                          {row.receiptNumber && (
                            <small className="block">{row.receiptNumber}</small>
                          )}
                        </td>
                        <td className="row-actions">
                          {row.receiptId ? (
                            <button
                              className="text-button"
                              onClick={() => void viewReceipt(row.receiptId!)}
                            >
                              Voir le reçu
                            </button>
                          ) : (
                            <>
                              {canWrite && (
                                <button
                                  className="text-button"
                                  disabled={busy}
                                  onClick={() => void restore(row.id)}
                                >
                                  Reprendre le brouillon
                                </button>
                              )}
                              {canPost && (
                                <button
                                  className="primary-button"
                                  disabled={busy || !row.provenance || !row.category}
                                  onClick={() => {
                                    setSelected(row);
                                    setReceived(false);
                                  }}
                                >
                                  Vérifier et confirmer
                                </button>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {server?.items.length === 0 && (
                <p className="empty-text">Aucune transmission dans votre périmètre.</p>
              )}
              <Pagination page={page} total={server?.total ?? 0} onPage={setPage} />
            </section>
          )}
        </>
      ) : (
        <>
          {!online ? (
            <p className="auth-notice">
              L’historique et les reçus confirmés sont consultables en ligne. Aucun reçu n’est
              généré à partir d’un brouillon hors connexion.
            </p>
          ) : (
            <>
              <form className="panel receipt-filters" onSubmit={filter}>
                <label>
                  Caisse
                  <select value={filterCash} onChange={(e) => setFilterCash(e.target.value)}>
                    <option value="">Toutes les caisses autorisées</option>
                    {cash?.data.items.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.active ? '' : ' (désactivée)'}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Devise
                  <select
                    value={filterCurrency}
                    onChange={(e) => setFilterCurrency(e.target.value)}
                  >
                    <option value="">CDF et USD séparés</option>
                    <option>CDF</option>
                    <option>USD</option>
                  </select>
                </label>
                <label>
                  Catégorie
                  <input
                    value={filterCategory}
                    maxLength={80}
                    onChange={(e) => setFilterCategory(e.target.value)}
                  />
                </label>
                <label>
                  Du
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </label>
                <label>
                  Au
                  <input
                    type="date"
                    value={to}
                    min={from}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </label>
                <label>
                  Provenance, motif, référence ou reçu
                  <input
                    value={search}
                    maxLength={160}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <button className="secondary-button">
                  <Search size={15} />
                  Filtrer l’historique
                </button>
              </form>
              <section className="panel table-wrap">
                <h2>Encaissements comptabilisés</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Reçu et date</th>
                      <th>Provenance</th>
                      <th>Caisse</th>
                      <th>Montant</th>
                      <th>Document</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history?.items.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <strong>{row.number}</strong>
                          <small className="block">{formatDate(row.postedAt)}</small>
                        </td>
                        <td>
                          {row.provenance}
                          <small className="block">
                            {row.category} · {row.reference || 'Sans référence'}
                          </small>
                        </td>
                        <td>
                          {row.agencyName} · {row.cashName}
                        </td>
                        <td className="money-cell">
                          {formatMoney(row.amount)} {row.currency}
                        </td>
                        <td>
                          <button className="text-button" onClick={() => setReceipt(row)}>
                            Consulter le reçu
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {history?.items.length === 0 && (
                  <p className="empty-text">Aucun encaissement correspondant aux filtres.</p>
                )}
                <Pagination page={page} total={history?.total ?? 0} onPage={setPage} />
              </section>
            </>
          )}
        </>
      )}
      {selected && (
        <div className="receipt-overlay">
          <section
            className="confirmation-dialog panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirmation-title"
          >
            <p className="eyebrow">CONFIRMATION FINANCIÈRE</p>
            <h2 id="confirmation-title">Confirmer la réception effective</h2>
            <p>
              De <strong>{selected.provenance}</strong>, dans{' '}
              <strong>{cashName(selected.cashRegisterId)}</strong>.
            </p>
            <div className="confirmation-amount">
              {formatMoney(selected.amount)} <span>{selected.currency}</span>
            </div>
            <p>
              {selected.description} · {selected.reference || 'Sans référence'}
            </p>
            <p>
              La confirmation comptabilise ce montant une seule fois et émet un reçu numéroté. Le
              brouillon ne pourra plus être modifié.
            </p>
            {(!selectedCash?.session || !selectedCash.active) && (
              <p className="auth-notice">
                {!selectedCash?.active
                  ? 'La caisse doit être active.'
                  : 'Une session de caisse doit être ouverte avant confirmation.'}
              </p>
            )}
            {!selectedCash?.session &&
              selectedCash?.active &&
              profile.permissions.includes('session:manage') && (
                <button
                  className="secondary-button"
                  disabled={busy || !online}
                  onClick={() =>
                    void gateway
                      .openCashSession(selected.cashRegisterId)
                      .then(refresh)
                      .catch((e) => setError(message(e)))
                  }
                >
                  Ouvrir la session de cette caisse
                </button>
              )}
            <label className="checkbox-label receipt-attestation">
              <input
                type="checkbox"
                checked={received}
                onChange={(e) => setReceived(e.target.checked)}
              />
              J’atteste avoir effectivement reçu cette somme dans cette devise.
            </label>
            <div className="action-buttons">
              <button
                className="primary-button"
                disabled={
                  !received || !online || busy || !selectedCash?.session || !selectedCash.active
                }
                onClick={() => void confirm()}
              >
                {busy ? 'Confirmation…' : 'Confirmer et comptabiliser'}
              </button>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => setSelected(null)}
              >
                Annuler
              </button>
            </div>
          </section>
        </div>
      )}
      {receipt && (
        <ReceiptViewer
          receipt={receipt}
          gateway={gateway}
          online={online}
          onClose={() => setReceipt(null)}
        />
      )}
    </>
  );
}
function Pagination({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage(page: number): void;
}) {
  return (
    <div className="receipt-pagination">
      <span>
        {total} résultat(s) · Page {page} sur {Math.max(1, Math.ceil(total / 25))}
      </span>
      <div className="action-buttons">
        <button className="secondary-button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Précédent
        </button>
        <button
          className="secondary-button"
          disabled={page * 25 >= total}
          onClick={() => onPage(page + 1)}
        >
          Suivant
        </button>
      </div>
    </div>
  );
}
