import { useEffect, useState } from 'react';
import { ROLE_LABELS, type RoleCode } from '@caissepro/shared';
import { message, type AccessCatalog, type AuthGateway } from '../auth/gateway';
export const permissionLabels: Record<string, string> = {
  'directory:read': 'Consulter les répertoires autorisés',
  'ledger:read': 'Consulter les écritures et rapports autorisés',
  'receipt:read': 'Consulter les reçus',
  'users:manage': 'Administrer les utilisateurs',
  'roles:assign': 'Affecter les rôles et périmètres',
  'auth:logs:read': 'Consulter les journaux de sécurité et d’audit',
  'cash:configure': 'Configurer l’entreprise, les agences, caisses et règles financières',
  'offline:access': 'Accéder temporairement aux données locales autorisées',
  'draft:receive': 'Transmettre des brouillons',
  'draft:read_own': 'Consulter ses brouillons',
  'draft:write_own': 'Préparer ses brouillons',
  'receipt:post': 'Confirmer un encaissement',
  'expense:request': 'Soumettre une demande de dépense',
  'expense:approve': 'Approuver ou rejeter une dépense',
  'expense:pay': 'Confirmer un paiement approuvé',
  'transfer:post': 'Remettre ou recevoir un transfert',
  'fx:post': 'Valider une conversion',
  'fx:manual': 'Déclarer un taux manuel justifié',
  'ledger:reverse': 'Corriger par contre-écriture',
  'session:manage': 'Ouvrir ou clôturer une session de caisse',
};
export function RolesPage({
  gateway,
  online,
  onManageAccess,
}: {
  gateway: AuthGateway;
  online: boolean;
  onManageAccess?(): void;
}) {
  const [data, setData] = useState<AccessCatalog | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setData(null);
    if (online)
      void gateway
        .catalog()
        .then((v) => {
          if (active) setData(v);
        })
        .catch((e) => {
          if (active) setError(message(e));
        });
    return () => {
      active = false;
    };
  }, [gateway, online]);
  if (!online)
    return (
      <section className="panel">
        <h1>Rôles indisponibles hors connexion</h1>
        <p>Les droits et affectations sont validés sur le serveur.</p>
      </section>
    );
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">ADMINISTRATION DES ACCÈS</p>
          <h1>Rôles et permissions</h1>
          <p>
            Référentiel réel du serveur. Affectez les rôles, agences et caisses depuis Utilisateurs.
          </p>
        </div>
        {onManageAccess && (
          <button className="primary-button" onClick={onManageAccess}>
            Gérer les attributions
          </button>
        )}
      </header>
      <p className="auth-notice">
        Administrateur est un rôle technique. Les rôles financiers se choisissent explicitement dans
        Utilisateurs et peuvent se cumuler. Ils restent limités aux caisses autorisées et ne
        permettent jamais d’approuver sa propre demande.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="role-grid">
        {data &&
          Object.entries(data.roles).map(([code, permissions]) => (
            <section className="panel" key={code}>
              <h2>{ROLE_LABELS[code as RoleCode] ?? 'Rôle métier'}</h2>
              <ul className="permission-list">
                {permissions.map((p) => (
                  <li key={p}>{permissionLabels[p] ?? 'Autorisation métier'}</li>
                ))}
              </ul>
            </section>
          ))}
      </div>
    </>
  );
}
