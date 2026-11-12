# Étape 13-B — brouillons chiffrés et reprise native

Travaux du 12 novembre 2026, branche `feat/etape-13b-brouillons-chiffres`, base `b761b852263dac12653c9329a0febb6dbf9b9dac`.

**Étape 13-B livrée : les tests essentiels automatisés et la compilation native complète sont validés sur Windows x64/MSVC et macOS Apple Silicon.** Le stockage SQLCipher est activé sur ces cibles. Les autres architectures et Linux restent en mémoire uniquement ; le mode effectivement actif est affiché. La distribution signée reste à qualifier à l’étape 10. Aucune étape 14 n’est commencée.

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
- Les révisions optimistes empêchent un processus ancien d’écraser ou d’effacer le checkpoint plus récent d’un autre processus. Un verrou système exclusif englobe lecture, écriture, ticket natif et purge : une connexion fraîche ne peut pas s’intercaler entre la vérification de révision et la suppression. Le ticket du coffre est lié à la révision enregistrée ; un ancien fichier rejoué ou un recul d’horloge détecté ne restaure pas un accès hors connexion.

Les administrateurs du système d’exploitation et un processus compromis restent hors de la garantie d’isolation entre utilisateurs applicatifs. Le logiciel n’affirme pas effacer physiquement des copies SSD/snapshots. La révocation reçue du serveur est appliquée ; une révocation nouvelle ne peut pas être connue pendant une coupure réseau et reste bornée par le bail initial. La conservation de sept jours est appliquée à la réouverture et aux consultations ; aucun accès à un brouillon expiré n’est rendu possible par une nouvelle session.

## Synchronisation et opérations interdites

Le checkpoint de l’envoi est enregistré **avant** le POST. Les transferts conservent également leur instantané exact et signalent une correction locale différente ; leur suppression est refusée tant que la transmission reste incertaine. Après une coupure ou un accusé perdu, la révision et le contenu exacts sont repris avec le même UUID, même si une correction locale plus récente existe. Les accusés conservent le lien vers le brouillon serveur et les identifiants de reçu ou demande déjà existants. Les conflits et limites de tentatives restent explicites.

Le redémarrage ne transmet et ne confirme aucune opération automatiquement. Le retour en ligne exige une authentification serveur renouvelée si aucun jeton n’est présent ; les permissions et périmètres sont revalidés. Les contrôles d’origine interdisent hors connexion toute confirmation d’encaissement, approbation, paiement, remise/réception définitive, conversion exécutée ou clôture. Une proposition de taux conservée n’est pas réputée actuelle : les services de change et leurs validations restent applicables.

## Interface

Les écrans d’encaissement, dépenses, transferts et synchronisation affichent le mode confirmé par le courtier : `memory-only` ou `encrypted-sqlcipher`, avec date du checkpoint vérifié lorsqu’il est disponible. Un statut non vérifiable ne promet aucune conservation. Les saisies ne sont annoncées enregistrées qu’après la réponse native ; les fichiers sélectionnés doivent être enregistrés avec le brouillon.

## Validation et portée

