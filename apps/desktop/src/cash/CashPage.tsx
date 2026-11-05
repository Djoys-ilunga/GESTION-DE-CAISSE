import { useEffect, useState, type FormEvent } from 'react';
import { Building2, Plus, RefreshCw, Wallet, LockKeyhole } from 'lucide-react';
import type { CashConfiguration, CashSnapshot, SessionProfile } from '@caissepro/shared';
import { message, type AuthGateway } from '../auth/gateway';
import './cash.css';
export const formatMoney = (value: string) => {
  const [whole, cents] = value.split('.');
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f')},${cents ?? '00'}`;
};
export const formatDate = (value: string) =>
  new Date(value).toLocaleString('fr-FR', { timeZone: 'Africa/Kinshasa' });
export function CashPage({
  gateway,
  profile,
  online,
}: {
  gateway: AuthGateway;
  profile: SessionProfile;
  online: boolean;
}) {
  const [snapshot, setSnapshot] = useState<CashSnapshot | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState('funds');
  const configure = profile.permissions.includes('cash:configure');
  useEffect(() => {
    let active = true;
    const refresh = () =>
      gateway
        .cashCatalog()
        .then((v) => {
          if (active) {
            setSnapshot(v);
            setError('');
          }
        })
        .catch((e) => {
          if (active) setError(message(e));
        });
    void refresh();
    const timer = online ? setInterval(() => void refresh(), 5000) : undefined;
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [gateway, online, profile.authorizationVersion]);
  async function open(id: string) {
    setBusy(true);
    setError('');
    try {
      await gateway.openCashSession(id);
      setSnapshot(await gateway.cashCatalog());
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">TRÉSORERIE PAR AGENCE</p>
          <h1>Vos caisses</h1>
          <p>Des fonds distincts en CDF et en USD, issus des seules écritures comptabilisées.</p>
        </div>
        <Wallet size={28} />
      </div>
      {configure && (
        <div className="cash-tabs">
          <button className={tab === 'funds' ? 'selected' : ''} onClick={() => setTab('funds')}>
            Soldes et sessions
          </button>
          <button
            className={tab === 'configuration' ? 'selected' : ''}
            onClick={() => setTab('configuration')}
          >
            Configuration des caisses
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {tab === 'configuration' ? (
        <CashConfigurationPanel gateway={gateway} online={online} />
      ) : (
        <>
          <div className={`cash-freshness ${!online || snapshot?.stale ? 'stale' : ''}`}>
            <RefreshCw size={16} />
            {snapshot ? (
              <span>
                {!online || snapshot.stale
                  ? 'Derniers soldes connus, non actualisés'
                  : 'Soldes serveur, actualisés toutes les 5 secondes'}{' '}
                — {formatDate(snapshot.data.synchronizedAt)} (Kinshasa).
              </span>
            ) : (
              <span>Aucun solde autorisé disponible.</span>
            )}
          </div>
          <div className="cash-grid">
            {snapshot?.data.items.map((cash) => (
              <article className="panel cash-card" key={cash.id}>
                <div className="cash-card-heading">
                  <span className="cash-icon">
                    <Wallet size={22} />
                  </span>
                  <div>
                    <h2>{cash.name}</h2>
                    <p>
                      <Building2 size={13} /> {cash.agency.name} · {cash.code}
                    </p>
                  </div>
                  <span className={`receipt-status ${cash.active ? 'posted' : 'pending'}`}>
                    {cash.active ? 'Active' : 'Désactivée'}
                  </span>
                </div>
                <div className="currency-funds">
                  {(['CDF', 'USD'] as const).map((currency) => {
                    const fund = cash.funds.find((f) => f.currency === currency);
                    return (
                      <div key={currency}>
                        <span className="currency-pill">{currency}</span>
                        <strong>{fund ? formatMoney(fund.balance) : 'Indisponible'}</strong>
                        {fund && (
                          <small>
                            Disponible : {formatMoney(fund.available)} · Réservé :{' '}
                            {formatMoney(fund.reserved)}
                          </small>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="cash-session">
                  <LockKeyhole size={15} />
                  {cash.session ? (
                    <span>Session ouverte le {formatDate(cash.session.openedAt)}.</span>
                  ) : (
                    <span>Aucune session ouverte.</span>
                  )}
                  {!cash.session && profile.permissions.includes('session:manage') && (
                    <button
                      className="secondary-button"
                      disabled={!online || !cash.active || busy}
                      onClick={() => void open(cash.id)}
                    >
                      Ouvrir la session de caisse
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
          {snapshot?.data.items.length === 0 && (
            <section className="panel empty-state">
              <Wallet size={30} />
              <h2>Aucune caisse affectée</h2>
              <p>Demandez à votre administrateur une affectation à une agence et une caisse.</p>
            </section>
          )}
        </>
      )}
    </>
  );
}
function CashConfigurationPanel({ gateway, online }: { gateway: AuthGateway; online: boolean }) {
  const [catalog, setCatalog] = useState<CashConfiguration | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [agencyId, setAgencyId] = useState(() => crypto.randomUUID()),
    [agencyCode, setAgencyCode] = useState(''),
    [agencyName, setAgencyName] = useState('');
  const [id, setId] = useState(() => crypto.randomUUID()),
    [agency, setAgency] = useState(''),
    [code, setCode] = useState(''),
    [name, setName] = useState(''),
    [users, setUsers] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null),
    [editName, setEditName] = useState(''),
    [editActive, setEditActive] = useState(true);
  useEffect(() => {
    let active = true;
    if (online)
      void gateway
        .cashConfiguration()
        .then((value) => {
          if (active) setCatalog(value);
        })
        .catch((e) => {
          if (active) setError(message(e));
        });
    return () => {
      active = false;
    };
  }, [gateway, online]);
  async function perform(action: () => Promise<unknown>, success: () => void) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      success();
      setCatalog(await gateway.cashConfiguration());
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function createAgency(e: FormEvent) {
    e.preventDefault();
    void perform(
      () => gateway.createAgency({ id: agencyId, code: agencyCode, name: agencyName }),
      () => {
        setAgencyCode('');
        setAgencyName('');
        setAgencyId(crypto.randomUUID());
        setNotice('Agence créée.');
      },
    );
  }
  function create(e: FormEvent) {
    e.preventDefault();
    void perform(
      () =>
        gateway.createCash({
          id,
          agencyId: agency || catalog?.agencies[0]?.id || '',
          code,
          name,
          authorizedUserIds: users,
        }),
      () => {
        setCode('');
        setName('');
        setUsers([]);
        setId(crypto.randomUUID());
        setNotice(
          'Caisse créée avec des fonds CDF/USD distincts. Les utilisateurs nouvellement affectés doivent se reconnecter.',
        );
      },
    );
  }
  if (!online)
    return (
      <p className="auth-notice">
        La configuration des caisses et des affectations exige une connexion au serveur.
      </p>
    );
  return (
    <div className="configuration-grid">
      {error && (
        <p role="alert" className="form-error full-width">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="cash-success full-width">
          {notice}
        </p>
      )}
      <form className="panel editor-form" onSubmit={createAgency}>
        <h2>Nouvelle agence</h2>
        <label>
          Code de l’agence
          <input
            required
            maxLength={40}
            value={agencyCode}
            onChange={(e) => setAgencyCode(e.target.value.toUpperCase())}
            pattern="[A-Z0-9][A-Z0-9_-]*"
          />
        </label>
        <label>
          Nom de l’agence
          <input
            required
            minLength={2}
            maxLength={160}
            value={agencyName}
            onChange={(e) => setAgencyName(e.target.value)}
          />
        </label>
        <button className="secondary-button" disabled={busy}>
          <Plus size={15} />
          Créer l’agence
        </button>
      </form>
      <form className="panel editor-form" onSubmit={create}>
        <h2>Nouvelle caisse</h2>
        <div className="form-grid">
          <label>
            Agence de rattachement
            <select
              required
              value={agency || catalog?.agencies[0]?.id || ''}
              onChange={(e) => setAgency(e.target.value)}
            >
              {catalog?.agencies.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Code de caisse
            <input
              required
              maxLength={40}
              pattern="[A-Z0-9][A-Z0-9_-]*"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </label>
          <label className="full-width">
            Nom de la caisse
            <input
              required
              minLength={2}
              maxLength={160}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        </div>
        <fieldset className="cash-users">
          <legend>Utilisateurs autorisés initialement</legend>
          {catalog?.users.map((user) => (
            <label key={user.id} className="checkbox-label">
              <input
                type="checkbox"
                checked={users.includes(user.id)}
                onChange={(e) =>
                  setUsers((current) =>
                    e.target.checked
                      ? [...current, user.id]
                      : current.filter((id) => id !== user.id),
                  )
                }
              />
              <span>
                {user.displayName}
                <small>{user.email}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="section-description">
          Les rôles existants restent applicables. Les affectations se modifient ensuite dans «
          Utilisateurs ». Aucun solde initial n’est ajouté.
        </p>
        <button className="primary-button" disabled={busy || !catalog?.agencies.length}>
          <Plus size={15} />
          Créer la caisse
        </button>
      </form>
      <section className="panel table-wrap full-width">
        <h2>Caisses de l’entreprise</h2>
        <p className="section-description">
          Le rattachement et le code restent fixes ; les reçus conservent les noms valides lors de
          l’encaissement.
        </p>
        <table>
          <thead>
            <tr>
              <th>Caisse</th>
              <th>Agence</th>
              <th>État</th>
              <th>Configuration</th>
            </tr>
          </thead>
          <tbody>
            {catalog?.registers.map((cash) => (
              <tr key={cash.id}>
                <td>
                  <strong>{cash.name}</strong>
                  <small className="block">{cash.code}</small>
                </td>
                <td>
                  {catalog.agencies.find((a) => a.id === cash.agencyId)?.name ??
                    'Agence non active'}
                </td>
                <td>{cash.active ? 'Active' : 'Désactivée'}</td>
                <td>
                  <button
                    className="text-button"
                    onClick={() => {
                      setEditing(cash.id);
                      setEditName(cash.name);
                      setEditActive(cash.active);
                    }}
                  >
                    Modifier
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {editing && (
        <form
          className="panel editor-form full-width"
          onSubmit={(e) => {
            e.preventDefault();
            const cash = catalog?.registers.find((c) => c.id === editing);
            if (cash)
              void perform(
                () =>
                  gateway.updateCash(cash.id, {
                    expectedVersion: cash.version,
                    name: editName,
                    active: editActive,
                  }),
                () => {
                  setEditing(null);
                  setNotice(
                    'Configuration mise à jour. Les soldes et reçus existants sont conservés.',
                  );
                },
              );
          }}
        >
          <h2>Modifier la caisse</h2>
          <label>
            Nom
            <input
              required
              minLength={2}
              maxLength={160}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={editActive}
              onChange={(e) => setEditActive(e.target.checked)}
            />
            Caisse active pour de nouveaux encaissements
          </label>
          <div className="action-buttons">
            <button className="primary-button" disabled={busy}>
              Enregistrer la configuration
            </button>
            <button className="secondary-button" type="button" onClick={() => setEditing(null)}>
              Annuler
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
