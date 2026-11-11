import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  INITIAL_CURRENCY_CATALOG,
  currencyPrecision,
  formatMonetary,
  registerCurrencyDefinitions,
  type MoneyContext,
  type MoneyPreferenceInput,
} from '@caissepro/shared';
import { message, type AuthGateway } from '../auth/gateway';
const legacy: MoneyContext = {
  currencies: [...INITIAL_CURRENCY_CATALOG],
  companyCurrencies: ['CDF', 'USD'].map((code) => ({ code, active: true, version: 1 })),
  preferences: { displayCurrency: null, favoriteCurrency: null, locale: 'fr-FR', version: 0 },
  reporting: { currency: null, version: 1 },
  generatedAt: '',
};
function helpers(data: MoneyContext) {
  const active = data.companyCurrencies
    .filter((c) => c.active && data.currencies.some((d) => d.code === c.code && d.active))
    .map((c) => c.code);
  return {
    data,
    order: <T extends { currency: string }>(values: readonly T[]): T[] =>
      [...values].sort((a, b) => {
        if (a.currency === b.currency) return 0;
        if (a.currency === data.preferences.displayCurrency) return -1;
        if (b.currency === data.preferences.displayCurrency) return 1;
        return a.currency.localeCompare(b.currency);
      }),
    active,
    precision: currencyPrecision,
    format: (value: string) => formatMonetary(value, data.preferences.locale),
    preferred: (legacyDefault = 'CDF') =>
      active.includes(data.preferences.favoriteCurrency ?? '')
        ? data.preferences.favoriteCurrency!
        : active.includes(legacyDefault)
          ? legacyDefault
          : (active[0] ?? ''),
    pattern: (currency: string) =>
      currencyPrecision(currency) === 0
        ? '(?:0|[1-9][0-9]{0,15})'
        : `(?:0|[1-9][0-9]{0,15})[.,][0-9]{${currencyPrecision(currency)}}`,
    placeholder: (currency: string) =>
      currencyPrecision(currency) === 0 ? '0' : '0.' + '0'.repeat(currencyPrecision(currency)),
  };
}
const Context = createContext({
  ...helpers(legacy),
  refresh: async () => {},
  save: async (_input: MoneyPreferenceInput) => {
    void _input;
  },
});
export const useMoney = () => useContext(Context);
export function MoneyProvider({
  gateway,
  online,
  children,
  onLogout,
}: {
  gateway: AuthGateway;
  online: boolean;
  children: ReactNode;
  onLogout?: () => Promise<void>;
}) {
  const [data, setData] = useState<MoneyContext | null>(null),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    void gateway
      .moneyContext()
      .then((value) => {
        registerCurrencyDefinitions(value.currencies);
        if (alive) {
          setData(value);
          setError('');
        }
      })
      .catch((e) => {
        if (alive) setError(message(e));
      });
    return () => {
      alive = false;
    };
  }, [gateway, online, retry]);
  async function refresh() {
    setRetry((v) => v + 1);
  }
  async function save(input: MoneyPreferenceInput) {
    const next = await gateway.moneyPreferences(input);
    registerCurrencyDefinitions(next.currencies);
    setData(next);
  }
  if (!data)
    return (
      <main className="login-card">
        <h1>Configuration monétaire</h1>
        <p>{error || 'Chargement des devises autorisées…'}</p>
        {error && <button onClick={() => void refresh()}>Réessayer</button>}
        {onLogout && <button onClick={() => void onLogout()}>Se déconnecter</button>}
      </main>
    );
  return (
    <Context.Provider value={{ ...helpers(data), refresh, save }}>
      {error && <p role="alert">Configuration monétaire non actualisée : {error}</p>}
      {children}
    </Context.Provider>
  );
}
export function CurrencyOptions({ include, all = false }: { include?: string; all?: boolean }) {
  const { active, data } = useMoney();
  const codes = all
    ? data.currencies.filter((c) => c.active).map((c) => c.code)
    : [...new Set([...active, ...(include ? [include] : [])])];
  return (
    <>
      {codes.map((code) => (
        <option key={code} value={code}>
          {code}
          {all ? ' — ' + (data.currencies.find((c) => c.code === code)?.name ?? code) : ''}
          {!active.includes(code) && !all ? ' (inactive)' : ''}
        </option>
      ))}
    </>
  );
}
