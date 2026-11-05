# CaissePro

Gestion de caisse d’entreprise : Tauri 2/Rust/React, NestJS, PostgreSQL et Prisma. Étapes 1 à 3 : socle technique, données centrales, authentification et autorisations desktop. Les opérations financières de l’étape 2 restent des services internes ; aucun parcours de confirmation financière n’est ajouté ici.

Cette version est **reconstruite à partir des spécifications et traces de la conversation** après l’absence des fichiers dans une nouvelle instance cloud. Elle ne doit pas être présentée comme une restauration identique de l’ancienne copie. Les résultats de validation de cette reconstruction seront consignés dans `docs/validation.md`.

```text
apps/desktop       Interface française et application Tauri
apps/api           API, modèle Prisma, migrations et services internes
packages/shared    Contrats publics validés
packages/local-store  Adaptateur SQLCipher Rust avec verrou de qualification
packages/session-core  Courtier natif de sessions, cache et brouillons en RAM
docs               Architecture, chiffrement et résultats réels
```

Depuis la racine, avec Node 24 et pnpm 11.25.0 :

```sh
pnpm install --frozen-lockfile
pnpm setup:env
pnpm db:generate
pnpm db:up
pnpm db:deploy
```

Créer ensuite le premier administrateur avec la [procédure d’authentification](docs/authentification.md#créer-le-premier-administrateur), puis lancer `pnpm dev`. Aucun compte ou mot de passe par défaut n’est installé. L’administrateur gère les rôles et affectations ; créer un caissier autorisé pour travailler sur les brouillons.

Pour l’interface seule : `pnpm dev:web` (aperçu visuel, connexion désactivée sans Tauri). Pour l’API seule : `pnpm dev:api`. Le contrôle public de disponibilité est `http://127.0.0.1:3000/api/v1/health/ready`. Il vérifie la connexion à la base, sans exposer de données financières. Le frontend de développement est `http://127.0.0.1:1420`.

Tauri nécessite Rust 1.90, les outils natifs Windows/MSVC/WebView2 ou Xcode sur macOS. SQLCipher/OpenSSL embarqués nécessitent aussi un compilateur C et Perl, avec NASM selon la cible Windows. Installer ces prérequis selon la [documentation Tauri](https://v2.tauri.app/start/prerequisites/). Sur Debian 13, le contrôle Linux nécessite notamment `build-essential`, `pkg-config`, `perl`, `libssl-dev`, `libgtk-3-dev`, `libwebkit2gtk-4.1-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev` et `patchelf`.

`pnpm build:desktop` prépare les bundles sur la machine cible ; les installateurs Windows/macOS et leur signature ne sont pas encore validés. Avant toute compilation distribuable, renseigner `VITE_API_BASE_URL` avec l’URL **HTTPS réelle** du serveur et `VITE_API_DEPLOYMENT_ID` avec son identifiant public attendu. Le réglage HTTP local de `.env.example` est réservé au développement Vite/Tauri debug sur loopback. Les variables `VITE_` sont publiques et ne doivent contenir aucun secret.

Vérifications : `pnpm check`, `pnpm test:db` (base PostgreSQL locale temporaire), `pnpm test:session` (sessions Rust), `pnpm test:auth:desktop` (courtier Rust/API/PostgreSQL réels sur base temporaire), `pnpm test:local` (Rust/SQLCipher), `pnpm test:e2e`, `pnpm check:rust`, `pnpm test:api:live` (API compilée et base de développement).

Pour Playwright, utiliser `pnpm exec playwright install chromium` si le téléchargement est autorisé. Un Chromium déjà installé peut être sélectionné avec `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` ; dans le cloud actuel : `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium pnpm test:e2e`. Les tests navigateur simulent les réponses de disponibilité ; ils ne constituent pas une session financière réelle. `pnpm test:db` crée puis supprime uniquement une base au nom aléatoire `caissepro_test_…`, avec un compte de développement autorisé à créer des bases. Ne jamais l’exécuter contre un serveur de production.

Sous Linux avec GTK/WebKit, Xvfb et un compilateur C, vérifier aussi la vraie fenêtre après compilation :

```sh
cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --features custom-protocol
pnpm test:native:linux
```

La capture et les journaux sont dans `native-test-results/`, distinct des résultats Playwright et ignoré par Git. Ce contrôle attend un rendu non vide ; les installateurs Windows/macOS restent à qualifier.

La persistance sensible reste interdite dans l’application : jetons, brouillons et caches autorisés en mémoire native uniquement, expiration et périmètres contrôlés. Une reconnexion en ligne est nécessaire après redémarrage. L’accès hors connexion exige une session antérieure, un déverrouillage local et expire au plus après quinze minutes. SQLCipher est testé sur des données synthétiques ; son ouverture publique reste bloquée jusqu’à qualification Windows/macOS et des clés natives. HTTPS est requis hors développement sur loopback.

Les identifiants PostgreSQL n’appartiennent qu’au backend. `.env`, clés, bases et dépendances sont ignorés par Git. Ne pas utiliser `prisma db push` à la place des migrations SQL : elles portent les protections financières.

Après une sauvegarde GitHub, vérifier que le SHA de `main` distant correspond au commit local. `pnpm backup` crée aussi une archive des **seuls fichiers suivis par Git**, hors du checkout, avec empreinte SHA-256. Une publication cloud ne remplace pas cette sauvegarde.

Lire [l’authentification et le premier administrateur](docs/authentification.md), [l’architecture](docs/architecture.md), [la décision de chiffrement](docs/chiffrement-local.md), [les résultats vérifiés](docs/validation.md), [la procédure de restauration](docs/restauration.md) et [les particularités du cloud actuel](docs/environnement-cloud.md). Le workflow `Qualification du stockage local` vérifie SQLCipher, les sessions natives, les magasins de clés et la compilation du desktop sur Windows/macOS ; son existence n’est pas une preuve de réussite. Aucun changement de configuration cloud n’est publié par ces commandes.
