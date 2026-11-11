import './money.css';
import { useState, type FormEvent } from 'react';
import type { SessionProfile, MoneyPreferenceInput } from '@caissepro/shared';
import { message, type AuthGateway } from '../auth/gateway';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { CurrencyOptions, useMoney } from './MoneyContext';
export function MoneyPage({
  gateway,
  profile,
  online,
}: {
  gateway: AuthGateway;
  profile: SessionProfile;
  online: boolean;
}) {
  const money = useMoney(),
    { data } = money;
  const [display, setDisplay] = useState(data.preferences.displayCurrency ?? ''),
    [favorite, setFavorite] = useState(data.preferences.favoriteCurrency ?? ''),
    [locale, setLocale] = useState<MoneyPreferenceInput['locale']>(data.preferences.locale),
    [code, setCode] = useState(money.active[0] ?? ''),
    [reporting, setReporting] = useState(data.reporting.currency ?? ''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<'currency' | 'reporting' | null>(null);
  const row = data.companyCurrencies.find((c) => c.code === code);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await money.refresh();
      setNotice('Configuration enregistrée sur le serveur.');
      setPending(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function preferences(e: FormEvent) {
    e.preventDefault();
    void run(() =>
      money.save({
        expectedVersion: data.preferences.version,
        displayCurrency: display || null,
        favoriteCurrency: favorite || null,
        locale,
      }),
    );
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MONNAIES ET PRÉFÉRENCES</p>
          <h1>Vos devises</h1>
          <p>Chaque opération conserve sa devise et son montant d’origine.</p>
        </div>
      </div>
      {!online && (
        <p className="cash-freshness stale">
          Hors connexion — paramètres consultables, modifications indisponibles. Catalogue connu au{' '}
          {new Date(data.generatedAt).toLocaleString('fr-FR')}.
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="money-notice">
          {notice}
        </p>
      )}
      <section className="panel money-panel">
        <h2>Préférences personnelles</h2>
        <form className="money-form" onSubmit={preferences}>
          <label>
            Devise d’affichage préférée
            <select
              value={display}
              onChange={(e) => setDisplay(e.target.value)}
              disabled={!online || busy}
            >
              <option value="">Toutes les devises séparées</option>
              <CurrencyOptions include={display} />
            </select>
          </label>
          <label>
            Devise favorite des nouveaux formulaires
            <select
              value={favorite}
              onChange={(e) => setFavorite(e.target.value)}
              disabled={!online || busy}
            >
              <option value="">Choix habituel</option>
              <CurrencyOptions include={favorite} />
            </select>
          </label>
          <label>
            Format monétaire
            <select
              value={locale}
              onChange={(e) => setLocale(e.target.value as MoneyPreferenceInput['locale'])}
              disabled={!online || busy}
            >
              <option value="fr-FR">Français — France</option>
              <option value="fr-CD">Français — RD Congo</option>
              <option value="en-US">Anglais — États-Unis</option>
              <option value="en-GB">Anglais — Royaume-Uni</option>
            </select>
          </label>
          <p>
            La devise d’affichage met en avant un solde dans sa monnaie réelle. Une équivalence
            exige toujours un taux explicite validé. Les saisies en cours restent inchangées.
          </p>
          <button disabled={!online || busy} className="primary-button">
            Enregistrer mes préférences
          </button>
        </form>
      </section>
      {profile.permissions.includes('cash:configure') && (
        <section className="panel money-panel">
          <h2>Devises de l’entreprise</h2>
          <p>
            Activer une devise ouvre des comptes de solde nul dans les caisses de l’entreprise. Les
            droits d’accès et les plafonds d’approbation restent obligatoires.
          </p>
          <label>
            Devise du catalogue
            <select value={code} onChange={(e) => setCode(e.target.value)}>
              <CurrencyOptions all />
            </select>
          </label>
          <p>
            {data.currencies.find((c) => c.code === code)?.name} · {money.precision(code)} décimales
            · {row?.active ? 'Autorisée' : 'Non autorisée'}
          </p>
          <button
            className="secondary-button"
            disabled={!online || busy}
            onClick={() => setPending('currency')}
          >
            {row?.active ? 'Désactiver' : 'Activer'} {code}
          </button>
          <label>
            Devise de référence pour les rapports
            <select value={reporting} onChange={(e) => setReporting(e.target.value)}>
              <option value="">Aucune</option>
              <CurrencyOptions include={reporting} />
            </select>
          </label>
          <button
            className="secondary-button"
            disabled={!online || busy}
            onClick={() => setPending('reporting')}
          >
            Enregistrer la référence
          </button>
          <p>
            Aucun solde de monnaies différentes n’est additionné directement. Les comptes et les
            documents historiques restent consultables après désactivation.
          </p>
          <small>
            Source ISO de {code} datée du {data.currencies.find((c) => c.code === code)?.sourceDate}
            . Disponibilité des cours BCC non vérifiée ; aucune connexion BCC à cette étape.
          </small>
        </section>
      )}
      {pending && (
        <ConfirmDialog
          title="Confirmer la configuration monétaire"
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() =>
            void run(() =>
              pending === 'currency'
                ? gateway.configureCurrency({
                    code,
                    active: !row?.active,
                    expectedVersion: row?.version ?? 0,
                    confirmed: true,
                  })
                : gateway.configureReporting({
                    currency: reporting || null,
                    expectedVersion: data.reporting.version,
                    confirmed: true,
                  }),
            )
          }
        >
          <p>
            {pending === 'currency'
              ? `${row?.active ? 'Désactiver' : 'Activer'} ${code} pour l’entreprise ? Les écritures historiques seront conservées.`
              : `Devise de référence : ${reporting || 'aucune'}. Les montants d’origine restent inchangés.`}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
