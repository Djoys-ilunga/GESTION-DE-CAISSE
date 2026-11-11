import { useMoney, CurrencyOptions } from '../money/MoneyContext';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Building2, RefreshCw, Plus, Settings2 } from 'lucide-react';
import {
  companySettingsInputSchema,
  categoryInputSchema,
  referenceRateInputSchema,
  type CompanySettings,
  type CompanySettingsInput,
  type FinancialCategory,
  type ManagementSettings,
} from '@caissepro/shared';
import { message, type AuthGateway } from '../auth/gateway';
import { ExpensePolicies } from '../expenses/ExpensePolicies';
import { CashPage } from '../cash/CashPage';
import type { SessionProfile } from '@caissepro/shared';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { formatDate } from '../cash/CashPage';
import './management.css';
type Request = { title: string; description: string; run(): Promise<unknown> };
type Ask = (request: Request) => void;
function payload(c: CompanySettings, fields: Partial<CompanySettingsInput> = {}) {
  return companySettingsInputSchema.parse({
    name: c.name,
    address: c.address,
    phone: c.phone,
    email: c.email,
    taxId: c.taxId,
    sessionMinutes: c.sessionMinutes,
    idleMinutes: c.idleMinutes,
    offlineMinutes: c.offlineMinutes,
    expectedVersion: c.version,
    confirmed: true,
    ...fields,
  });
}
export function SettingsPage({
  gateway,
  profile,
  online,
}: {
  gateway: AuthGateway;
  profile: SessionProfile;
  online: boolean;
}) {
  const [data, setData] = useState<ManagementSettings | null>(null),
    [tab, setTab] = useState('company'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState<Request | null>(null),
    [busy, setBusy] = useState(false);
  const alive = useRef(false),
    seq = useRef(0);
  const load = async () => {
    const n = ++seq.current;
    setData(null);
    setError('');
    try {
      const v = await gateway.settings();
      if (alive.current && n === seq.current) setData(v);
    } catch (e) {
      if (alive.current && n === seq.current) setError(message(e));
    }
  };
  useEffect(() => {
    alive.current = true;
    if (online) void load();
    else {
      seq.current++;
      setData(null);
      setPending(null);
      setBusy(false);
    }
    return () => {
      alive.current = false;
      seq.current++;
    };
  }, [gateway, online, profile.authorizationVersion]);
  const ask: Ask = (r) => {
    setError('');
    setNotice('');
    setPending(r);
  };
  async function confirm() {
    if (!pending || busy || !online) return;
    const epoch = seq.current;
    setBusy(true);
    setError('');
    try {
      const result = await pending.run();
      if (!alive.current || epoch !== seq.current) return;
      setPending(null);
      setBusy(false);
      setNotice('Modification validée par le serveur.');
      if (
        result &&
        typeof result === 'object' &&
        'sessionsRevoked' in result &&
        result.sessionsRevoked
      ) {
        setData(null);
        setNotice('Durées enregistrées. Les sessions ont été révoquées ; reconnectez-vous.');
      } else await load();
    } catch (e) {
      if (alive.current && epoch === seq.current) {
        setPending(null);
        setError(message(e));
      }
    } finally {
      if (alive.current && epoch === seq.current) setBusy(false);
    }
  }
  if (!online)
    return (
      <section className="panel empty-state">
        <Settings2 size={32} />
        <h1>Administration indisponible hors connexion</h1>
        <p>
          Les paramètres, affectations et règles de sécurité nécessitent une validation du serveur.
        </p>
      </section>
    );
  return (
    <div className="settings-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">ADMINISTRATION</p>
          <h1>Paramètres de l’entreprise</h1>
          <p>Des réglages traçables, appliqués par le serveur.</p>
        </div>
        <button className="secondary-button" disabled={busy} onClick={() => void load()}>
          <RefreshCw size={16} />
          Actualiser les paramètres
        </button>
      </header>
      <nav className="section-tabs" aria-label="Rubriques des paramètres">
        {Object.entries({
          company: 'Entreprise',
          agencies: 'Agences',
          cash: 'Caisses',
          categories: 'Catégories',
          rates: 'Taux de change',
          sessions: 'Sessions',
          policies: 'Seuils d’approbation',
        }).map(([id, label]) => (
          <button
            key={id}
            aria-current={tab === id ? 'page' : undefined}
            className={tab === id ? 'selected' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {notice && (
        <p className="auth-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && !notice && (
        <p role="status">Chargement des paramètres depuis le serveur…</p>
      )}
      {data && (
        <>
          <p className="data-stamp">
            Données serveur · {formatDate(data.generatedAt)} · {data.company.code}
          </p>
          {tab === 'company' && (
            <CompanyEditor
              key={data.company.version}
              company={data.company}
              gateway={gateway}
              ask={ask}
            />
          )}
          {tab === 'sessions' && (
            <SessionEditor
              key={data.company.version}
              company={data.company}
              gateway={gateway}
              ask={ask}
            />
          )}
          {tab === 'agencies' && (
            <Agencies key={data.generatedAt} data={data} gateway={gateway} ask={ask} />
          )}
          {tab === 'categories' && (
            <Categories key={data.generatedAt} data={data} gateway={gateway} ask={ask} />
          )}
          {tab === 'rates' && (
            <Rates key={data.generatedAt} data={data} gateway={gateway} ask={ask} />
          )}
          {tab === 'policies' && <ExpensePolicies gateway={gateway} online={online} />}
          {tab === 'cash' && <CashPage profile={profile} gateway={gateway} online={online} />}
        </>
      )}
      {pending && (
        <ConfirmDialog
          title={pending.title}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirm()}
        >
          <p>{pending.description}</p>
          <p>Cette action sera enregistrée dans le journal d’audit.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
function CompanyEditor({
  company: c,
  gateway,
  ask,
}: {
  company: CompanySettings;
  gateway: AuthGateway;
  ask: Ask;
}) {
  const [fields, setFields] = useState({
    name: c.name,
    address: c.address,
    phone: c.phone,
    email: c.email,
    taxId: c.taxId,
  });
  const [error, setError] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const parsed = companySettingsInputSchema.safeParse(payloadValues(c, fields));
    if (!parsed.success) {
      setError('Vérifiez le nom et les coordonnées de l’entreprise.');
      return;
    }
    const input = parsed.data;
    ask({
      title: 'Enregistrer les informations de l’entreprise',
      description: `Identité : ${fields.name}. Les reçus, bons et PV déjà établis conservent leurs informations figées.`,
      run: () => gateway.configureCompany(input),
    });
  };
  return (
    <form className="panel editor-form" onSubmit={submit}>
      <div className="panel-heading">
        <h2>
          <Building2 size={20} />
          Identité de l’entreprise
        </h2>
        <span className="subtle-pill">Code immuable : {c.code}</span>
      </div>
      <div className="form-grid">
        {(
          Object.entries({
            name: 'Raison sociale',
            address: 'Adresse',
            phone: 'Téléphone',
            email: 'Courriel de contact',
            taxId: 'Identification fiscale',
          }) as [keyof typeof fields, string][]
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              required={key === 'name'}
              type={key === 'email' ? 'email' : 'text'}
              maxLength={
                key === 'address'
                  ? 300
                  : key === 'name'
                    ? 160
                    : key === 'email'
                      ? 254
                      : key === 'phone'
                        ? 60
                        : 100
              }
              value={fields[key]}
              onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary-button">Enregistrer l’entreprise</button>
    </form>
  );
}
function SessionEditor({
  company: c,
  gateway,
  ask,
}: {
  company: CompanySettings;
  gateway: AuthGateway;
  ask: Ask;
}) {
  const [fields, setFields] = useState({
      sessionMinutes: c.sessionMinutes,
      idleMinutes: c.idleMinutes,
      offlineMinutes: c.offlineMinutes,
    }),
    [error, setError] = useState('');
  return (
    <form
      className="panel editor-form"
      onSubmit={(e) => {
        e.preventDefault();
        setError('');
        const input = companySettingsInputSchema.safeParse(payloadValues(c, fields));
        if (!input.success) {
          setError('Vérifiez les durées : accès hors connexion ≤ inactivité ≤ durée de session.');
          return;
        }
        ask({
          title: 'Modifier la politique des sessions',
          description:
            'Toute modification des durées révoque toutes les sessions de cette entreprise, y compris la vôtre. Une nouvelle connexion sera nécessaire.',
          run: () => gateway.configureCompany(input.data),
        });
      }}
    >
      <h2>Durées de sécurité</h2>
      <p>
        Le verrouillage local intervient au plus tard après 5 minutes sans activité. Le serveur peut
        exiger une expiration plus courte.
      </p>
      <div className="form-grid">
        {(
          [
            {
              key: 'sessionMinutes',
              label: 'Durée maximale de session (minutes)',
              min: 15,
              max: 480,
            },
            {
              key: 'idleMinutes',
              label: 'Expiration serveur après inactivité (minutes)',
              min: 1,
              max: 15,
            },
            {
              key: 'offlineMinutes',
              label: 'Accès hors connexion maximal (minutes)',
              min: 0,
              max: 15,
            },
          ] as const
        ).map((f) => (
          <label key={f.key}>
            {f.label}
            <input
              type="number"
              required
              min={f.min}
              max={f.max}
              step={1}
              value={fields[f.key]}
              onChange={(e) => setFields({ ...fields, [f.key]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
      <p>
        0 minute hors connexion désactive cet accès. Les rôles et permissions restent obligatoires.
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <button className="primary-button">Enregistrer les durées</button>
    </form>
  );
}
function payloadValues(c: CompanySettings, fields: Partial<CompanySettingsInput>) {
  return { ...payload(c), ...fields };
}
function Agencies({
  data,
  gateway,
  ask,
}: {
  data: ManagementSettings;
  gateway: AuthGateway;
  ask: Ask;
}) {
  const [editing, setEditing] = useState<ManagementSettings['agencies'][number] | null>(null),
    [id, setId] = useState<string>(() => crypto.randomUUID()),
    [code, setCode] = useState(''),
    [name, setName] = useState(''),
    [active, setActive] = useState(true),
    [search, setSearch] = useState('');
  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <h2>Agences</h2>
          <button
            className="text-button"
            onClick={() => {
              setEditing(null);
              setId(crypto.randomUUID());
              setCode('');
              setName('');
              setActive(true);
            }}
          >
            <Plus size={16} />
            Nouvelle agence
          </button>
        </div>
        <label className="filter-field">
          Rechercher une agence
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Agence</th>
                <th>État</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.agencies
                .filter((a) => (a.name + ' ' + a.code).toLowerCase().includes(search.toLowerCase()))
                .map((a) => (
                  <tr key={a.id}>
                    <td>{a.code}</td>
                    <td>{a.name}</td>
                    <td>{a.active ? 'Active' : 'Désactivée'}</td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => {
                          setEditing(a);
                          setName(a.name);
                          setCode(a.code);
                          setActive(a.active);
                        }}
                      >
                        Modifier {a.code}
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
      <form
        className="panel editor-form"
        onSubmit={(e) => {
          e.preventDefault();
          ask({
            title: editing ? 'Modifier l’agence' : 'Créer une agence',
            description: `${code} — ${name}. Une agence avec des caisses actives ne peut pas être désactivée.`,
            run: () =>
              editing
                ? gateway.configureAgency(editing.id, {
                    expectedVersion: editing.version,
                    name,
                    active,
                    confirmed: true,
                  })
                : gateway.createAgency({ id, code: code.trim().toUpperCase(), name }),
          });
        }}
      >
        <h2>{editing ? 'Modifier l’agence' : 'Nouvelle agence'}</h2>
        <div className="form-grid">
          <label>
            Code de l’agence
            <input
              required
              maxLength={40}
              pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
              value={code}
              disabled={Boolean(editing)}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <label>
            Nom de l’agence
            <input
              required
              minLength={2}
              maxLength={160}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        </div>
        {editing && (
          <label className="checkbox-label">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Agence active
          </label>
        )}
        <button className="primary-button">
          {editing ? 'Enregistrer l’agence' : 'Créer l’agence'}
        </button>
      </form>
    </>
  );
}
function Categories({
  data,
  gateway,
  ask,
}: {
  data: ManagementSettings;
  gateway: AuthGateway;
  ask: Ask;
}) {
  const [editing, setEditing] = useState<FinancialCategory | null>(null),
    [id, setId] = useState<string>(() => crypto.randomUUID()),
    [code, setCode] = useState(''),
    [name, setName] = useState(''),
    [kind, setKind] = useState<'RECEIPT' | 'EXPENSE'>('RECEIPT'),
    [active, setActive] = useState(true),
    [search, setSearch] = useState('');
  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <h2>Catégories financières</h2>
          <button
            className="text-button"
            onClick={() => {
              setEditing(null);
              setId(crypto.randomUUID());
              setCode('');
              setName('');
              setActive(true);
            }}
          >
            Nouvelle catégorie
          </button>
        </div>
        <p>
          Les libellés déjà enregistrés sur les opérations restent inchangés. Les catégories actives
          sont proposées dans les formulaires en ligne.
        </p>
        <label className="filter-field">
          Rechercher une catégorie
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Libellé</th>
                <th>Usage</th>
                <th>État</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.categories
                .filter((c) => (c.name + ' ' + c.code).toLowerCase().includes(search.toLowerCase()))
                .map((c) => (
                  <tr key={c.id}>
                    <td>{c.code}</td>
                    <td>{c.name}</td>
                    <td>{c.kind === 'RECEIPT' ? 'Encaissement' : 'Dépense'}</td>
                    <td>{c.active ? 'Active' : 'Désactivée'}</td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => {
                          setEditing(c);
                          setId(c.id);
                          setCode(c.code);
                          setName(c.name);
                          setKind(c.kind);
                          setActive(c.active);
                        }}
                      >
                        Modifier {c.code}
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!data.categories.length && <p>Aucune catégorie configurée.</p>}
      </section>
      <form
        className="panel editor-form"
        onSubmit={(e) => {
          e.preventDefault();
          const b = categoryInputSchema.safeParse({
            id,
            expectedVersion: editing?.version ?? null,
            code,
            name,
            kind,
            active,
            confirmed: true,
          });
          if (!b.success) return;
          ask({
            title: 'Enregistrer la catégorie',
            description: `${name} — ${active ? 'active' : 'désactivée'}. Les documents existants restent inchangés.`,
            run: () => gateway.configureCategory(b.data),
          });
        }}
      >
        <h2>{editing ? 'Modifier la catégorie' : 'Nouvelle catégorie'}</h2>
        <div className="form-grid">
          <label>
            Code de la catégorie
            <input
              required
              maxLength={40}
              pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
              disabled={Boolean(editing)}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <label>
            Libellé
            <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Type de catégorie
            <select
              disabled={Boolean(editing)}
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="RECEIPT">Encaissement</option>
              <option value="EXPENSE">Dépense</option>
            </select>
          </label>
        </div>
        <label className="checkbox-label">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Catégorie active
        </label>
        <button className="primary-button">Enregistrer la catégorie</button>
      </form>
    </>
  );
}
function Rates({
  data,
  gateway,
  ask,
}: {
  data: ManagementSettings;
  gateway: AuthGateway;
  ask: Ask;
}) {
  const money = useMoney();
  const [id] = useState<string>(() => crypto.randomUUID()),
    [from, setFrom] = useState<string>(() => money.preferred('USD')),
    [to, setTo] = useState<string>(
      () => money.active.find((c) => c !== money.preferred('USD')) ?? '',
    ),
    [rate, setRate] = useState(''),
    [source, setSource] = useState(''),
    [date, setDate] = useState(new Date().toISOString().slice(0, 16)),
    [error, setError] = useState('');

  return (
    <>
      <form
        className="panel editor-form"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          const parsed = referenceRateInputSchema.safeParse({
            id,
            fromCurrency: from,
            toCurrency: to,
            rate: rate.trim().replace(',', '.'),
            source,
            validFrom: date ? new Date(date + 'Z').toISOString() : '',
            confirmed: true,
          });
          if (!parsed.success) {
            setError('Indiquez un taux strictement positif, une source et une date valides.');
            return;
          }
          ask({
            title: 'Publier le taux de référence',
            description: `1 ${from} = ${parsed.data.rate} ${to}. Ce taux sera conservé sans modification ; aucune conversion ne sera exécutée.`,
            run: () => gateway.publishRate(parsed.data),
          });
        }}
      >
        <h2>Publier un taux de change</h2>
        <p>
          Convention : montant de destination = montant d’origine × taux ; arrondi final à la
          précision de la devise de destination, au plus proche, demi supérieur.
        </p>
        <div className="form-grid">
          <label>
            Devise d’origine
            <select
              value={from}
              onChange={(e) => {
                setFrom(e.target.value as typeof from);
                setRate('');
              }}
            >
              <CurrencyOptions include={from} />
            </select>
          </label>
          <label>
            Devise de destination
            <select
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setRate('');
              }}
            >
              <CurrencyOptions include={to} />
            </select>
          </label>
          <label>
            Taux pour 1 {from} en {to}
            <input
              required
              inputMode="decimal"
              maxLength={25}
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </label>
          <label>
            Source du taux
            <input
              required
              minLength={3}
              maxLength={100}
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
          <label>
            Applicable à partir du (UTC)
            <input
              type="datetime-local"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary-button">Publier le taux</button>
      </form>
      <section className="panel">
        <h2>50 derniers taux publiés</h2>
        <p>
          Les taux futurs deviennent proposés à leur date d’application. Chaque transfert exige
          encore sa validation.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Origine</th>
                <th>Destination</th>
                <th>Taux exact</th>
                <th>Source</th>
                <th>Applicable le</th>
              </tr>
            </thead>
            <tbody>
              {data.rates.map((r) => (
                <tr key={r.id}>
                  <td>{r.fromCurrency}</td>
                  <td>{r.toCurrency}</td>
                  <td>{r.rate}</td>
                  <td>{r.source}</td>
                  <td>{formatDate(r.validFrom)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.rates.length && <p>Aucun taux publié.</p>}
      </section>
    </>
  );
}
