# Stockage local chiffré — étape 13-B

Le desktop réutilise SQLCipher embarqué via `rusqlite 0.41.1`, fonctionnalité `bundled-sqlcipher-vendored-openssl`, et `keyring 3.6.3` pour Windows Credential Manager et le trousseau macOS. SQLite standard ne chiffre pas. Aucun plugin SQL, accès fichiers général, coffre en fichier ou stockage navigateur sensible n’est exposé à React.

Le courtier de sessions et l’adaptateur sont maintenant raccordés. La portée de qualification et les résultats effectifs sont décrits dans [le bilan 13-B](etape-13b/BILAN.md). Une compilation Linux ou un coffre de test en mémoire ne vaut pas qualification Windows/macOS. Le booléen `PLATFORM_STORAGE_VALIDATED` reste la porte de l’application : l’activation candidate est limitée à Windows x64/MSVC et macOS Apple Silicon, avec validation complète en cours. Les autres cibles restent en mémoire uniquement ; le hook de qualification Rust n’est disponible qu’avec la fonctionnalité de test et n’est jamais exposé par Tauri.

## Données et clés

Une clé SQLCipher aléatoire de 256 bits, générée par le système, est conservée dans le coffre natif. Elle est liée à l’entreprise, l’utilisateur et l’appareil. L’identité d’appareil reste stable dans le coffre pour un même déploiement ; le fichier ajoute un espace de noms lié à l’adresse et à l’identifiant du serveur. Aucune clé n’est dérivée d’un identifiant ou placée dans `.env`.

La migration locale additive `003_workspace.sql` ajoute un checkpoint complet transactionnel, sans remplacer `001` ou `002`. Il conserve brouillons, pièces jointes enregistrées, devises et montants d’origine, captures, révisions, liens serveur et instantanés de transmission. Aucun mot de passe en clair ni jeton serveur n’est sérialisé. Le vérificateur permettant le déverrouillage local est inclus dans le checkpoint chiffré, jamais dans React. Les buffers temporaires de clés et de sérialisation sont effacés avec `zeroize` lorsque possible.

L’ouverture contrôle `cipher_version`, la lecture authentifiée et la version de schéma avant toute migration. Un fichier vide existant, corrompu, incompatible ou privé de clé est refusé ; aucun remplacement silencieux. Le rollback journal est chiffré, les temporaires sont en mémoire et `secure_delete` est actif. Les montants restent des chaînes décimales exactes.

## Fichiers et isolation

Dossiers Unix/macOS 0700, fichiers 0600. Sur Windows, une DACL protégée autorise le propriétaire, SYSTEM et les administrateurs, avec héritage pour les fichiers du dossier ; les points de réanalyse sont refusés. Les fichiers symboliques et multiliens sont refusés. Les alias des dossiers système macOS sont résolus avant l’ouverture SQLite `NOFOLLOW`.

L’accès nécessite le périmètre exact de l’auteur. Une révision optimiste empêche un processus ancien d’écraser ou de supprimer le checkpoint plus récent d’un autre processus. Le ticket du coffre natif est lié à la révision et à la date de sauvegarde ; un fichier ancien rejoué ou un recul d’horloge détecté ne rétablit pas le bail hors connexion.

## Verrouillage, révocation et récupération

Le bail hors connexion reste borné par le serveur, au plus quinze minutes ; la conservation des brouillons est distincte, au plus sept jours. Au redémarrage, aucune opération n’est envoyée automatiquement et aucun jeton n’est réutilisé. Le courtier est verrouillé. Les tentatives incorrectes de déverrouillage sont persistées et cinq échecs retirent la reprise hors connexion.

La déconnexion invalide d’abord le bail dans la base puis retire le ticket natif. Le même auteur peut récupérer ses brouillons non expirés après une authentification serveur. La révocation connue, un changement de périmètre ou de mot de passe purgent le contexte concerné et sa clé. Les réponses tardives d’une génération de session précédente sont rejetées. Une révocation encore inconnue pendant une coupure ne peut être appliquée avant reconnexion ; son effet est borné par le bail initial.

La perte d’une clé locale n’a aucun contournement en clair : conserver le fichier pour investigation, se reconnecter et retrouver les copies déjà reçues sur le serveur. Un brouillon jamais transmis n’est pas récupérable sans sa clé. Aucune rotation administrative de clés ou récupération externe n’est proposée par cette étape. La suppression physique des copies sur SSD, sauvegardes ou snapshots n’est pas garantie ; la suppression de la clé est la mesure principale.

## Limites et distribution

Un administrateur du système d’exploitation ou un processus compromis ne fait pas partie de la garantie d’isolation entre comptes applicatifs. Les installateurs signés, leurs conditions de trousseau et les mises à jour restent une qualification de distribution à traiter lors de l’étape 10, non lancée ici. Aucune conformité FIPS ou réglementaire n’est revendiquée.

Sources : [rusqlite](https://docs.rs/rusqlite/0.41.1/rusqlite/), [SQLCipher](https://www.zetetic.net/sqlcipher/), [keyring](https://docs.rs/keyring/3.6.3/keyring/), [prérequis Tauri](https://v2.tauri.app/start/prerequisites/). Les versions transitives réellement utilisées sont celles des trois `Cargo.lock`.