Le [passage natif complet](https://github.com/Djoys-ilunga/GESTION-DE-CAISSE/actions/runs/43237829801) porte sur le code `bd4b8b5ed4d7f3a97b61f864c1ad19bb9cc4067b`. La matrice complète réussit sur les deux cibles : tests SQLCipher/coffres, test de l’entrée publique activée, `pnpm check`, compilation et liaison du véritable desktop Tauri sans création d’installateur.

| Vérification            | Résultat et nature de la preuve                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm check` Linux      | Réussi : 23 tests Node, 30 partagés, 27 unitaires API, 123 React ; lint, types et builds réussis                |
| `pnpm format:check`     | Réussi sur tout le dépôt                                                                                        |
| `pnpm test:db`          | 161 tests réussis sur HTTP/NestJS et PostgreSQL réels, dans des bases jetables                                  |
| `pnpm test:e2e`         | 16 parcours Chromium réussis, avec IPC explicitement simulé                                                     |
| Magasin SQLCipher Linux | 14 tests réussis avec SQLCipher réel, coffre synthétique ; pas de coffre Linux activé en application            |
| Courtier Rust Linux     | 71 tests réussis, en parallèle puis séquentiellement ; HTTP de test et checkpoints SQLCipher réels              |
| Tauri Linux             | Clippy sans avertissement, compilation/liaison et fenêtre réelle 1280 × 900 réussies                            |
| macOS Apple Silicon     | 15 tests SQLCipher/coffre, 74 tests de session, `pnpm check` et compilation Tauri `--debug --no-bundle` réussis |
| Windows x64/MSVC        | 15 tests SQLCipher/coffre, 74 tests de session, `pnpm check` et compilation Tauri `--debug --no-bundle` réussis |

Le helper Rust marqué `ignored` est exécuté explicitement par son test parent dans **trois processus enfants** : écriture, réouverture et refus d’un accès pendant un verrou détenu par un autre processus. Il n’est pas compté comme un scénario laissé sans vérification. Le test d’entrée publique exige `PLATFORM_STORAGE_VALIDATED = true` sur les runners : il ne peut pas réussir en évitant le stockage réel.

Les traces et captures locales sont conservées hors du checkout, dans `/workspace/scratch/etape13b-verification`. Les archives de source sont vérifiées fichier par fichier contre les objets Git, avec empreinte SHA-256 et contrôle du SHA distant.

## Anomalies corrigées pendant la qualification

- Alias macOS `/var` : résolution du dossier parent avant SQLite `NOFOLLOW`, refus maintenu des liens de fichier ; chemins canoniques pour la fixture ESM du lanceur.
- Windows : DACL protégées et vérification native ; environnement PowerShell du test ACL isolé des modules hérités.
- HTTP de test : des sockets acceptés héritaient du mode non bloquant sur certaines plateformes. Le lecteur temporisé impose le mode bloquant, traite les connexions indépendamment et envoie des réponses complètes. Le test de requête fragmentée échoue effectivement avec l’ancienne fixture puis passe avec la correction. Les délais de production 4/8 secondes et TLS sont conservés.
- Contrôles Node sur Windows : identités de processus synthétiques indépendantes de `node.exe`, conversion des URL de fichiers en chemins natifs et lecture UTF-8 explicite du générateur ISO. Aucune migration historique n’est réécrite.
- Lanceur macOS : une sortie inattendue de l’API provoquait un signal sur un groupe de processus déjà terminé, masquant le diagnostic par `EPERM`. Les enfants déjà terminés et les signaux déjà envoyés sont ignorés ; les autres refus système restent des erreurs.

Les suites CI sont isolées pour éviter la concurrence artificielle des KDF et trousseaux ; les tests métier de concurrence conservent leurs workers propres. Les scénarios financiers, contrôles de rôle et assertions de sécurité ne sont pas supprimés.

Les cibles activées sont **Windows x64/MSVC et macOS Apple Silicon**. Les autres architectures et Linux restent en mémoire uniquement, sans repli en clair. Les tests natifs concernent le coffre, le courtier, les processus et la compilation réelle du desktop ; ils ne constituent pas une recette graphique manuelle de tous les écrans sur chaque OS. Les applications signées, installateurs et mises à jour restent à qualifier à l’étape 10, non lancée ici. L’étape 14 n’est pas commencée.

## Matrice des scénarios essentiels

| Scénario                                             | Preuve principale                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Fermeture et redémarrage                             | Checkpoint SQLCipher rouvert verrouillé ; test natif dans deux exécutables successifs avec coffre système                |
| Coupure, redémarrage hors connexion, retour en ligne | Courtier restauré sans jeton ; mot de passe et bail initial exigés ; nouveau login avant transmission                    |
| Déconnexion, changement d’auteur ou d’entreprise     | Ticket retiré ; récupération après login uniquement ; aucun mélange des espaces privés                                   |
| Expiration et permissions révoquées                  | Bail expiré refusé ; scope/version revalidés et purge lors d’une révocation connue                                       |
| Corruption et clé absente                            | Lecture refusée sans recréer le fichier ou une clé de remplacement                                                       |
| Transmission interrompue et doublon                  | Instantané exact préservé sur disque, UUID/révision identiques, nouvelle édition locale conservée                        |
| Transfert interrompu puis corrigé                    | Montant et taux initialement envoyés rejoués à l’identique, correction séparée signalée, suppression incertaine refusée  |
| Concurrence entre processus                          | Verrou OS entre processus et compare-and-swap sur révision ; un ancien processus ne peut ni écraser ni purger le gagnant |
| Échec du coffre ou du checkpoint                     | Sauvegarde non acquittée ; aucun POST sans checkpoint réussi ; ticket incohérent refusé                                  |
| Mot de passe incorrect puis redémarrage              | Compteur persistant ; cinq échecs désactivent la reprise hors connexion                                                  |
| Aucun traitement financier local                     | Tests de toutes les confirmations, approbations, paiements, remises, réceptions et clôtures hors connexion               |
| Conservation et devises                              | Sept jours au plus, dates initiales conservées, CDF/USD et catalogue/BCC revalidés par les tests financiers existants    |

## Fichiers et responsabilités

- `packages/local-store/src/{lib,permissions,tests}.rs`, `migrations/003_workspace.sql` et Cargo : checkpoint, SQLCipher, droits système et migration locale additive.
- `packages/session-core/src/{persistence,persistence_tests,broker,state,synchronization,model,tests,transport_tests,lib}.rs` et Cargo : cycle des sessions, récupération, isolation, instantanés et tests.
- `apps/desktop/src-tauri/src/lib.rs` et son verrou Cargo : raccordement au chemin de données système, sans commande générique de fichiers.
- `packages/shared/src/{index,synchronization}.ts`, `apps/api/src/data/draft-inbox.service.ts` et `test/integration/synchronization.spec.ts` : contrat et validation des dates de brouillon, sans changement des écritures.
- `apps/desktop/src/hybrid/{StorageNotice,SyncCenter}.tsx`, `local-store.ts`, les formulaires/pages d’encaissements, dépenses, transferts, `App.tsx`, `auth/gateway.ts` et tests associés : mode de stockage vérifiable et reprise explicite.
- `.github/workflows/local-store-native.yml`, `scripts/native-qualification-command.mjs`, les trois tests natifs du lanceur/catalogue, `scripts/demo-macos.mjs` et `scripts/generate-currency-migration.py` : qualification réelle, diagnostics bornés, portabilité des fixtures et correction d’arrêt réentrant.
- Ce bilan, le README, `docs/validation.md`, les guides d’authentification, encaissements, dépenses, transferts, configuration de caisses, démonstration macOS, `docs/chiffrement-local.md` et `docs/synchronisation.md` : comportement, preuves, durée, limites et retour arrière.

Avant mise à jour, transmettre les anciens brouillons encore uniquement en mémoire si leur conservation est nécessaire : cette étape ne peut pas recréer des brouillons déjà perdus. Conserver une archive de la version de code, la sauvegarde PostgreSQL habituelle et une sauvegarde protégée du profil OS avec son coffre ; copier le seul fichier SQLCipher ne suffit pas sans sa clé. Aucun export de clé en clair n’est proposé.

Retour arrière du code : revenir à la base avant 13-B `b761b852263dac12653c9329a0febb6dbf9b9dac`, conserver les fichiers chiffrés et leurs clés ; ne pas les ouvrir avec SQLite standard, ne pas supprimer les migrations historiques et ne pas réinitialiser PostgreSQL. L’ancien code n’interprète pas le checkpoint v3 ; une mise à niveau ultérieure doit conserver les fichiers et versions.
