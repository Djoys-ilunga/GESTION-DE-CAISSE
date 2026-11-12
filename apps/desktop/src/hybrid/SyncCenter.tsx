import { StorageNotice } from './StorageNotice';
import { useEffect, useRef, useState } from 'react';
import type {
  CashSnapshot,
  FormBuffer,
  SessionProfile,
  SyncStatus,
  SyncManifest,
  SyncEvents,
} from '@caissepro/shared';
import { message, type AuthGateway, type SessionDraft } from '../auth/gateway';
import { ReceiptForm } from '../cash/ReceiptForm';
import { ExpenseForm } from '../expenses/ExpenseForm';
import { formatDate } from '../cash/CashPage';
import '../cash/cash.css';
const labels: Record<string, string> = {
  local: 'Local',
  queued: 'En attente de synchronisation',
  syncing: 'En cours',
  synced: 'Synchronisé',
  conflict: 'Conflit',
  error: 'Erreur',
  confirmed: 'Synchronisé / Encaissement confirmé',
  submitted: 'Synchronisé / Demande soumise',
};
const codeLabel: Record<string, string> = {
  'cache-refresh-failed': 'Brouillon reçu ; les données de consultation restent à actualiser.',
  started: 'Transmission démarrée',
  'draft-received': 'Reçu comme brouillon',
  conflict: 'Version serveur différente',
  'validation-failed': 'Données ou autorisations à vérifier',
  'permission-denied': 'Permissions refusées',
  expired: 'Brouillon expiré',
  interrupted: 'Transmission interrompue',
  'transport-error': 'Réponse indisponible ; reprise avec le même UUID',
  'rate-limited': 'Limite atteinte ; attendre avant de réessayer',
};
export function SyncCenter({
  gateway,
  profile,
  online,
  onOpenTransfer,
}: {
  gateway: AuthGateway;
  profile: SessionProfile;
  online: boolean;
  onOpenTransfer?(id: string): void;
}) {
  const [buffers, setBuffers] = useState<FormBuffer[]>([]);
  const [inputBuffer, setInputBuffer] = useState<FormBuffer | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null),
    [rows, setRows] = useState<SessionDraft[]>([]),
    [remote, setRemote] = useState<SyncManifest | null>(null),
    [journal, setJournal] = useState<SyncEvents | null>(null),
    [cash, setCash] = useState<CashSnapshot | null>(null),
    [editing, setEditing] = useState<SessionDraft | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [page, setPage] = useState(1),
    [internet, setInternet] = useState(navigator.onLine);
  const active = useRef(false);
  const canWrite = profile.permissions.includes('draft:write_own');
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    const update = () => setInternet(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  async function local() {
    const [s, d, b] = await Promise.all([
      gateway.syncStatus(),
      gateway.drafts(),
      gateway.formBuffers(),
    ]);
    if (active.current) {
      setStatus(s);
      setRows(d);
      setBuffers(b);
    }
  }
  async function refresh() {
    await local();
    if (online) {
      const [m, j] = await Promise.all([gateway.syncManifest(page), gateway.syncEvents()]);
      if (active.current) {
        setRemote(m);
        setJournal(j);
      }
    }
  }
  useEffect(() => {
    let current = true;
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const [s, d, b] = await Promise.all([
          gateway.syncStatus(),
          gateway.drafts(),
          gateway.formBuffers(),
        ]);
        if (current) {
          setStatus(s);
          setRows(d);
          setBuffers(b);
        }
      } catch {
        /* Le verrouillage ou la révocation retire cet écran. */
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [gateway]);
  useEffect(() => {
    let current = true;
    void (async () => {
      if (!online) return;
      try {
        const [m, j] = await Promise.all([gateway.syncManifest(page), gateway.syncEvents()]);
        if (current) {
          setRemote(m);
          setJournal(j);
        }
      } catch (e) {
        if (current) setError(message(e));
      }
    })();
    return () => {
      current = false;
    };
  }, [gateway, online, page]);
  useEffect(() => {
    let current = true;
    if (profile.permissions.includes('ledger:read')) {
      void gateway
        .cashCatalog()
        .then((c) => {
          if (current) setCash(c);
        })
        .catch(() => {});
    }
    return () => {
      current = false;
    };
  }, [gateway, online, profile]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      if (active.current) setError(message(e));
    } finally {
      if (active.current) setBusy(false);
    }
  }
  const last = status?.lastSuccessfulAt ?? journal?.lastSuccessfulAt;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">CONTINUITÉ DU TRAVAIL</p>
          <h1>Centre de synchronisation</h1>
          <p>
            Les transmissions préparent des brouillons. Elles ne confirment aucun encaissement,
            aucune approbation ni aucun paiement.
          </p>
        </div>
        <button
          className="primary-button"
          disabled={!online || !canWrite || busy || status?.running}
          onClick={() =>
            void action(async () => {
              const results = await gateway.synchronize();
              if (!active.current) return;
              setNotice(
                results.length
                  ? `${results.filter((r) => r.outcome === 'accepted-as-draft').length} brouillon(s) reçu(s) par le serveur. Consultez les conflits et erreurs ci-dessous.`
                  : 'Aucun brouillon actuellement éligible. Les délais de reprise et conflits sont conservés.',
              );
              await refresh();
            })
          }
        >
          {status?.running ? 'Synchronisation en cours…' : 'Synchroniser maintenant'}
        </button>
      </div>
      <section className="panel">
        <h2>Connexion et protection locale</h2>
        <p>
          Réseau signalé par l’appareil :{' '}
          <strong>{internet ? 'disponible' : 'indisponible'}</strong>. API et session :{' '}
          <strong>
            {online ? 'En ligne, session vérifiée' : 'Hors connexion ou session à revalider'}
          </strong>
          .
        </p>
        <p>
          Dernière transmission réussie :{' '}
          {last ? formatDate(last) : 'Aucune dans les données consultées'}.
        </p>
        {status?.cacheUpdatedAt && (
          <p>Consultations actualisées le {formatDate(status.cacheUpdatedAt)}.</p>
        )}
        <StorageNotice gateway={gateway} status={status ?? undefined} />
        {!online && (
          <p>
            Informations locales non actualisées. Aucun envoi ni traitement financier n’est
            autorisé.
          </p>
        )}
      </section>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="auth-notice">
          {notice}
        </p>
      )}
      <div className="stat-grid">
        {Object.entries(status?.counts ?? {}).map(([key, value]) => (
          <article className="stat-card" key={key}>
            <h3>{labels[key]}</h3>
            <strong>{value}</strong>
          </article>
        ))}
      </div>
      {(editing || (inputBuffer && inputBuffer.kind !== 'transfer')) &&
        ((editing?.draft.kind ?? inputBuffer?.kind) === 'receipt' ? (
          <ReceiptForm
            online={online}
            key={editing?.draft.id ?? inputBuffer?.id}
            gateway={gateway}
            cashes={cash?.data.items ?? []}
            editing={editing}
            buffer={inputBuffer ?? undefined}
            onSaved={() => {
              setEditing(null);
              setInputBuffer(null);
              void local().catch((e) => {
                if (active.current) setError(message(e));
              });
            }}
            onCancel={() => {
              setEditing(null);
              setInputBuffer(null);
            }}
          />
        ) : (
          <ExpenseForm
            online={online}
            key={editing?.draft.id ?? inputBuffer?.id}
            gateway={gateway}
            profile={profile}
            cashes={cash?.data.items ?? []}
            source={editing}
            buffer={inputBuffer ?? undefined}
            copy={false}
            onSaved={() => {
              setEditing(null);
              setInputBuffer(null);
              void local().catch((e) => {
                if (active.current) setError(message(e));
              });
            }}
            onCancel={() => {
              setEditing(null);
              setInputBuffer(null);
            }}
          />
        ))}
      {buffers.length > 0 && (
        <section className="panel">
          <h2>Saisies interrompues ({buffers.length})</h2>
          <p>
            Ces champs incomplets restent dans votre session. Ils ne sont jamais transmis
            automatiquement. Sélectionnez à nouveau les fichiers qui n’avaient pas été enregistrés
            avec un brouillon.
          </p>
          {buffers.map((b) => (
            <div className="expense-toolbar" key={b.id}>
              <span>
                {b.kind === 'receipt'
                  ? 'Encaissement'
                  : b.kind === 'transfer'
                    ? 'Transfert'
                    : 'Demande de dépense'}{' '}
                · {b.id.slice(0, 8)} · Capture du {formatDate(b.updatedAt)}
              </span>
              <button
                className="secondary-button"
                disabled={
                  !canWrite ||
                  busy ||
                  status?.running ||
                  (b.kind === 'transfer' && !onOpenTransfer) ||
                  (b.expectedLocalVersion !== null && !rows.some((r) => r.draft.id === b.id))
                }
                onClick={() => {
                  if (b.kind === 'transfer') {
                    onOpenTransfer?.(b.id);
                    return;
                  }
                  setEditing(rows.find((r) => r.draft.id === b.id) ?? null);
                  setInputBuffer(b);
                }}
              >
                Reprendre la saisie
              </button>
            </div>
          ))}
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>Brouillons de cette session ({rows.length})</h2>
          <button className="secondary-button" disabled={busy} onClick={() => void action(refresh)}>
            Actualiser le centre
          </button>
        </div>
        {rows.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>UUID / Identifiant serveur</th>
                  <th>Dates et versions</th>
                  <th>État</th>
                  <th>Reprise</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const terminal =
                    Boolean(r.confirmedReceiptId || r.submittedExpenseId) ||
                    ['confirmed', 'submitted'].includes(r.state);
                  return (
                    <tr key={r.draft.id}>
                      <td>
                        {r.draft.id}
                        <small className="expense-muted">
                          Serveur : {r.serverId ?? 'Non reçu'}
                        </small>
                      </td>
                      <td>
                        Créé : {formatDate(r.originalCreatedAt ?? r.draft.createdAt)}
                        <small className="expense-muted">
                          Modifié : {formatDate(r.updatedAt)} · Local v{r.version} / Serveur v
                          {r.serverVersion ?? '—'}
                        </small>
                      </td>
                      <td>
                        {labels[r.state] ?? 'État inconnu'}
                        {r.result && (
                          <small className="expense-muted">
                            {codeLabel[r.result.code] ?? 'Consultez le résultat de transmission.'}
                          </small>
                        )}
                      </td>
                      <td>
                        <div className="action-buttons">
                          {canWrite && !terminal && r.state !== 'syncing' && (
                            <button
                              className="text-button"
                              disabled={busy || status?.running}
                              onClick={() => {
                                setInputBuffer(null);
                                setEditing(r);
                              }}
                            >
                              Corriger
                            </button>
                          )}
                          {canWrite && !terminal && ['error', 'queued'].includes(r.state) && (
                            <button
                              className="secondary-button"
                              disabled={busy || status?.running}
                              onClick={() =>
                                void action(async () => {
                                  await gateway.retrySyncDraft(r.draft.id, r.version);
                                  if (active.current)
                                    setNotice(
                                      'Brouillon remis en attente. Son UUID reste identique.',
                                    );
                                  await local();
                                })
                              }
                            >
                              Remettre en attente
                            </button>
                          )}
                          {canWrite && r.state === 'conflict' && (
                            <>
                              <button
                                className="secondary-button"
                                disabled={!online || busy || status?.running}
                                onClick={() =>
                                  void action(async () => {
                                    await gateway.resolveSyncConflict(
                                      r.draft.id,
                                      r.version,
                                      'server',
                                    );
                                    await refresh();
                                  })
                                }
                              >
                                Remplacer par la version serveur
                              </button>
                              {!terminal && (
                                <button
                                  className="secondary-button"
                                  disabled={!online || busy || status?.running}
                                  onClick={() =>
                                    void action(async () => {
                                      await gateway.resolveSyncConflict(
                                        r.draft.id,
                                        r.version,
                                        'local',
                                      );
                                      if (active.current)
                                        setNotice(
                                          'Votre correction est remise en attente sur le même UUID, avec la nouvelle version serveur connue.',
                                        );
                                      await refresh();
                                    })
                                  }
                                >
                                  Conserver ma correction et remettre en attente
                                </button>
                              )}
                            </>
                          )}
                          {r.nextAttemptAt && (
                            <small>
                              Prochain essai au plus tôt : {formatDate(r.nextAttemptAt)} (
                              {r.attempts ?? 0}/5 tentatives)
                            </small>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-text">Aucun brouillon local accessible dans cette session.</p>
        )}
      </section>
      <section className="panel">
        <h2>Copies reçues par le serveur</h2>
        {remote?.items.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>UUID</th>
                  <th>Identifiant serveur</th>
                  <th>État</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {remote.items.map((r) => (
                  <tr key={r.serverId}>
                    <td>{r.clientDraftId}</td>
                    <td>
                      {r.serverId}
                      <small className="expense-muted">
                        Version {r.version} · Modifié le {formatDate(r.updatedAt)}
                      </small>
                    </td>
                    <td>
                      {r.sourceState === 'draft'
                        ? 'Brouillon reçu, non confirmé'
                        : r.sourceState === 'confirmed'
                          ? 'Encaissement déjà confirmé'
                          : 'Demande déjà soumise'}
                    </td>
                    <td>
                      <button
                        className="secondary-button"
                        disabled={
                          !online ||
                          busy ||
                          !canWrite ||
                          rows.some((local) => local.draft.id === r.clientDraftId)
                        }
                        onClick={() =>
                          void action(async () => {
                            await gateway.restoreSynchronizedDraft(r.clientDraftId);
                            await local();
                          })
                        }
                      >
                        Restaurer dans la session
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-text">Aucune copie serveur consultée.</p>
        )}
        <div className="receipt-pagination">
          <button disabled={!online || page <= 1 || busy} onClick={() => setPage((p) => p - 1)}>
            Précédent
          </button>
          <span>
            Page {page}
            {!online ? ' · Informations non actualisées' : ''}
          </span>
          <button
            disabled={!online || busy || !remote || page * 50 >= remote.total}
            onClick={() => setPage((p) => p + 1)}
          >
            Suivant
          </button>
        </div>
      </section>
      <section className="panel">
        <h2>Journal des synchronisations</h2>
        <p>
          Journal limité aux identifiants, versions, dates et codes de résultat. Aucune donnée
          financière détaillée ni secret n’y est inscrit.
        </p>
        {status?.events
          .slice()
          .reverse()
          .map((e, i) => (
            <p key={`${e.at}:${i}`}>
              {formatDate(e.at)} · {e.draftId.slice(0, 8)} · v{e.version} ·{' '}
              {codeLabel[e.code] ?? 'Résultat à vérifier'}
            </p>
          ))}
        {journal?.items.map((e) => (
          <p key={e.id}>
            {formatDate(e.createdAt)} · {e.clientDraftId.slice(0, 8)} · v{e.version} ·{' '}
            {e.stage === 'STARTED' &&
            !journal.items.some(
              (other) => other.attemptId === e.attemptId && other.stage !== 'STARTED',
            )
              ? 'Transmission sans résultat connu : actualiser avant de réessayer.'
              : (codeLabel[e.code] ?? 'Résultat à vérifier')}
          </p>
        ))}
      </section>
    </>
  );
}
