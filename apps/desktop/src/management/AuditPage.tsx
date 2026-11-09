import { AUDIT_ACTION_LABELS, AUDIT_TARGET_LABELS } from '@caissepro/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ScrollText, Printer } from 'lucide-react';
import type { AuditPage as AuditData, AuditQuery, SessionProfile } from '@caissepro/shared';
import { message, type AuthGateway } from '../auth/gateway';
import { formatDate } from '../cash/CashPage';
const auditLabels = AUDIT_ACTION_LABELS,
  targetLabels = AUDIT_TARGET_LABELS;
export function AuditPage({
  gateway,
  profile,
  online,
}: {
  gateway: AuthGateway;
  profile: SessionProfile;
  online: boolean;
}) {
  const [data, setData] = useState<AuditData | null>(null),
    [query, setQuery] = useState<AuditQuery>({ page: 1 }),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [cash, setCash] = useState(''),
    [action, setAction] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    setData(null);
    setError('');
    if (!online) {
      setBusy(false);
      return;
    }
    setBusy(true);
    void gateway
      .auditLog(query)
      .then((v) => {
        if (n === seq.current) setData(v);
      })
      .catch((e) => {
        if (n === seq.current) setError(message(e));
      })
      .finally(() => {
        if (n === seq.current) setBusy(false);
      });
    return () => {
      seq.current++;
    };
  }, [gateway, online, query, profile.authorizationVersion]);
  async function save(format: 'pdf' | 'xlsx') {
    if (!data || !online || busy) return;
    const epoch = seq.current;
    setBusy(true);
    setError('');
    try {
      const r = await gateway.saveAudit(format, query);
      if (epoch !== seq.current) return;
      setNotice(r.saved ? 'Journal enregistré à l’emplacement choisi.' : 'Enregistrement annulé.');
    } catch (e) {
      if (epoch === seq.current) setError(message(e));
    } finally {
      if (epoch === seq.current) setBusy(false);
    }
  }
  const apply = (e: FormEvent) => {
    e.preventDefault();
    if (from && to && from > to) {
      setError('La date de fin doit suivre la date de début.');
      return;
    }
    setQuery({
      page: 1,
      ...(from ? { from: new Date(from + 'T00:00:00+01:00').toISOString() } : {}),
      ...(to
        ? { to: new Date(Date.parse(to + 'T00:00:00+01:00') + 86400000 - 1).toISOString() }
        : {}),
      ...(cash ? { cashRegisterId: cash } : {}),
      ...(action ? { action } : {}),
    });
  };
  if (!online)
    return (
      <section className="panel empty-state">
        <ScrollText size={32} />
        <h1>Journal d’audit indisponible hors connexion</h1>
        <p>Ce journal sensible est consulté directement sur le serveur.</p>
      </section>
    );
  return (
    <div className="audit-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">SUPERVISION ET TRAÇABILITÉ</p>
          <h1>Journal d’audit</h1>
          <p>Événements métier immuables, limités à vos caisses et agences autorisées.</p>
        </div>
      </header>
      <form className="panel report-filters" onSubmit={apply}>
        <label>
          Du
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Au
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Caisse du journal
          <select value={cash} onChange={(e) => setCash(e.target.value)}>
            <option value="">Toutes mes caisses</option>
            {profile.cashRegisters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Événement
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Tous les événements</option>
            {Object.entries(auditLabels).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button className="primary-button" disabled={busy}>
          Filtrer le journal
        </button>
      </form>
      {notice && (
        <p role="status" className="auth-notice">
          {notice}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {busy && <p role="status">Chargement du journal depuis le serveur…</p>}
      {data && (
        <section className="panel report-doc">
          <header className="report-doc-header">
            <div>
              <h2>{profile.company.name} · Journal d’audit</h2>
              <p>
                {profile.company.code} · Africa/Kinshasa · {formatDate(data.generatedAt)}
              </p>
              <p>
                {data.total} événement(s) · page {data.page} · 50 événements au plus par page
              </p>
            </div>
            <div className="action-buttons report-tools">
              <button className="secondary-button" disabled={busy} onClick={() => void save('pdf')}>
                Exporter le journal PDF
              </button>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void save('xlsx')}
              >
                Exporter le journal Excel
              </button>
              <button className="secondary-button report-tools" onClick={() => window.print()}>
                <Printer size={16} />
                Imprimer cette page
              </button>
            </div>
          </header>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Événement</th>
                  <th>Responsable</th>
                  <th>Objet</th>
                  <th>Référence</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td>{formatDate(r.createdAt)}</td>
                    <td>{auditLabels[r.action] ?? 'Événement métier'}</td>
                    <td>{r.actorName}</td>
                    <td>{targetLabels[r.targetType] ?? 'Élément métier'}</td>
                    <td>
                      <small>{r.targetId}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.items.length && <p>Aucun événement dans ce périmètre.</p>}
          <div className="pager report-tools">
            <button
              className="secondary-button"
              disabled={busy || data.page <= 1}
              onClick={() => setQuery({ ...query, page: data.page - 1 })}
            >
              Page précédente
            </button>
            <button
              className="secondary-button"
              disabled={busy || data.page * 50 >= data.total}
              onClick={() => setQuery({ ...query, page: data.page + 1 })}
            >
              Page suivante
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
