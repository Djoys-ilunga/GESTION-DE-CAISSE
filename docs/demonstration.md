# Démonstration locale avec des données fictives

Sur **macOS**, commencer par le [guide de lancement local](demonstration-macos.md). Le lanceur `bash scripts/demo-macos.command` prépare l'API locale et ouvre la fenêtre native. Sa qualification sur un vrai Mac reste à effectuer.

Cette démonstration conserve une base PostgreSQL distincte `caissepro_demo_<UUID>`. Elle ne réinitialise pas la base de développement et ne contient aucune donnée réelle. Six comptes sont préparés : administrateur, direction, deux responsables financiers, caisse et audit. Chaque compte dispose des deux caisses fictives (CDF et USD). Les responsables financiers permettent d'essayer une remise puis une réception avec deux personnes distinctes.

## Préparation et accès

Depuis la racine : `pnpm db:up`, puis `pnpm demo:prepare`. La commande construit les sources, applique les migrations à une nouvelle base isolée et crée les données synthétiques. Les caisses sont ouvertes et chacune reçoit des écritures de fonds fictifs : `1000.00 USD` et `2800000.00 CDF`. Des plafonds de dépenses de démonstration sont définis. Relancer la préparation conserve les données et les identités ; aucune remise à zéro implicite n'est effectuée.

Les accès sont générés aléatoirement et conservés uniquement dans `../scratch/caissepro-demo/acces-prives.txt` par rapport à la racine du dépôt (`/workspace/scratch/caissepro-demo/acces-prives.txt` dans ce cloud), permissions 0600, hors Git. Ne pas les envoyer dans le chat. Code entreprise : `CAISSEPRO-DEMO`. Ces comptes ne sont pas des comptes par défaut de l'application et ne doivent jamais être créés sur une base réelle. Le fichier `state.json` voisin contient les connexions privées ; ne pas le partager.

`pnpm demo:start` démarre l'API sur le port local 3001. Son compte SQL est NOINHERIT, NOSUPERUSER, NOBYPASSRLS et sans droits de création de base/rôle. Les variables de la base de développement restent inchangées. Arrêter la commande avec Ctrl+C ferme uniquement cette API.

## Application native Linux

L'environnement actuel n'a ni sudo ni GTK/WebKit sur l'hôte. `tools/native/Dockerfile` prépare un conteneur Debian 13 avec les dépendances natives et Xvfb. La compilation doit utiliser Rust 1.90, les verrouillages Cargo et les deux réglages publics suivants :

```sh
export VITE_API_BASE_URL=http://127.0.0.1:3001
export VITE_API_DEPLOYMENT_ID=caissepro-demo
cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --features custom-protocol
```

Le lanceur cloud `pnpm demo:native` reproduit la préparation, la compilation et le démarrage. Il conserve un conteneur de démonstration déjà présent.

Dans le cloud, compiler dans le conteneur préparé avec le checkout et le cache Rust montés aux mêmes chemins, en tant qu'utilisateur 1000, puis exécuter `tools/native/run-demo.sh`. Le conteneur d'affichage doit appartenir au réseau Compose local de PostgreSQL, avoir accès à `/workspace` et disposer de Node 24. Le script démarre une API locale dans ce même conteneur et la relie au service Compose `postgres`, puis lance la vraie application sous Xvfb. Le bac à sable WebKit et les permissions Tauri restent actifs.

Le script produit `native-test-results/demo-login.png` et des journaux locaux. Cette capture n'est pas une session distante interactive. Le partage du bureau dépend des outils Desktop disponibles dans le chat. Les installateurs Windows/macOS restent à qualifier séparément.

## Parcours à essayer

- Compte caisse : consulter les fonds, préparer et confirmer un encaissement, consulter et imprimer son reçu.
- Compte caisse : préparer puis soumettre une dépense ; compte direction distinct : l'approuver ; compte habilité : confirmer le paiement et ouvrir son bon.
- Responsable financier source : préparer/transmettre un transfert et confirmer la remise ; second responsable : retrouver ce même transfert et confirmer la réception, puis consulter le bordereau.
- Essayer les deux devises et une conversion avec taux explicite. Une conversion n'est jamais une recette.
- Couper la disponibilité du serveur après une connexion antérieure autorisée : seuls les brouillons et consultations locales encore valides sont accessibles. Reconnecter, déverrouiller si nécessaire et retrouver les mêmes UUID. Ne jamais créer une nouvelle identité pour répéter une confirmation réseau incertaine.

## Sauvegarde de la base démo

`pnpm demo:backup:test` utilise `pg_dump` dans le conteneur PostgreSQL existant, conserve une archive privée et son SHA-256 hors Git, restaure dans une base au nom aléatoire, compare, sur un instantané transactionnel commun à la sauvegarde et aux lectures, toutes les lignes de toutes les tables publiques puis les indicateurs RLS et les propriétaires/configurations des fonctions. La base de restauration est supprimée à la fin ; la base démo est conservée.

Cette vérification concerne une restauration dans le même cluster, avec les rôles applicatifs existants. Un transfert vers un autre serveur exige aussi la préparation des rôles et des secrets, une restauration vérifiée et une copie sécurisée de l'archive hors de ce cloud. Une archive locale n'est pas une sauvegarde externe durable.

## Résultats vérifiés dans cette instance

La compilation Linux `custom-protocol` a réussi dans le conteneur avec le réseau désactivé et sans désactiver le bac à sable WebKit. Le démarrage de la fenêtre 1280×900, la connexion au vrai serveur avec le compte financier, la consultation des caisses et la préparation/transmission d’un brouillon fictif ont été contrôlés par captures. PostgreSQL contient un brouillon `DRAFT` et uniquement les quatre opérations initiales de fonds fictifs ; la transmission n’a créé aucun mouvement financier supplémentaire.

Les six comptes ont aussi été connectés individuellement à l’API réelle, avec contrôle des deux caisses et des montants exacts ; une remise a été refusée au rôle directeur dépourvu de `transfer:post`. Les sessions de ces contrôles API ont ensuite été fermées. La préparation a été relancée pour confirmer qu’elle conserve les données existantes.

Le contrôle natif a révélé une permission manquante : `transfer_action` était enregistrée dans le handler Rust, mais absente du manifeste générateur de permissions et de la capability de fenêtre. Les deux listes sont corrigées. `node --test tests/native/permissions.test.mjs`, inclus dans `pnpm test`, vérifie maintenant la cohérence de toutes les commandes déclarées et autorisées. Les tests API et doubles IPC ne remplaçaient pas ce contrôle natif.

Captures locales : `native-test-results/demo-login.png`, `demo-dashboard.png`, `demo-transfers.png`, `demo-draft.png`, `demo-transmitted.png`. Ces sorties sont ignorées par Git. Les outils de contrôle du bureau partagé n’étant pas exposés dans ce chat, ces preuves ne constituent pas une mise à disposition interactive du desktop à l’utilisateur.
