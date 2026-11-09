import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  expensePolicyInputSchema,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  type ExpensePolicy,
  type ExpensePolicyInput,
  type RoleCode,
} from '@caissepro/shared';
import { message, type AuthGateway } from '../auth/gateway';
const actions = {
  REQUEST: { label: 'Demande', permission: 'expense:request' },
  APPROVE: { label: 'Approbation', permission: 'expense:approve' },
  PAY: { label: 'Paiement', permission: 'expense:pay' },
} as const;
const cells = (Object.keys(ROLE_LABELS) as RoleCode[]).flatMap((role) =>
  (Object.keys(actions) as (keyof typeof actions)[])
    .filter((a) => ROLE_PERMISSIONS[role].includes(actions[a].permission))
    .map((action) => ({ role, action })),
);
export function ExpensePolicies({ gateway, online }: { gateway: AuthGateway; online: boolean }) {
  const [policies, setPolicies] = useState<ExpensePolicy[]>([]),
    [currency, setCurrency] = useState<'CDF' | 'USD'>('USD'),
    [limits, setLimits] = useState<Record<string, string>>({}),
    [requireEvidence, setRequireEvidence] = useState(true),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState<{ currency: 'CDF' | 'USD'; input: ExpensePolicyInput } | null>(
      null,
    );
  const epoch = useRef(0);
  useEffect(() => {
    let active = true;
    epoch.current++;
    setLoaded(false);
    setPending(null);
    setPolicies([]);
    setBusy(false);
    if (online)
      void gateway
        .expensePolicies()
        .then((r) => {
          if (active) {
            setPolicies(r.items);
            setLoaded(true);
          }
        })
        .catch((e) => {
          if (active) setError(message(e));
        });
    return () => {
      active = false;
      epoch.current++;
    };
  }, [gateway, online]);
  const policy = policies.find((p) => p.currency === currency);
  useEffect(() => {
    setLimits(
      Object.fromEntries(policy?.limits.map((l) => [`${l.role}:${l.action}`, l.maximum]) ?? []),
    );
    setRequireEvidence(policy?.requireEvidence ?? true);
  }, [policy, currency]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!online || !loaded) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const input: ExpensePolicyInput = expensePolicyInputSchema.parse({
        expectedVersion: policy?.version ?? null,
        requireEvidence,
        limits: cells.flatMap((c) => {
          const maximum = limits[`${c.role}:${c.action}`]?.trim().replace(',', '.');
          return maximum ? [{ ...c, maximum }] : [];
        }),
      });
      setPending({ currency, input });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!pending || !online || busy) return;
    const n = epoch.current;
    setBusy(true);
    setError('');
    try {
      const updated = await gateway.configureExpensePolicy(pending.currency, pending.input);
      if (n !== epoch.current) return;
      setPolicies((old) => [...old.filter((p) => p.currency !== pending.currency), updated]);
      setPending(null);
      setNotice('Règles enregistrées pour les prochaines actions.');
    } catch (e) {
      if (n === epoch.current) {
        setPending(null);
        setError(message(e));
      }
    } finally {
      if (n === epoch.current) setBusy(false);
    }
  }
  return (
    <form className="panel editor-form" onSubmit={save}>
      {pending && (
        <ConfirmDialog
          title="Confirmer les seuils d’approbation"
          confirm="Enregistrer ces plafonds"
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void apply()}
        >
          <p>
            Devise : {pending.currency}. {pending.input.limits.length} plafond(s) défini(s). Un
            plafond vide interdit l’action pour le rôle concerné.
          </p>
          <p>
            Les nouvelles limites seront revérifiées sur les prochaines demandes, décisions et
            paiements ; aucun paiement n’est exécuté ici.
          </p>
        </ConfirmDialog>
      )}
      <h2>Règles de dépenses par devise</h2>
      <p>
        Les fonds sont réservés à l’approbation. Un plafond vide interdit cette action pour ce rôle.
        Les permissions et affectations restent obligatoires.
      </p>
      <p className="auth-notice">
        Sans règles configurées pour une devise, aucune demande ne peut être soumise, approuvée ou
        payée dans cette devise. Plusieurs rôles autorisés donnent accès au plafond le plus élevé
        applicable.
      </p>
      <fieldset disabled={!online || busy || !loaded} className="expense-fields">
        <label>
          Devise des plafonds
          <select value={currency} onChange={(e) => setCurrency(e.target.value as typeof currency)}>
            <option>USD</option>
            <option>CDF</option>
          </select>
        </label>
        <p>{policy ? `Version ${policy.version}` : 'Configuration nécessaire'}</p>
        <label className="attestation">
          <input
            type="checkbox"
            checked={requireEvidence}
            onChange={(e) => setRequireEvidence(e.target.checked)}
          />
          Exiger au moins un justificatif
        </label>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Rôle</th>
                <th>Action</th>
                <th>Plafond par opération ({currency})</th>
              </tr>
            </thead>
            <tbody>
              {cells.map((c) => (
                <tr key={`${c.role}:${c.action}`}>
                  <td>{ROLE_LABELS[c.role]}</td>
                  <td>{actions[c.action].label}</td>
                  <td>
                    <input
                      aria-label={`${actions[c.action].label} — ${ROLE_LABELS[c.role]}`}
                      inputMode="decimal"
                      placeholder="Interdit"
                      value={limits[`${c.role}:${c.action}`] ?? ''}
                      onChange={(e) =>
                        setLimits({ ...limits, [`${c.role}:${c.action}`]: e.target.value })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="primary-button">Enregistrer les plafonds</button>
      </fieldset>
      {!online && <p className="auth-notice">Configuration disponible en ligne uniquement.</p>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </form>
  );
}
