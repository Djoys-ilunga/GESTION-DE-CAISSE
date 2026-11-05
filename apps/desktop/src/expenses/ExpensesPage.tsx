import { useEffect, useRef, useState } from 'react';
import { ClipboardCheck, Plus, RefreshCw } from 'lucide-react';
import {
  decideExpenseSchema,
  type CashSnapshot,
  type ExpenseDraftList,
  type ExpenseList,
  type ExpenseView,
  type PaymentVoucher,
  type SessionProfile,
  type SupportingDocument,
} from '@caissepro/shared';
import { message, type AuthGateway, type SessionDraft } from '../auth/gateway';
import { formatDate, formatMoney } from '../cash/CashPage';
import { ExpenseForm } from './ExpenseForm';
import { ExpensePolicies } from './ExpensePolicies';
import { VoucherViewer } from './VoucherViewer';
import '../cash/cash.css';
import './expenses.css';

const labels = {
  PENDING: 'En attente d’approbation',
  APPROVED: 'Approuvée / Fonds réservés',
  REJECTED: 'Rejetée',
  PAID: 'Payée',
  CANCELLED: 'Annulée',
};
export function ExpensesPage({
  profile,
  gateway,
  online,
}: {
  profile: SessionProfile;
  gateway: AuthGateway;
  online: boolean;
}) {
  const can = (permission: string) => profile.permissions.includes(permission);
  const [tab, setTab] = useState<'drafts' | 'requests' | 'policies'>(
      can('draft:read_own') ? 'drafts' : 'requests',
    ),
    [drafts, setDrafts] = useState<SessionDraft[]>([]),
    [server, setServer] = useState<ExpenseDraftList | null>(null),
    [list, setList] = useState<ExpenseList | null>(null),
    [cash, setCash] = useState<CashSnapshot | null>(null),
    [form, setForm] = useState<{ source: SessionDraft | null; copy: boolean } | null>(null),
    [selected, setSelected] = useState<ExpenseView | null>(null),
    [voucher, setVoucher] = useState<PaymentVoucher | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [page, setPage] = useState(1),
    [draftPage, setDraftPage] = useState(1),
    [state, setState] = useState(''),
    [currency, setCurrency] = useState('');
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function load() {
    const calls = await Promise.allSettled([
      can('draft:read_own') ? gateway.drafts() : Promise.resolve([]),
      gateway.cashCatalog(),
      online && can('draft:read_own') ? gateway.expenseDrafts(draftPage) : Promise.resolve(null),
      online
        ? gateway.expenseList({
            page,
            ...(state ? { state: state as ExpenseView['state'] } : {}),
            ...(currency ? { currency: currency as 'CDF' | 'USD' } : {}),
          })
        : Promise.resolve(null),
    ]);
    if (!mounted.current) return;
    const [local, catalog, remote, requests] = calls;
    if (local.status === 'fulfilled')
      setDrafts(local.value.filter((d) => d.draft.kind === 'expense-request'));
    if (catalog.status === 'fulfilled') setCash(catalog.value);
    if (remote.status === 'fulfilled' && remote.value) setServer(remote.value);
    if (requests.status === 'fulfilled' && requests.value) {
      const next = requests.value;
      setList(next);
      setSelected((old) => (old ? (next.items.find((r) => r.id === old.id) ?? null) : null));
    }
    const failed = calls.find((r) => r.status === 'rejected');
    if (failed?.status === 'rejected') setError(message(failed.reason));
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      const local = can('draft:read_own') ? await gateway.drafts().catch(() => []) : [];
      const catalog = await gateway.cashCatalog().catch(() => null);
      const remote =
        online && can('draft:read_own')
          ? await gateway.expenseDrafts(draftPage).catch((e) => {
              if (active) setError(message(e));
              return null;
            })
          : null;
      const requests = online
        ? await gateway
            .expenseList({
              page,
              ...(state ? { state: state as ExpenseView['state'] } : {}),
              ...(currency ? { currency: currency as 'CDF' | 'USD' } : {}),
            })
            .catch((e) => {
              if (active) setError(message(e));
              return null;
            })
        : null;
      if (!active) return;
      setDrafts(local.filter((r) => r.draft.kind === 'expense-request'));
      if (catalog) setCash(catalog);
      if (remote) setServer(remote);
      if (requests) {
        setList(requests);
        setSelected((old) => (old ? (requests.items.find((r) => r.id === old.id) ?? null) : null));
      }
    })();
    return () => {
      active = false;
    };
  }, [gateway, online, profile.validatedAt, page, draftPage, state, currency]);
  async function action(work: () => Promise<void>, uncertain = false) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      if (mounted.current)
        setError(
          uncertain
            ? 'Résultat non confirmé. Actualisez les demandes pour connaître l’état central avant de réessayer sur la même demande. ' +
                message(e)
            : message(e),
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function submit(r: ExpenseDraftList['items'][number]) {
    if (!online || !can('expense:request')) return;
    await action(async () => {
      const request = await gateway.submitExpense(r.id, r.version, true);
      if (!mounted.current) return;
      setNotice('Demande soumise. Aucun paiement n’a été effectué.');
      setTab('requests');
      setSelected(request);
      await load();
    }, true);
  }
  async function restore(id: string, copy = false) {
    await action(async () => {
      const row = await gateway.restoreExpenseDraft(id);
      if (mounted.current) setForm({ source: row, copy });
    });
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">AUTORISER AVANT DE DÉCAISSER</p>
          <h1>Dépenses et approbations</h1>
          <p>Préparer, soumettre, approuver puis payer : chaque action conserve sa trace.</p>
        </div>
        <ClipboardCheck size={28} />
      </div>
      <div className="expense-tabs" role="tablist" aria-label="Gestion des dépenses">
        {can('draft:read_own') && (
          <button role="tab" aria-selected={tab === 'drafts'} onClick={() => setTab('drafts')}>
            Préparation et soumission
          </button>
        )}
        <button role="tab" aria-selected={tab === 'requests'} onClick={() => setTab('requests')}>
          Demandes et paiements
        </button>
        {can('cash:configure') && (
          <button role="tab" aria-selected={tab === 'policies'} onClick={() => setTab('policies')}>
            Plafonds et règles
          </button>
        )}
      </div>
      {!online && (
        <p className="auth-notice">
          Hors connexion : informations non actualisées. Soumission, approbation et paiement
          interdits.
        </p>
      )}
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
      {tab === 'policies' && can('cash:configure') ? (
        <ExpensePolicies gateway={gateway} online={online} />
      ) : tab === 'drafts' ? (
        <>
          <div className="expense-toolbar">
            <p>Non soumis / {online ? 'Préparation' : 'Hors connexion'}</p>
            <div className="action-buttons">
              <button
                className="secondary-button"
                disabled={!online || busy}
                onClick={() =>
                  void action(async () => {
                    const results = await gateway.synchronize();
                    if (!mounted.current) return;
                    setNotice(
                      results.length
                        ? results
                            .map(
                              (r) =>
                                `${r.draftId.slice(0, 8)} : ${r.outcome === 'accepted-as-draft' ? 'reçu comme brouillon, non soumis' : r.outcome === 'conflict' ? 'conflit à résoudre' : 'envoi différé ou refusé'}`,
                            )
                            .join(' · ')
                        : 'Aucun brouillon à transmettre.',
                    );
                    await load();
                  })
                }
              >
                <RefreshCw size={15} />
                Synchroniser les brouillons
              </button>
              {can('draft:write_own') && (
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => setForm({ source: null, copy: false })}
                >
                  <Plus size={15} />
                  Préparer une demande
                </button>
              )}
            </div>
          </div>
          <p className="auth-notice">
            Les brouillons locaux sont temporaires : au plus 15 minutes et effacés à la fermeture ou
            au changement d’utilisateur. Un brouillon synchronisé reste non soumis.
          </p>
          {form && (
            <ExpenseForm
              key={`${form.source?.draft.id ?? 'new'}:${form.copy}`}
              gateway={gateway}
              profile={profile}
              cashes={cash?.data.items ?? []}
              source={form.source}
              copy={form.copy}
              onCancel={() => setForm(null)}
              onSaved={() => {
                setForm(null);
                void load();
              }}
            />
          )}
          <section className="panel">
            <h2>Vos brouillons locaux</h2>
            {drafts.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Bénéficiaire et motif</th>
                      <th>Montant</th>
                      <th>État</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drafts.map((r) => (
                      <tr key={r.draft.id}>
                        <td>
                          {r.draft.expenseDetails?.beneficiary ?? 'À compléter'}
                          <small className="expense-muted">{r.draft.description}</small>
                        </td>
                        <td>
                          {formatMoney(r.draft.amount)} {r.draft.currency}
                        </td>
                        <td>
                          {r.state === 'submitted'
                            ? 'Demande soumise'
                            : !online
                              ? 'Non soumis / Hors connexion'
                              : r.state === 'synced'
                                ? 'Synchronisé / Non soumis'
                                : r.state === 'conflict'
                                  ? 'Conflit à résoudre'
                                  : 'Non soumis'}
                        </td>
                        <td>
                          {r.state !== 'submitted' && can('draft:write_own') && (
                            <div className="action-buttons">
                              <button
                                className="text-button"
                                disabled={busy}
                                onClick={() => setForm({ source: r, copy: false })}
                              >
                                Modifier
                              </button>
                              <button
                                className="text-button"
                                disabled={busy}
                                onClick={() => setForm({ source: r, copy: true })}
                              >
                                Créer une copie
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty-text">Aucun brouillon local dans cette session.</p>
            )}
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>Brouillons reçus par le serveur</h2>
              <button
                className="secondary-button"
                disabled={!online || busy}
                onClick={() => void action(load)}
              >
                Actualiser
              </button>
            </div>
            <p>
              La soumission est une action explicite. Les brouillons sans caisse doivent être repris
              dans une copie avec une caisse.
            </p>
            {server?.items.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Bénéficiaire et motif</th>
                      <th>Montant</th>
                      <th>Justificatifs</th>
                      <th>État</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {server.items.map((r) => (
                      <tr key={r.id}>
                        <td>
                          {r.beneficiary ?? 'À compléter'}
                          <small className="expense-muted">{r.description}</small>
                        </td>
                        <td>
                          {formatMoney(r.amount)} {r.currency}
                        </td>
                        <td>{r.documentCount}</td>
                        <td>{r.expenseRequestId ? 'Soumis' : 'Non soumis'}</td>
                        <td>
                          {!r.expenseRequestId && (
                            <div className="action-buttons">
                              <button
                                className="secondary-button"
                                disabled={!online || busy || !can('draft:write_own')}
                                onClick={() => void restore(r.id, !r.cashRegisterId)}
                              >
                                Reprendre
                              </button>
                              {can('expense:request') && (
                                <button
                                  className="primary-button"
                                  disabled={!online || busy || !r.cashRegisterId || !r.beneficiary}
                                  onClick={() => void submit(r)}
                                >
                                  Soumettre la demande
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty-text">Aucun brouillon serveur consulté.</p>
            )}
            <div className="expense-toolbar">
              <button
                className="secondary-button"
                disabled={!online || draftPage <= 1 || busy}
                onClick={() => setDraftPage((p) => p - 1)}
              >
                Brouillons précédents
              </button>
              <span>Page {draftPage}</span>
              <button
                className="secondary-button"
                disabled={!online || !server || draftPage * server.pageSize >= server.total || busy}
                onClick={() => setDraftPage((p) => p + 1)}
              >
                Brouillons suivants
              </button>
            </div>
          </section>
        </>
      ) : (
        <>
          <section className="panel">
            <div className="panel-heading">
              <h2>Demandes de votre périmètre</h2>
              <button
                className="secondary-button"
                disabled={!online || busy}
                onClick={() => void action(load)}
              >
                Actualiser les demandes
              </button>
            </div>
            {list && (
              <p className="section-description">
                Données du {formatDate(list.synchronizedAt)}
                {online ? '' : ' — Non actualisées'}.
              </p>
            )}
            <div className="form-grid">
              <label>
                État de la demande
                <select
                  value={state}
                  disabled={!online || busy}
                  onChange={(e) => {
                    setState(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">Tous les états</option>
                  {Object.entries(labels).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Devise des demandes
                <select
                  value={currency}
                  disabled={!online || busy}
                  onChange={(e) => {
                    setCurrency(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">CDF et USD séparés</option>
                  <option>CDF</option>
                  <option>USD</option>
                </select>
              </label>
            </div>
            {list?.items.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Bénéficiaire et motif</th>
                      <th>Caisse</th>
                      <th>Montant</th>
                      <th>État</th>
                      <th>Détail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.items.map((r) => (
                      <tr key={r.id}>
                        <td>
                          {r.beneficiary ?? 'Demande historique'}
                          <small className="expense-muted">{r.description}</small>
                        </td>
                        <td>{r.cashName ?? r.agencyName}</td>
                        <td>
                          {formatMoney(r.amount)} {r.currency}
                        </td>
                        <td>{labels[r.state]}</td>
                        <td>
                          <button className="text-button" onClick={() => setSelected(r)}>
                            Consulter
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty-text">Aucune demande consultée.</p>
            )}
            <div className="expense-toolbar">
              <button
                className="secondary-button"
                disabled={!online || page <= 1 || busy}
                onClick={() => setPage((p) => p - 1)}
              >
                Demandes précédentes
              </button>
              <span>Page {page}</span>
              <button
                className="secondary-button"
                disabled={!online || !list || page * list.pageSize >= list.total || busy}
                onClick={() => setPage((p) => p + 1)}
              >
                Demandes suivantes
              </button>
            </div>
          </section>
          {selected && (
            <ExpenseDetail
              key={`${selected.id}:${selected.version}:${online}`}
              expense={selected}
              profile={profile}
              online={online}
              busy={busy}
              gateway={gateway}
              onDecide={(decision, reason) =>
                void action(async () => {
                  const updated = await gateway.decideExpense(
                    selected.id,
                    decideExpenseSchema.parse({
                      expectedVersion: selected.version,
                      decision,
                      reason,
                    }),
                  );
                  if (!mounted.current) return;
                  setSelected(updated);
                  setNotice(
                    decision === 'APPROVE'
                      ? 'Demande approuvée et fonds réservés. Aucun paiement effectué.'
                      : 'Demande rejetée. Aucun paiement effectué.',
                  );
                  await load();
                }, true)
              }
              onPay={() =>
                void action(async () => {
                  const v = await gateway.payExpense(selected.id, selected.version, true);
                  if (!mounted.current) return;
                  setVoucher(v);
                  setNotice('Paiement confirmé et comptabilisé par le serveur.');
                  await load();
                }, true)
              }
              onVoucher={(id) =>
                void action(async () => {
                  const v = await gateway.paymentVoucher(id);
                  if (mounted.current) setVoucher(v);
                })
              }
            />
          )}
        </>
      )}
      {voucher && (
        <VoucherViewer voucher={voucher} online={online} onClose={() => setVoucher(null)} />
      )}
    </>
  );
}
function ExpenseDetail({
  expense,
  profile,
  online,
  busy,
  gateway,
  onDecide,
  onPay,
  onVoucher,
}: {
  expense: ExpenseView;
  profile: SessionProfile;
  online: boolean;
  busy: boolean;
  gateway: AuthGateway;
  onDecide(decision: 'APPROVE' | 'REJECT', reason: string): void;
  onPay(): void;
  onVoucher(id: string): void;
}) {
  const [reason, setReason] = useState(''),
    [attested, setAttested] = useState(false),
    [evidence, setEvidence] = useState<SupportingDocument | null>(null),
    [error, setError] = useState('');
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const can = (p: string) => profile.permissions.includes(p),
    eligible = online && !busy && Boolean(expense.sourceDraftId);
  return (
    <section className="panel expense-detail">
      <h2>Détail de la demande</h2>
      <p>
        <strong>{expense.beneficiary ?? 'Demande historique'}</strong> ·{' '}
        {formatMoney(expense.amount)} {expense.currency}
      </p>
      <p>{expense.description}</p>
      <p>
        {expense.agencyName} · {expense.cashName} · {labels[expense.state]}
      </p>
      <p>
        Demandée par {expense.requesterName}, le {formatDate(expense.createdAt)}. Référence :{' '}
        {expense.reference || 'Non renseignée'}.
      </p>
      {expense.approval && (
        <p>
          {expense.approval.decision === 'APPROVE' ? 'Approuvée' : 'Rejetée'} par{' '}
          {expense.approval.approverName}, le {formatDate(expense.approval.createdAt)}.
          {expense.approval.reason && ` Motif : ${expense.approval.reason}`}
        </p>
      )}
      {expense.reservation && (
        <p>
          Réservation :{' '}
          {expense.reservation === 'ACTIVE'
            ? 'Fonds réservés, aucun paiement'
            : expense.reservation === 'CONSUMED'
              ? 'Consommée par le paiement'
              : 'Libérée'}
          .
        </p>
      )}
      <div className="action-buttons">
        {expense.evidence.map((d) => (
          <button
            key={d.id}
            className="secondary-button"
            disabled={!online || busy}
            onClick={() =>
              void gateway
                .expenseEvidence(expense.id, d.id)
                .then((v) => {
                  if (mounted.current) setEvidence(v);
                })
                .catch((e) => {
                  if (mounted.current) setError(message(e));
                })
            }
          >
            Justificatif : {d.fileName}
          </button>
        ))}
      </div>
      {evidence &&
        (evidence.mimeType.startsWith('image/') ? (
          <img
            className="expense-evidence-preview"
            alt="Justificatif de la dépense"
            src={`data:${evidence.mimeType};base64,${evidence.dataBase64}`}
          />
        ) : (
          <p>
            PDF conservé sur le serveur : {evidence.fileName}. Prévisualisation PDF et export sur
            disque indisponibles.
          </p>
        ))}
      {!expense.sourceDraftId && (
        <p className="auth-notice">
          Demande historique consultable. Le nouveau circuit s’applique aux demandes soumises depuis
          ce module.
        </p>
      )}
      {expense.state === 'PENDING' &&
        can('expense:approve') &&
        (expense.requestedById === profile.user.id ? (
          <p className="auth-notice">Vous ne pouvez pas approuver votre propre demande.</p>
        ) : (
          <div className="expense-decision">
            <label>
              Motif de décision (obligatoire pour un rejet)
              <textarea
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={!eligible}
              />
            </label>
            <div className="action-buttons">
              <button
                className="primary-button"
                disabled={!eligible}
                onClick={() => onDecide('APPROVE', reason)}
              >
                Approuver et réserver les fonds
              </button>
              <button
                className="secondary-button"
                disabled={!eligible || reason.trim().length < 3}
                onClick={() => onDecide('REJECT', reason)}
              >
                Rejeter la demande
              </button>
            </div>
          </div>
        ))}
      {expense.state === 'APPROVED' && can('expense:pay') && (
        <div className="expense-decision">
          <p>
            L’approbation n’est pas un paiement. Vérifiez le bénéficiaire et la remise effective des
            fonds.
          </p>
          <label className="attestation">
            <input
              type="checkbox"
              checked={attested}
              disabled={!eligible}
              onChange={(e) => setAttested(e.target.checked)}
            />
            Je confirme la remise effective de {formatMoney(expense.amount)} {expense.currency} à{' '}
            {expense.beneficiary}.
          </label>
          <button className="primary-button" disabled={!eligible || !attested} onClick={onPay}>
            Confirmer le paiement
          </button>
        </div>
      )}
      {expense.voucher && (
        <button
          className="primary-button"
          disabled={!online || busy}
          onClick={() => onVoucher(expense.voucher!.id)}
        >
          Consulter le bon {expense.voucher.number}
        </button>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
