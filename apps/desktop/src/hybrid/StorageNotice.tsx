import { useEffect, useState } from 'react';
import type { SyncStatus } from '@caissepro/shared';
import type { AuthGateway } from '../auth/gateway';

export function StorageNotice({ gateway, status }: { gateway: AuthGateway; status?: SyncStatus }) {
  const [value, setValue] = useState<SyncStatus | null>(status ?? null),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    if (status) {
      setValue(status);
      setFailed(false);
      return;
    }
    void gateway
      .syncStatus()
      .then((v) => {
        if (active) {
          setValue(v);
          setFailed(false);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [gateway, status]);
  return (
    <p className="auth-notice" aria-label="Protection des brouillons">
      {failed ? (
        'État du stockage non vérifiable. Ne considérez pas vos brouillons comme conservés après fermeture.'
      ) : !value ? (
        'Vérification du stockage des brouillons…'
      ) : value.persistence === 'encrypted-sqlcipher' ? (
        <>
          Brouillons chiffrés sur cet appareil, conservés au plus sept jours. La réouverture exige
          un déverrouillage local autorisé ou une nouvelle connexion. L’expiration du bail hors
          connexion verrouille les données.{' '}
          {value.lastSavedAt && (
            <>
              Dernier enregistrement natif : {new Date(value.lastSavedAt).toLocaleString('fr-FR')}.
            </>
          )}
        </>
      ) : (
        <>
          Brouillons en mémoire temporaire uniquement. Fermer l’application efface les brouillons
          non transmis. Le stockage persistant chiffré n’est pas activé sur cette plateforme. Les
          copies reçues par le serveur restent disponibles après connexion.
        </>
      )}{' '}
      La synchronisation transmet un brouillon ; elle ne confirme aucun mouvement financier.
    </p>
  );
}
