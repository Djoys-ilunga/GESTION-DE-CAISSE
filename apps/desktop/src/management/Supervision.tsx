import { useMoney } from '../money/MoneyContext';
import { useEffect, useRef, useState } from 'react';
import { Bell, Users, Wallet, WifiOff } from 'lucide-react';
import type { CashSnapshot, SessionProfile, Supervision, SyncStatus } from '@caissepro/shared';
import { message, type AuthGateway } from '../auth/gateway';
import { formatDate } from '../cash/CashPage';
export function useSupervision(gateway: AuthGateway, online: boolean, allowed: boolean) {
  const [data, setData] = useState<Supervision | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true,
      running = false;
    setData(null);
    setError('');
    async function update() {
      if (running || !online || !allowed) return;
      running = true;
      try {
        const v = await gateway.supervision();
        if (active) {
          setData(v);
          setError('');
        }
      } catch (e) {
        if (active) {
          setData(null);
          setError(message(e));
        }
      } finally {
        running = false;
      }
    }
    void update();
    const timer = setInterval(() => void update(), 60000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [gateway, online, allowed]);
  return { data, error };
}
export function NotificationCenter({
  data,
  error,
  online,
  onNavigate,
}: {
  data: Supervision | null;
  error: string;
  online: boolean;
  onNavigate(page: string): void;
}) {
  const [open, setOpen] = useState(false),
    [dismissed, setDismissed] = useState<string[]>([]),
    ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!online) {
      setOpen(false);
      setDismissed([]);
    }
  }, [online]);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div className="notification-center" ref={ref}>
      <button
        className="notification-toggle"
        aria-label="Notifications internes"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Bell size={19} />
        {online && data && data.notificationTotal > 0 && (
          <span className="notification-count">{data.notificationTotal}</span>
        )}
      </button>
      {open && (
        <section
          className="notification-popover"
          aria-label="Centre des notifications"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
            }
          }}
        >
          <h2>Notifications internes</h2>
          {!online ? (
            <p>Indisponibles hors connexion. Aucun rapport sensible n’est conservé ici.</p>
          ) : error ? (
            <p role="alert">Notifications indisponibles : {error}</p>
          ) : !data ? (
            <p>Chargement depuis le serveur…</p>
          ) : (
            <>
              <p className="data-stamp">
                Serveur · {formatDate(data.generatedAt)} · 20 événements au plus
              </p>
              {data.notifications
                .filter((n) => !dismissed.includes(n.id))
                .map((n) => (
                  <article className={`notification-item ${n.severity}`} key={n.id}>
                    <strong>{n.title}</strong>
                    <p>{n.message}</p>
                    <small>{formatDate(n.createdAt)}</small>
                    <div className="action-buttons">
                      <button
                        className="text-button"
                        onClick={() => {
                          onNavigate(n.target);
                          setOpen(false);
                        }}
                      >
                        Consulter
                      </button>
                      <button
                        className="text-button"
                        aria-label={'Masquer ' + n.title}
                        onClick={() => setDismissed([...dismissed, n.id])}
                      >
                        Masquer
                      </button>
                    </div>
                  </article>
                ))}
              {!data.notifications.filter((n) => !dismissed.includes(n.id)).length && (
                <p>Aucune notification à afficher.</p>
              )}
              <small>Masquer retire la notification de cette session uniquement.</small>
            </>
          )}
        </section>
      )}
    </div>
  );
}
export function SupervisionPanel({
  data,
  error = '',
}: {
  data: Supervision | null;
  error?: string;
}) {
  if (!data)
    return (
      <section className="panel supervision-panel">
        <h2>État des caisses et utilisateurs</h2>
        <p>
          {error
            ? 'Supervision indisponible : ' + error
            : 'Chargement de la supervision depuis le serveur…'}
        </p>
      </section>
    );
  return (
    <section className="panel supervision-panel">
      <div className="panel-heading">
        <h2>
          <Wallet size={19} />
          Supervision des caisses autorisées
        </h2>
        <small className="data-stamp">{formatDate(data.generatedAt)}</small>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Caisse</th>
              <th>Agence</th>
              <th>État</th>
              <th>Session de caisse</th>
            </tr>
          </thead>
          <tbody>
            {data.cash.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.agencyName}</td>
                <td>
                  <span className={c.active ? 'state-pill success' : 'state-pill muted'}>
                    {c.active ? 'Active' : 'Désactivée'}
                  </span>
                </td>
                <td>{c.openedAt ? 'Ouverte depuis ' + formatDate(c.openedAt) : 'Fermée'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data.cash.length && <p>Aucune caisse dans votre périmètre.</p>}
      {data.users !== null && (
        <>
          <h3>
            <Users size={18} />
            Statut des utilisateurs affectés
          </h3>
          <p>Une session valide n’atteste pas une présence en temps réel.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Utilisateur</th>
                  <th>Compte</th>
                  <th>Sessions valides</th>
                  <th>Dernière activité de ces sessions</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.active ? 'Actif' : 'Désactivé'}</td>
                    <td>{u.validSessions}</td>
                    <td>{u.lastSeenAt ? formatDate(u.lastSeenAt) : 'Aucune session valide'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
export function SyncStamp({
  gateway,
  profile,
  online,
}: {
  gateway: AuthGateway;
  profile: SessionProfile;
  online: boolean;
}) {
  const [status, setStatus] = useState<SyncStatus | null>(null),
    [failed, setFailed] = useState(false);
  const allowed = profile.permissions.includes('draft:read_own');
  useEffect(() => {
    let active = true;
    const load = () => {
      if (allowed)
        void gateway
          .syncStatus()
          .then((v) => {
            if (active) {
              setStatus(v);
              setFailed(false);
            }
          })
          .catch(() => {
            if (active) {
              setStatus(null);
              setFailed(true);
            }
          });
    };
    load();
    const timer = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [gateway, allowed, online]);
  return (
    <div className="sync-stamp">
      <span>{online ? 'Données en ligne' : 'Hors connexion · informations anciennes'}</span>
      <span>
        {allowed
          ? failed
            ? 'Dernière synchronisation indisponible'
            : status?.lastSuccessfulAt
              ? 'Dernière synchronisation : ' + formatDate(status.lastSuccessfulAt)
              : status
                ? 'Aucune synchronisation effectuée'
                : 'Vérification de la synchronisation…'
          : 'Dernière validation serveur : ' + formatDate(profile.validatedAt)}
      </span>
    </div>
  );
}
export function OfflineOverview({
  gateway,
  profile,
  onNavigate,
}: {
  gateway: AuthGateway;
  profile: SessionProfile;
  onNavigate(page: string): void;
}) {
  const { format: formatMoney } = useMoney();
  const [cash, setCash] = useState<CashSnapshot | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    if (
      profile.permissions.includes('offline:access') &&
      profile.permissions.includes('ledger:read')
    )
      void gateway
        .cashCatalog()
        .then((v) => {
          if (active) setCash(v);
        })
        .catch((e) => {
          if (active) setError(message(e));
        });
    return () => {
      active = false;
    };
  }, [gateway, profile.authorizationVersion]);
  return (
    <div className="offline-overview">
      <header className="page-heading">
        <div>
          <p className="eyebrow">CONSULTATION LIMITÉE</p>
          <h1>Votre espace hors connexion</h1>
          <p>Les opérations définitives exigent une validation serveur.</p>
        </div>
        <WifiOff size={28} />
      </header>
      <section className="panel">
        <h2>Soldes anciens de cette session</h2>
        {cash ? (
          <>
            <p className="auth-notice">
              Dernière lecture serveur : {formatDate(cash.data.synchronizedAt)}. Ces montants ne
              sont pas actualisés.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Caisse</th>
                    <th>Devise</th>
                    <th>Ancien solde</th>
                    <th>Ancien disponible</th>
                  </tr>
                </thead>
                <tbody>
                  {cash.data.items.flatMap((c) =>
                    c.funds.map((f) => (
                      <tr key={c.id + f.currency}>
                        <td>{c.name}</td>
                        <td>{f.currency}</td>
                        <td>{formatMoney(f.balance)}</td>
                        <td>{formatMoney(f.available)}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p>
            {error
              ? 'Aucun solde local consultable dans cette session.'
              : 'Vérification des données locales autorisées…'}
          </p>
        )}
      </section>
      <section className="panel">
        <h2>Continuer à préparer votre travail</h2>
        <p>
          Consultez vos brouillons et le centre de synchronisation. Aucune approbation, remise,
          réception, conversion ou clôture n’est disponible hors connexion.
        </p>
        <p>
          Aucun rapport financier sensible n’est conservé sur cet appareil. Reconnectez-vous pour
          consulter et exporter les rapports.
        </p>
        <div className="action-buttons">
          <button className="secondary-button" onClick={() => onNavigate('cash')}>
            Consulter les caisses
          </button>
          {profile.permissions.includes('draft:read_own') && (
            <button className="secondary-button" onClick={() => onNavigate('sync')}>
              Ouvrir le centre de synchronisation
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
