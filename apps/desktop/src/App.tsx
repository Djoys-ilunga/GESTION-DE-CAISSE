import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import {
  Wallet,
  ShieldCheck,
  LockKeyhole,
  LogOut,
  Wifi,
  WifiOff,
  ArrowRight,
  LayoutDashboard,
  FilePenLine,
  Users,
  ScrollText,
  Building2,
  RefreshCw,
  Plus,
  Check,
  Eye,
  EyeOff,
  ReceiptText,
} from 'lucide-react';
import { CashPage } from './cash/CashPage';
import { ReceiptsPage } from './cash/ReceiptsPage';
import {
  ROLE_LABELS,
  type NativeSessionView,
  type SessionProfile,
  type ManagedUser,
  type AccessAssignment,
  type RoleCode,
  type AuthLog,
} from '@caissepro/shared';
import type { ConnectionService } from './hybrid/connection';
import { createLocalDraft } from './hybrid/local-store';
import { AuthController } from './auth/controller';
import {
  NativeAuthGateway,
  message,
  type AuthGateway,
  type Balances,
  type SessionDraft,
  type AccessCatalog,
} from './auth/gateway';
import './auth.css';
const nativeGateway = new NativeAuthGateway();
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
function since(iso: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  return minutes === 0 ? 'à l’instant' : `il y a ${minutes} min`;
}
function money(value: string) {
  const [whole, decimal] = value.split('.');
  return `${(whole ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f')},${decimal ?? '00'}`;
}
const roleName = (code: string) => ROLE_LABELS[code as RoleCode] ?? code;
export function App({
  connection,
  gateway = nativeGateway,
}: {
  connection?: ConnectionService;
  gateway?: AuthGateway;
}) {
  const controller = useMemo(() => new AuthController(gateway), [gateway]);
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [network, setNetwork] = useState<boolean | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    controller.start();
    const timer = setInterval(() => {
      void controller.refresh().catch(() => {});
    }, 1000);
    return () => {
      clearInterval(timer);
      controller.stop();
    };
  }, [controller]);
  useEffect(() => {
    let active = true;
    let checking = false;
    async function check() {
      if (!active || checking) return;
      checking = true;
      try {
        let online = false;
        if (gateway.available) online = await gateway.health();
        else if (connection) {
          await connection.check();
          online = connection.isOnline();
        }
        if (!active) return;
        setNetwork(online);
        const current = controller.getSnapshot();
        if (gateway.available && current.state !== 'anonymous') {
          try {
            const next = await controller.action(() => gateway.revalidate());
            if (
              next.state === 'online' &&
              !next.profile?.user.mustChangePassword &&
              next.profile?.permissions.includes('draft:write_own')
            )
              await gateway.synchronize();
          } catch {
            await controller.refresh().catch(() => {});
          }
        }
      } finally {
        checking = false;
      }
    }
    void check();
    const timer = setInterval(() => {
      void check();
    }, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [controller, gateway, connection]);
  useEffect(() => {
    let last = 0;
    const activity = () => {
      const current = controller.getSnapshot();
      if (
        !['online', 'offline'].includes(current.state) ||
        Date.now() - last < 15000 ||
        current.profile?.user.mustChangePassword
      )
        return;
      last = Date.now();
      void controller.action(() => gateway.activity()).catch(() => {});
    };
    document.addEventListener('pointerdown', activity, { passive: true });
    document.addEventListener('keydown', activity);
    document.addEventListener('wheel', activity, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', activity);
      document.removeEventListener('keydown', activity);
      document.removeEventListener('wheel', activity);
    };
  }, [controller, gateway]);
  const logout = async () => {
    setNotice('');
    try {
      await controller.logout();
    } catch {
      setNotice('La session locale est fermée.');
    }
  };
  if (view.state === 'anonymous')
    return (
      <Login
        available={gateway.available}
        network={network}
        notice={notice || reasonLabel(view.reason)}
        onSubmit={(company, email, password) =>
          controller.action(() => gateway.login(company, email, password))
        }
      />
    );
  if (view.state === 'locked' || view.state === 'revalidating' || !view.profile)
    return (
      <Locked
        view={view}
        network={network}
        onUnlock={(password) => controller.action(() => gateway.unlock(password))}
        onLogout={logout}
      />
    );
  if (view.profile.user.mustChangePassword)
    return (
      <ChangePassword
        onSubmit={(current, next) => controller.action(() => gateway.changePassword(current, next))}
        onLogout={logout}
      />
    );
  const scopeKey = [
    view.generation,
    view.profile.user.id,
    view.profile.authorizationVersion,
    view.profile.permissions.join(','),
    view.profile.agencies
      .map((a) => a.id)
      .sort()
      .join(','),
    view.profile.cashRegisters.map((r) => r.id).join(','),
  ].join(':');
  return (
    <Workspace
      key={scopeKey}
      view={view as NativeSessionView & { profile: SessionProfile }}
      gateway={gateway}
      onLock={() => controller.action(() => gateway.lock())}
      onLogout={logout}
    />
  );
}
function reasonLabel(reason: string | null) {
  if (reason === 'PASSWORD_CHANGED')
    return 'Mot de passe renouvelé. Connectez-vous avec votre nouveau mot de passe.';
  if (reason === 'SESSION_EXPIRED') return 'Votre session a expiré. Connectez-vous de nouveau.';
  if (reason === 'SESSION_REVOKED')
    return 'Votre session ou vos autorisations ont changé. Connectez-vous de nouveau.';
  if (reason === 'TOO_MANY_ATTEMPTS')
    return 'L’accès local a été fermé après plusieurs tentatives. Une connexion au serveur est nécessaire.';
  return '';
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon">
        <Wallet size={23} />
      </span>
      <span>
        Caisse<span className="brand-pro">Pro</span>
        <small>GESTION DE TRÉSORERIE</small>
      </span>
    </div>
  );
}
function Network({ online }: { online: boolean | null }) {
  return (
    <span className={`connection-badge ${online ? 'online' : 'offline'}`} role="status">
      {online ? <Wifi size={15} /> : <WifiOff size={15} />}{' '}
      {online === null ? 'Vérification…' : online ? 'Serveur disponible' : 'Hors connexion'}
    </span>
  );
}
function Login({
  available,
  network,
  notice,
  onSubmit,
}: {
  available: boolean;
  network: boolean | null;
  notice: string;
  onSubmit(company: string, email: string, password: string): Promise<unknown>;
}) {
  const [company, setCompany] = useState(''),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [visible, setVisible] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await onSubmit(company.trim().toUpperCase(), email.trim().toLowerCase(), password);
    } catch (error) {
      setError(message(error));
    } finally {
      setPassword('');
      setBusy(false);
    }
  };
  return (
    <div className="auth-shell">
      <aside className="auth-intro">
        <Brand />
        <div className="auth-intro-body">
          <span className="hero-label">
            <span /> VOTRE ESPACE FINANCIER SÉCURISÉ
          </span>
          <h1>
            La confiance commence
            <br />
            par les bons accès.
          </h1>
          <p>
            Vos agences, vos caisses et vos équipes.
            <br />
            Un cadre clair pour chaque opération.
          </p>
          <div className="auth-illustration" aria-hidden="true">
            <div className="auth-shield">
              <ShieldCheck size={56} />
            </div>
            <div>
              <span>CDF</span>
              <span>USD</span>
            </div>
          </div>
          <ul>
            <li>
              <Check size={17} />
              Des droits adaptés à chaque rôle
            </li>
            <li>
              <Check size={17} />
              Une session personnelle et protégée
            </li>
            <li>
              <Check size={17} />
              Aucun paiement hors connexion
            </li>
          </ul>
        </div>
        <div className="auth-intro-footer">
          <ShieldCheck size={16} />
          Votre trésorerie, sous contrôle.
        </div>
      </aside>
      <main className="auth-main">
        <div className="auth-main-top">
          <span>CaissePro Desktop</span>
          <Network online={network} />
        </div>
        <section className="auth-form-panel">
          <div className="auth-form-icon">
            <LockKeyhole size={24} />
          </div>
          <p className="eyebrow">ACCÈS À VOTRE ENTREPRISE</p>
          <h2>Connectez-vous à votre espace</h2>
          <p className="auth-subtitle">Utilisez les accès fournis par votre administrateur.</p>
          {notice && (
            <p className="auth-notice" role="status">
              {notice}
            </p>
          )}
          {!available && (
            <div className="auth-notice">
              Ouvrez l’application CaissePro pour vous connecter. Cet aperçu ne permet pas d’ouvrir
              une session.
            </div>
          )}
          <form onSubmit={submit}>
            <label htmlFor="company">Code entreprise</label>
            <div className="input-icon">
              <Building2 size={17} />
              <input
                id="company"
                autoComplete="organization"
                value={company}
                onChange={(e) => setCompany(e.target.value.toUpperCase())}
                placeholder="Ex. ENTREPRISE"
                required
                maxLength={32}
                disabled={busy}
              />
            </div>
            <label htmlFor="email">Adresse e-mail</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="nom@entreprise.cd"
              required
              maxLength={254}
              disabled={busy}
            />
            <label htmlFor="password">Mot de passe</label>
            <div className="password-input">
              <input
                id="password"
                type={visible ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                maxLength={128}
                disabled={busy}
              />
              <button
                type="button"
                aria-label={visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                onClick={() => setVisible(!visible)}
              >
                {visible ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="auth-submit" disabled={busy || !available} type="submit">
              {busy ? 'Vérification des accès…' : 'Se connecter'}
              {busy ? <RefreshCw className="spinning" size={17} /> : <ArrowRight size={18} />}
            </button>
          </form>
          <p className="auth-help">Un problème d’accès ? Contactez votre administrateur.</p>
          <div className="auth-policy">
            <LockKeyhole size={15} />
            <p>
              Une première connexion au serveur est nécessaire. L’accès hors connexion reste
              temporaire et exige un déverrouillage.
            </p>
          </div>
        </section>
        <footer>
          <span>CaissePro · Gestion de caisse d’entreprise</span>
          <span>Session personnelle</span>
        </footer>
      </main>
    </div>
  );
}
function Locked({
  view,
  network,
  onUnlock,
  onLogout,
}: {
  view: NativeSessionView;
  network: boolean | null;
  onUnlock(password: string): Promise<unknown>;
  onLogout(): Promise<void>;
}) {
  const [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onUnlock(password);
    } catch (error) {
      setError(message(error));
    } finally {
      setPassword('');
      setBusy(false);
    }
  };
  return (
    <div className="lock-shell">
      <Brand />
      <section className="lock-card">
        <span className="auth-form-icon">
          <LockKeyhole size={28} />
        </span>
        <h1>
          {view.state === 'revalidating' ? 'Vérification de votre session' : 'Session verrouillée'}
        </h1>
        <p>{view.displayName}</p>
        <Network online={network} />
        {view.state !== 'revalidating' && (
          <>
            <p>Vos informations restent masquées jusqu’au déverrouillage.</p>
            {view.offlineUntil && (
              <p className="auth-notice">
                Accès hors connexion possible jusqu’à {time(view.offlineUntil)}. Les autorisations
                seront revalidées au retour du réseau.
              </p>
            )}
            <form onSubmit={submit}>
              <label htmlFor="unlock-password">Votre mot de passe</label>
              <input
                id="unlock-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                maxLength={128}
                required
              />
              {error && (
                <p role="alert" className="form-error">
                  {error}
                </p>
              )}
              <button className="auth-submit" disabled={busy}>
                {busy ? 'Déverrouillage…' : 'Déverrouiller'}
              </button>
            </form>
          </>
        )}
        <button className="text-button" onClick={() => void onLogout()}>
          Changer d’utilisateur
        </button>
      </section>
    </div>
  );
}
function ChangePassword({
  onSubmit,
  onLogout,
}: {
  onSubmit(current: string, next: string): Promise<unknown>;
  onLogout(): Promise<void>;
}) {
  const [current, setCurrent] = useState(''),
    [next, setNext] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (current === next) {
      setError('Choisissez un mot de passe différent du précédent.');
      return;
    }
    if (next !== confirmation) {
      setError('Les mots de passe ne correspondent pas.');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(current, next);
    } catch (error) {
      setError(message(error));
    } finally {
      setCurrent('');
      setNext('');
      setConfirmation('');
      setBusy(false);
    }
  };
  return (
    <div className="lock-shell">
      <Brand />
      <section className="lock-card">
        <ShieldCheck size={34} />
        <h1>Renouvelez votre mot de passe</h1>
        <p>
          Choisissez une phrase personnelle d’au moins 12 caractères avant d’ouvrir votre espace.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="current-password">Mot de passe actuel</label>
          <input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            maxLength={128}
            required
          />
          <label htmlFor="new-password">Nouveau mot de passe</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            minLength={12}
            maxLength={128}
            required
          />
          <label htmlFor="confirm-password">Confirmer</label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            minLength={12}
            maxLength={128}
            required
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="auth-submit" disabled={busy}>
            {busy ? 'Mise à jour…' : 'Enregistrer le mot de passe'}
          </button>
        </form>
        <button className="text-button" onClick={() => void onLogout()}>
          Se déconnecter
        </button>
      </section>
    </div>
  );
}
function Workspace({
  view,
  gateway,
  onLock,
  onLogout,
}: {
  view: NativeSessionView & { profile: SessionProfile };
  gateway: AuthGateway;
  onLock(): Promise<unknown>;
  onLogout(): Promise<void>;
}) {
  const [page, setPage] = useState('overview'),
    [error, setError] = useState('');
  const profile = view.profile,
    online = view.state === 'online';
  const permission = (p: string) => profile.permissions.includes(p);
  const items = [
    { id: 'overview', label: 'Vue d’ensemble', icon: LayoutDashboard },
    { id: 'cash', label: 'Caisses', icon: Wallet, permission: 'ledger:read' },
    { id: 'receipts', label: 'Encaissements', icon: ReceiptText, permission: 'receipt:read' },
    { id: 'drafts', label: 'Brouillons dépenses', icon: FilePenLine, permission: 'draft:read_own' },
    { id: 'users', label: 'Utilisateurs', icon: Users, permission: 'users:manage' },
    { id: 'logs', label: 'Journal des connexions', icon: ScrollText, permission: 'auth:logs:read' },
    { id: 'security', label: 'Sécurité', icon: ShieldCheck },
  ].filter((item) => !item.permission || permission(item.permission));
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace">
          <Building2 size={21} />
          <span>
            {profile.company.name}
            <small>{profile.company.code}</small>
          </span>
        </div>
        <p className="nav-label">ESPACE DE TRAVAIL</p>
        <nav aria-label="Navigation principale">
          {items.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setPage(id)}
              className={`nav-button ${page === id ? 'active' : ''}`}
              aria-current={page === id ? 'page' : undefined}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile">
            <span className="avatar">{profile.user.displayName.slice(0, 1).toUpperCase()}</span>
            <span>
              {profile.user.displayName}
              <small>{profile.roles.map(roleName).join(', ')}</small>
            </span>
          </div>
          <div className="session-actions">
            <button
              onClick={() => {
                void onLock().catch((error) => setError(message(error)));
              }}
            >
              <LockKeyhole size={15} />
              Verrouiller
            </button>
            <button onClick={() => void onLogout()}>
              <LogOut size={15} />
              Déconnexion
            </button>
          </div>
        </div>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <span className="breadcrumb">
            {profile.company.name} <span>/</span>
            <strong>{items.find((i) => i.id === page)?.label}</strong>
          </span>
          <Network online={online} />
        </header>
        <main>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {!online && (
            <div className="offline-banner">
              <WifiOff size={20} />
              <div>
                <strong>
                  Accès hors connexion limité jusqu’à{' '}
                  {view.offlineUntil ? time(view.offlineUntil) : 'expiration'}
                </strong>
                <p>
                  Les informations ne sont pas actualisées. Une révocation récente peut ne pas
                  encore être connue ; les actions financières définitives restent bloquées.
                </p>
              </div>
            </div>
          )}
          {page === 'overview' ? (
            <Overview profile={profile} gateway={gateway} online={online} />
          ) : page === 'cash' ? (
            <CashPage profile={profile} gateway={gateway} online={online} />
          ) : page === 'receipts' ? (
            <ReceiptsPage profile={profile} gateway={gateway} online={online} />
          ) : page === 'drafts' ? (
            <Drafts profile={profile} gateway={gateway} online={online} />
          ) : page === 'users' ? (
            <UsersPage gateway={gateway} online={online} />
          ) : page === 'logs' ? (
            <Logs gateway={gateway} online={online} />
          ) : (
            <section className="panel security-details">
              <ShieldCheck size={30} />
              <h1>Votre session et vos droits</h1>
              <p>
                Connecté en tant que {profile.user.displayName}, pour {profile.company.name}.
              </p>
              <p>Rôles : {profile.roles.map(roleName).join(', ')}.</p>
              <p>
                Expiration de la session : {time(profile.expiresAt)}. Verrouillage automatique après
                5 minutes d’inactivité.
              </p>
              <p>
                Les permissions sont vérifiées par le serveur à chaque demande. Après une
                modification des accès, une nouvelle connexion peut être nécessaire.
              </p>
              <p>
                Vos données temporaires sont isolées dans cette session. La fermeture de
                l’application les efface. Le stockage sensible sur disque reste désactivé.
              </p>
              <p>
                Les opérations comptabilisées restent immuables. Aucun paiement, transfert,
                conversion ou clôture ne peut être confirmé hors connexion.
              </p>
            </section>
          )}
          <footer>
            <span>CaissePro · Une trésorerie maîtrisée.</span>
            <span>
              <ShieldCheck size={13} />
              Session personnelle protégée
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
function Overview({
  profile,
  gateway,
  online,
}: {
  profile: SessionProfile;
  gateway: AuthGateway;
  online: boolean;
}) {
  const [balances, setBalances] = useState<Balances | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setBalances(null);
    if (profile.permissions.includes('ledger:read'))
      void gateway
        .balances()
        .then((value) => {
          if (active) setBalances(value);
        })
        .catch((error) => {
          if (active) setError(message(error));
        });
    return () => {
      active = false;
    };
  }, [gateway, profile.validatedAt, online, profile.permissions]);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">VOTRE ESPACE FINANCIER</p>
          <h1>
            Bienvenue, {profile.user.displayName.split(' ')[0]}
            <span className="heading-dot">.</span>
          </h1>
          <p>Les informations accessibles correspondent à vos agences et caisses affectées.</p>
        </div>
        <span className="setup-tag">{profile.roles.map(roleName).join(' · ')}</span>
      </div>
      <section className="welcome-card">
        <div className="hero-content">
          <span className="hero-label">
            <span /> ACCÈS PERSONNEL AUTORISÉ
          </span>
          <h2>
            Une vision claire.
            <br />
            Des responsabilités définies.
          </h2>
          <p>
            Votre espace rassemble les informations de trésorerie
            <br />
            que votre rôle et vos affectations permettent de consulter.
          </p>
        </div>
        <div className="auth-dashboard-shield">
          <ShieldCheck size={85} />
        </div>
      </section>
      <div className="stat-grid">
        <article className="stat-card">
          <Building2 size={23} />
          <h3>{profile.agencies.length} agence(s) autorisée(s)</h3>
          <p>{profile.agencies.map((a) => a.name).join(', ') || 'Aucune affectation financière'}</p>
        </article>
        <article className="stat-card">
          <Wallet size={23} />
          <h3>{profile.cashRegisters.length} caisse(s) affectée(s)</h3>
          <p>Les devises CDF et USD restent séparées.</p>
        </article>
        <article className="stat-card">
          <LockKeyhole size={23} />
          <h3>{online ? 'Session en ligne' : 'Consultation locale'}</h3>
          <p>
            {online
              ? 'Permissions revalidées auprès du serveur.'
              : 'Informations datées, sans confirmation financière.'}
          </p>
        </article>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>Soldes de vos caisses</h2>
          <span className="subtle-pill">{balances?.stale ? 'Non actualisés' : 'Consultation'}</span>
        </div>
        {balances && (
          <p className="section-description">
            Données du {time(balances.data.synchronizedAt)}, consultées{' '}
            {since(balances.data.synchronizedAt)}.
            {balances.stale ? ' Ces soldes ne sont pas actualisés.' : ''}
          </p>
        )}
        {error && <p className="auth-notice">{error}</p>}
        {balances?.data.balances.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Caisse</th>
                  <th>Devise</th>
                  <th>Solde comptable</th>
                  <th>Réservé</th>
                  <th>Disponible</th>
                </tr>
              </thead>
              <tbody>
                {balances.data.balances.map((row) => (
                  <tr key={row.accountId}>
                    <td>{profile.cashRegisters.find((r) => r.id === row.cashRegisterId)?.name}</td>
                    <td>
                      <span className="currency-pill">{row.currency}</span>
                    </td>
                    <td>{money(row.balance)}</td>
                    <td>{money(row.reserved)}</td>
                    <td>{money(row.available)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-text">Aucun solde disponible dans votre périmètre.</p>
        )}
      </section>
      <p className="availability-note">
        <ShieldCheck size={16} />
        Les encaissements se confirment dans « Encaissements », uniquement après réception effective
        des fonds et validation du serveur.
      </p>
    </>
  );
}
function Drafts({
  profile,
  gateway,
  online,
}: {
  profile: SessionProfile;
  gateway: AuthGateway;
  online: boolean;
}) {
  const [rows, setRows] = useState<SessionDraft[]>([]),
    [open, setOpen] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [results, setResults] = useState<string[]>([]);
  const refresh = () =>
    gateway
      .drafts()
      .then((rows) => setRows(rows.filter((row) => row.draft.kind === 'expense-request')));
  useEffect(() => {
    let active = true;
    void gateway
      .drafts()
      .then((rows) => {
        if (active) setRows(rows.filter((row) => row.draft.kind === 'expense-request'));
      })
      .catch((error) => {
        if (active) setError(message(error));
      });
    return () => {
      active = false;
    };
  }, [gateway, profile.validatedAt]);
  const sync = async () => {
    setBusy(true);
    setError('');
    try {
      const results = await gateway.synchronize();
      setResults(
        results.map(
          (r) =>
            `${r.draftId.slice(0, 8)} : ${r.outcome === 'accepted-as-draft' ? 'reçu comme brouillon' : r.outcome === 'conflict' ? 'conflit à résoudre' : 'envoi refusé'}`,
        ),
      );
      await refresh();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PRÉPARATION SANS COMPTABILISATION</p>
          <h1>Brouillons de demandes de dépenses</h1>
          <p>Un brouillon ne confirme jamais un paiement et ne modifie aucun solde.</p>
        </div>
        <div className="action-buttons">
          <button
            className="secondary-button"
            onClick={() => void sync()}
            disabled={!online || busy}
          >
            <RefreshCw size={15} />
            Synchroniser
          </button>
          {profile.permissions.includes('draft:write_own') && (
            <button className="primary-button" onClick={() => setOpen(!open)}>
              <Plus size={16} />
              Préparer un brouillon
            </button>
          )}
        </div>
      </div>
      <p className="auth-notice">
        Conservation temporaire pendant cette session, au plus 15 minutes. Fermer l’application ou
        changer d’utilisateur efface les brouillons locaux.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {open && (
        <DraftForm
          profile={profile}
          onSave={async (input) => {
            await gateway.saveDraft(input);
            await refresh();
            setOpen(false);
          }}
        />
      )}
      <section className="panel">
        {rows.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Motif</th>
                  <th>Montant</th>
                  <th>Version</th>
                  <th>État</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.draft.id}>
                    <td>{row.draft.kind === 'receipt' ? 'Encaissement' : 'Demande de dépense'}</td>
                    <td>{row.draft.description}</td>
                    <td>
                      {money(row.draft.amount)} {row.draft.currency}
                    </td>
                    <td>{row.version}</td>
                    <td>
                      {row.state === 'synced'
                        ? 'Reçu comme brouillon'
                        : row.state === 'conflict'
                          ? 'Conflit'
                          : row.state === 'error'
                            ? 'Erreur'
                            : 'Local'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <FilePenLine size={34} />
            <h2>Aucun brouillon disponible</h2>
            <p>Seuls vos propres brouillons sont accessibles dans cette session.</p>
          </div>
        )}
      </section>
      {results.length > 0 && (
        <section className="panel sync-results">
          <h2>Résultats de synchronisation</h2>
          {results.map((result) => (
            <p key={result}>{result}</p>
          ))}
        </section>
      )}
    </>
  );
}
function DraftForm({
  profile,
  onSave,
}: {
  profile: SessionProfile;
  onSave(input: {
    draft: ReturnType<typeof createLocalDraft>;
    agencyId: string;
    cashRegisterId: string | null;
    expectedVersion: null;
  }): Promise<void>;
}) {
  const [kind, setKind] = useState<'receipt' | 'expense-request'>('expense-request'),
    [agency, setAgency] = useState(profile.agencies[0]?.id ?? ''),
    [cash, setCash] = useState(''),
    [currency, setCurrency] = useState<'CDF' | 'USD'>('USD'),
    [amount, setAmount] = useState(''),
    [description, setDescription] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave({
        draft: createLocalDraft({ kind, currency, amount: amount.replace(',', '.'), description }),
        agencyId: agency,
        cashRegisterId: cash || null,
        expectedVersion: null,
      });
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel editor-form" onSubmit={submit}>
      <h2>Nouveau brouillon</h2>
      <div className="form-grid">
        <label>
          Type
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="expense-request">Demande de dépense</option>
          </select>
        </label>
        <label>
          Agence
          <select
            value={agency}
            onChange={(e) => {
              setAgency(e.target.value);
              setCash('');
            }}
            required
          >
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
            value={cash}
            onChange={(e) => setCash(e.target.value)}
            required={kind === 'receipt'}
          >
            <option value="">{kind === 'receipt' ? 'Choisir une caisse' : 'Sans caisse'}</option>
            {profile.cashRegisters
              .filter((r) => r.agencyId === agency)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Devise
          <select value={currency} onChange={(e) => setCurrency(e.target.value as typeof currency)}>
            <option>USD</option>
            <option>CDF</option>
          </select>
        </label>
        <label>
          Montant exact
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0,00"
            pattern="(?:0|[1-9][0-9]{0,15})[.,][0-9]{2}"
            required
          />
        </label>
        <label>
          Motif
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            required
          />
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary-button" disabled={busy}>
        {busy ? 'Enregistrement…' : 'Conserver comme brouillon'}
      </button>
    </form>
  );
}
function UsersPage({ gateway, online }: { gateway: AuthGateway; online: boolean }) {
  const [users, setUsers] = useState<ManagedUser[]>([]),
    [catalog, setCatalog] = useState<AccessCatalog | null>(null),
    [editing, setEditing] = useState<ManagedUser | null | undefined>(undefined),
    [error, setError] = useState('');
  const load = async () => {
    const [users, catalog] = await Promise.all([gateway.users(), gateway.catalog()]);
    setUsers(users);
    setCatalog(catalog);
  };
  useEffect(() => {
    if (online) void load().catch((error) => setError(message(error)));
  }, [gateway, online]);
  if (!online)
    return (
      <section className="panel">
        <h1>Administration indisponible hors connexion</h1>
        <p>La gestion des utilisateurs et des droits exige une validation serveur.</p>
      </section>
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">ADMINISTRATION DES ACCÈS</p>
          <h1>Utilisateurs & affectations</h1>
          <p>Les changements de droits révoquent les sessions concernées.</p>
        </div>
        <button className="primary-button" onClick={() => setEditing(null)}>
          <Plus size={16} />
          Nouvel utilisateur
        </button>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {editing !== undefined && catalog && (
        <UserEditor
          key={editing?.id ?? 'new'}
          user={editing}
          catalog={catalog}
          onCancel={() => setEditing(undefined)}
          onSave={async (values) => {
            if (editing) await gateway.assignUser(editing.id, values.access, editing.version);
            else await gateway.createUser(values);
            setEditing(undefined);
            await load();
          }}
        />
      )}
      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Utilisateur</th>
              <th>Rôles</th>
              <th>Affectations</th>
              <th>État</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <strong>{user.displayName}</strong>
                  <small>{user.email}</small>
                </td>
                <td>{user.roles.map(roleName).join(', ')}</td>
                <td>
                  {user.agencyIds.length} agence(s) · {user.cashRegisterIds.length} caisse(s)
                </td>
                <td>{user.active ? 'Actif' : 'Désactivé'}</td>
                <td>
                  <button className="text-button" onClick={() => setEditing(user)}>
                    Modifier les accès
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
function UserEditor({
  user,
  catalog,
  onCancel,
  onSave,
}: {
  user: ManagedUser | null;
  catalog: AccessCatalog;
  onCancel(): void;
  onSave(values: {
    email: string;
    displayName: string;
    initialPassword: string;
    access: AccessAssignment;
  }): Promise<void>;
}) {
  const [email, setEmail] = useState(user?.email ?? ''),
    [name, setName] = useState(user?.displayName ?? ''),
    [password, setPassword] = useState(''),
    [roles, setRoles] = useState<RoleCode[]>(user?.roles ?? ['CASHIER']),
    [agencies, setAgencies] = useState<string[]>(user?.agencyIds ?? []),
    [cash, setCash] = useState<string[]>(user?.cashRegisterIds ?? []),
    [active, setActive] = useState(user?.active ?? true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const toggle = <T,>(values: T[], value: T) =>
    values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await onSave({
        email,
        displayName: name,
        initialPassword: password,
        access: { roles, agencyIds: agencies, cashRegisterIds: cash, active },
      });
    } catch (error) {
      setError(message(error));
    } finally {
      setPassword('');
      setBusy(false);
    }
  };
  return (
    <form className="panel editor-form" onSubmit={submit}>
      <h2>{user ? 'Modifier les accès' : 'Créer un utilisateur'}</h2>
      {!user && (
        <div className="form-grid">
          <label>
            Nom complet
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={160}
              required
            />
          </label>
          <label>
            E-mail
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
              required
            />
          </label>
          <label>
            Mot de passe initial
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={12}
              maxLength={128}
              required
            />
            <small>Renouvellement obligatoire à la première connexion.</small>
          </label>
        </div>
      )}
      <div className="access-columns">
        <fieldset>
          <legend>Rôles et permissions</legend>
          {Object.keys(catalog.roles).map((code) => (
            <label key={code} className="checkbox-label">
              <input
                type="checkbox"
                checked={roles.includes(code as RoleCode)}
                onChange={() => setRoles(toggle(roles, code as RoleCode))}
              />
              <span>
                {roleName(code)}
                <small>{catalog.roles[code as RoleCode].length} permissions</small>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Agences autorisées</legend>
          {catalog.agencies.map((a) => (
            <label key={a.id} className="checkbox-label">
              <input
                type="checkbox"
                checked={agencies.includes(a.id)}
                onChange={() => {
                  const next = toggle(agencies, a.id);
                  setAgencies(next);
                  setCash(
                    cash.filter((id) =>
                      catalog.cashRegisters.some((r) => r.id === id && next.includes(r.agencyId)),
                    ),
                  );
                }}
              />
              {a.name}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Caisses affectées</legend>
          {catalog.cashRegisters
            .filter((r) => agencies.includes(r.agencyId))
            .map((r) => (
              <label key={r.id} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={cash.includes(r.id)}
                  onChange={() => setCash(toggle(cash, r.id))}
                />
                {r.name}
              </label>
            ))}
          {agencies.length === 0 && <p>Choisissez d’abord une agence.</p>}
        </fieldset>
      </div>
      <label className="checkbox-label">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Compte actif dans cette entreprise
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="action-buttons">
        <button className="primary-button" disabled={busy || roles.length === 0}>
          {busy ? 'Enregistrement…' : 'Enregistrer les accès'}
        </button>
        <button className="secondary-button" type="button" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}
function Logs({ gateway, online }: { gateway: AuthGateway; online: boolean }) {
  const [rows, setRows] = useState<AuthLog[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    if (online)
      void gateway
        .logs()
        .then(setRows)
        .catch((error) => setError(message(error)));
  }, [gateway, online]);
  const labels: Record<string, string> = {
    LOGIN_SUCCESS: 'Connexion réussie',
    LOGIN_FAILED: 'Connexion refusée',
    LOGIN_THROTTLED: 'Tentatives limitées',
    LOGOUT: 'Déconnexion',
    LOCK: 'Session verrouillée',
    UNLOCK_SUCCESS: 'Déverrouillage réussi',
    UNLOCK_FAILED: 'Déverrouillage refusé',
    SESSION_EXPIRED: 'Session expirée',
    SESSION_REVOKED: 'Session révoquée',
    USER_CREATED: 'Utilisateur créé',
    ACCESS_CHANGED: 'Autorisations modifiées',
    PASSWORD_CHANGED: 'Mot de passe renouvelé',
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">TRAÇABILITÉ DES ACCÈS</p>
          <h1>Journal des connexions</h1>
          <p>Les 100 événements de sécurité les plus récents de votre entreprise.</p>
        </div>
      </div>
      {!online ? (
        <p className="auth-notice">La consultation du journal exige une connexion au serveur.</p>
      ) : (
        <section className="panel table-wrap">
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Événement</th>
                <th>Utilisateur concerné</th>
                <th>Effectué par</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.createdAt).toLocaleString('fr-FR')}</td>
                  <td>{labels[row.code] ?? row.code}</td>
                  <td>{row.subjectName ?? row.actorName ?? '—'}</td>
                  <td>{row.actorName ?? 'Système'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="empty-text">Aucun événement disponible.</p>}
        </section>
      )}
    </>
  );
}
