# Étape 13-B — brouillons chiffrés et reprise native

Travaux du 12 novembre 2026, branche `feat/etape-13b-brouillons-chiffres`, base `b761b852263dac12653c9329a0febb6dbf9b9dac`.

**Statut de ce premier lot : implémentation intégrée et vérifiée sous Linux ; activation du stockage natif encore bloquée en attendant les résultats Windows/macOS.** Le booléen de qualification reste faux. Le mode effectivement actif est affiché par l’application ; aucun enregistrement sur disque n’est annoncé à tort.

## Audit et changements

Le courtier Rust gardait uniquement en mémoire les brouillons, les saisies de formulaire, le cache autorisé et les envois en cours. Son identifiant d’appareil changeait à chaque lancement. Le module SQLCipher existait mais son modèle minimal ne conservait ni les pièces jointes, ni les liens serveur complets, ni les instantanés d’envoi. Il n’était pas raccordé au cycle des sessions.

L’intégration réutilise SQLCipher embarqué avec OpenSSL, les coffres natifs `keyring` et les contrôles de génération de session existants. La migration **locale additive** `003_workspace.sql` conserve les tables historiques et ajoute un checkpoint transactionnel complet. Aucun schéma ou fichier de migration PostgreSQL n’est modifié.

Le checkpoint contient les identifiants stables, types, devises réelles, montants décimaux exacts, détails et pièces jointes, dates, versions, périmètres d’auteur/entreprise/appareil, états, liens serveur et instantanés d’envoi. Il n’existe aucune table locale de comptabilisation ou de solde officiel. Un checkpoint entier est limité à 32 Mio, les brouillons à 200 et les saisies incomplètes à 20. Les erreurs de stockage ne donnent pas une confirmation de sauvegarde.

## Protection et durée

- Clé SQLCipher aléatoire de 256 bits, protégée par Windows Credential Manager ou le trousseau macOS. Aucun repli en clair, mot de passe en clair, jeton serveur persistant ou plugin SQL/fichiers général n’est ajouté.
- Espace lié à l’utilisateur, l’entreprise, l’appareil stable et au déploiement serveur. Au redémarrage, le courtier commence verrouillé et sans jeton serveur. L’accès hors connexion exige le mot de passe de l’utilisateur précédent, un vérificateur protégé dans le checkpoint chiffré et un bail serveur encore valable.
- Les fichiers utilisent 0600 et le dossier 0700 sous Unix/macOS. Sous Windows, des DACL protégées limitent les accès au propriétaire, au système et aux administrateurs ; les points de réanalyse sont refusés. Les journaux SQLite restent chiffrés et les temporaires sont en mémoire.
- Les brouillons et saisies sont conservés au plus **sept jours**, indépendamment du bail hors connexion, qui reste limité à **quinze minutes** et par l’expiration de session. Les dates des brouillons ne sont pas prolongées par leurs modifications. Une nouvelle authentification permet de retrouver des brouillons encore valides après expiration du bail.
- La déconnexion invalide d’abord le bail dans la base chiffrée puis retire le ticket natif ; les brouillons restent récupérables par le même auteur après authentification serveur. La révocation connue, le changement de périmètre et le changement de mot de passe invalident et purgent le contexte concerné. Une erreur ne réinitialise jamais un fichier corrompu ou dépourvu de clé.
- Les révisions optimistes empêchent un processus ancien d’écraser ou d’effacer le checkpoint plus récent d’un autre processus. Le ticket du coffre est lié à la révision enregistrée ; un ancien fichier rejoué ou un recul d’horloge détecté ne restaure pas un accès hors connexion.

Les administrateurs du système d’exploitation et un processus compromis restent hors de la garantie d’isolation entre utilisateurs applicatifs. Le logiciel n’affirme pas effacer physiquement des copies SSD/snapshots. La révocation reçue du serveur est appliquée ; une révocation nouvelle ne peut pas être connue pendant une coupure réseau et reste bornée par le bail initial. La conservation de sept jours est appliquée à la réouverture et aux consultations ; aucun accès à un brouillon expiré n’est rendu possible par une nouvelle session.

## Synchronisation et opérations interdites

Le checkpoint de l’envoi est enregistré **avant** le POST. Après une coupure ou un accusé perdu, la révision et le contenu exacts sont repris avec le même UUID, même si une correction locale plus récente existe. Les accusés conservent le lien vers le brouillon serveur et les identifiants de reçu ou demande déjà existants. Les conflits et limites de tentatives restent explicites.

Le redémarrage ne transmet et ne confirme aucune opération automatiquement. Le retour en ligne exige une authentification serveur renouvelée si aucun jeton n’est présent ; les permissions et périmètres sont revalidés. Les contrôles d’origine interdisent hors connexion toute confirmation d’encaissement, approbation, paiement, remise/réception définitive, conversion exécutée ou clôture. Une proposition de taux conservée n’est pas réputée actuelle : les services de change et leurs validations restent applicables.

## Interface

Les écrans d’encaissement, dépenses, transferts et synchronisation affichent le mode confirmé par le courtier : `memory-only` ou `encrypted-sqlcipher`, avec date du dernier checkpoint lorsqu’il est disponible. Un statut non vérifiable ne promet aucune conservation. Les saisies ne sont annoncées enregistrées qu’après la réponse native ; les fichiers sélectionnés doivent être enregistrés avec le brouillon.

## Validation et suite

Le premier lot passe `pnpm check` (23 tests Node, 30 partagés, 27 unitaires API, 119 React), 161 tests HTTP/PostgreSQL et 16 parcours Chromium avec IPC simulé. Les tests Rust Linux comprennent 12 tests du magasin SQLCipher et 69 tests du courtier ; ils distinguent explicitement coffre de test en mémoire, SQLCipher réel et serveur HTTP simulé.

La matrice `.github/workflows/local-store-native.yml` est préparée pour cette branche. Elle doit vérifier les coffres système réels, le redémarrage dans deux processus distincts, les ACL Windows, les régressions et la compilation réelle Tauri sur Windows/macOS. Les résultats seront ajoutés avant toute déclaration de fin d’étape. Aucun installateur ni étape 14 n’est lancé.

Retour arrière : revenir au commit précédent pour le code, conserver les fichiers chiffrés et leurs clés ; ne pas les ouvrir avec SQLite standard, ne pas supprimer les migrations historiques et ne pas réinitialiser PostgreSQL. L’ancien code n’interprète pas le checkpoint v3 ; une mise à niveau ultérieure doit conserver les fichiers et versions.
