import './money.css';
import { useEffect, useState, useRef, type FormEvent } from 'react';
import type { ReportSnapshot, ReferenceData, Valuation } from '@caissepro/shared';
import { message, type AuthGateway } from '../auth/gateway';
import { CurrencyOptions, useMoney } from './MoneyContext';
export function ValuationPanel({
  snapshot,
  gateway,
  online,
}: {
  snapshot: ReportSnapshot;
  gateway: AuthGateway;
  online: boolean;
}) {
  const epoch = useRef(0),
    latestOnline = useRef(online);
  latestOnline.current = online;
  const money = useMoney(),
    [target, setTarget] = useState(
      money.data.preferences.displayCurrency ??
        money.data.reporting.currency ??
        money.active[0] ??
        '',
    ),
    [references, setReferences] = useState<ReferenceData | null>(null),
    [selected, setSelected] = useState<Record<string, string>>({}),
    [confirmed, setConfirmed] = useState(false),
    [value, setValue] = useState<Valuation | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    epoch.current++;
    setBusy(false);
    setValue(null);
    setSelected({});
    setConfirmed(false);
    if (online)
      void gateway
        .referenceData()
        .then((r) => {
          if (alive) setReferences(r);
        })
        .catch((e) => {
          if (alive) setError(message(e));
        });
    return () => {
      alive = false;
      epoch.current++;
    };
  }, [snapshot, gateway, online]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!online || !confirmed) return;
    const seq = ++epoch.current;
    setBusy(true);
    setValue(null);
    setError('');
    try {
      const result = await gateway.reportValuation({
        query: snapshot.query,
        currency: target,
        rates: snapshot.totals
          .filter((t) => t.currency !== target)
          .map((t) => ({ currency: t.currency, rateId: selected[t.currency] ?? '' })),
        confirmed: true,
      });
      if (seq === epoch.current && latestOnline.current) setValue(result);
    } catch (e) {
      if (seq === epoch.current && latestOnline.current) setError(message(e));
    } finally {
      if (seq === epoch.current) setBusy(false);
    }
  }
  return (
    <section className="panel money-panel money-valuation">
      <h2>Équivalence de reporting</h2>
      <p>
        Estimation séparée des soldes actuels. Les opérations et les rapports par devise conservent
        leurs montants d’origine. Arrondi HALF_UP par devise convertie, puis somme dans la monnaie
        de référence.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <form className="money-form" onSubmit={submit}>
        <label>
          Devise de référence
          <select
            value={target}
            onChange={(e) => {
              epoch.current++;
              setBusy(false);
              setTarget(e.target.value);
              setSelected({});
              setConfirmed(false);
              setValue(null);
            }}
          >
            <CurrencyOptions include={target} />
          </select>
        </label>
        {snapshot.totals
          .filter((t) => t.currency !== target)
          .map((t) => (
            <label key={t.currency}>
              Taux explicite {t.currency} vers {target}
              <select
                required
                value={selected[t.currency] ?? ''}
                onChange={(e) => {
                  epoch.current++;
                  setBusy(false);
                  setSelected((v) => ({ ...v, [t.currency]: e.target.value }));
                  setConfirmed(false);
                  setValue(null);
                }}
              >
                <option value="">Choisir un taux publié</option>
                {references?.rates
                  .filter((r) => r.fromCurrency === t.currency && r.toCurrency === target)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.rate} · {r.source} · {new Date(r.validFrom).toLocaleString('fr-FR')}
                    </option>
                  ))}
              </select>
            </label>
          ))}
        <label className="money-attestation">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          Je valide les taux, leurs sources et leurs dates pour cette estimation.
        </label>
        <button className="primary-button" disabled={!online || busy || !confirmed}>
          Calculer l’équivalence sur le serveur
        </button>
      </form>
      {value && (
        <div role="status">
          <strong>
            {money.format(value.totalBalance)} {value.currency}
          </strong>
          <p>
            Estimation au {new Date(value.asOf).toLocaleString('fr-FR')} — aucune écriture
            comptable.
          </p>
          <ul>
            {value.items.map((i) => (
              <li key={i.currency}>
                {money.format(i.originalBalance)} {i.currency} → {money.format(i.equivalent)}{' '}
                {value.currency} · taux {i.rate} · {i.source}
                {i.validFrom ? ' · ' + new Date(i.validFrom).toLocaleDateString('fr-FR') : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
