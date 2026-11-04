# CaissePro

Gestion de caisse d’entreprise : Tauri 2/Rust/React, NestJS, PostgreSQL et Prisma. Étapes 1 et 2 : socle technique et architecture des données. Aucun parcours financier public ni authentification utilisateur n’est encore livré.

Cette version est **reconstruite à partir des spécifications et traces de la conversation** après l’absence des fichiers dans une nouvelle instance cloud. Elle ne doit pas être présentée comme une restauration identique de l’ancienne copie. Les résultats de validation de cette reconstruction seront consignés dans `docs/validation.md`.

```text
apps/desktop       Interface française et application Tauri
apps/api           API, modèle Prisma, migrations et services internes
packages/shared    Contrats publics validés
packages/local-store  Adaptateur SQLCipher Rust avec verrou de qualification
docs               Architecture, chiffrement et résultats réels
```

Depuis la racine, avec Node 24 et pnpm 11.25.0 :

```sh
pnpm install --frozen-lockfile
pnpm setup:env
pnpm db:generate
pnpm db:up
pnpm db:deploy
pnpm dev
```

Pour l’interface seule : `pnpm dev:web`. Pour l’API seule : `pnpm dev:api`. Le contrôle public de disponibilité est `http://127.0.0.1:3000/api/v1/health/ready`. Il vérifie la connexion à la base, sans exposer de données financières. Le frontend de développement est `http://127.0.0.1:1420`.

Tauri nécessite Rust 1.90, les outils natifs Windows/MSVC/WebView2 ou Xcode sur macOS. SQLCipher/OpenSSL embarqués nécessitent aussi un compilateur C et Perl, avec NASM selon la cible Windows. Installer ces prérequis selon la [documentation Tauri](https://v2.tauri.app/start/prerequisites/). Sur Debian 13, le contrôle Linux nécessite notamment `build-essential`, `pkg-config`, `perl`, `libssl-dev`, `libgtk-3-dev`, `libwebkit2gtk-4.1-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev` et `patchelf`.

`pnpm build:desktop` prépare les bundles sur la machine cible ; les installateurs Windows/macOS et leur signature ne sont pas encore validés. Avant toute compilation distribuable, renseigner `VITE_API_BASE_URL` avec l’URL **HTTPS réelle** du serveur et `VITE_API_DEPLOYMENT_ID` avec son identifiant public attendu. Le réglage HTTP local de `.env.example` est réservé au développement Vite. Les variables `VITE_` sont publiques et ne doivent contenir aucun secret.

Vérifications : `pnpm check`, `pnpm test:db` (base PostgreSQL locale temporaire), `pnpm test:local` (Rust/SQLCipher), `pnpm test:e2e`, `pnpm check:rust`.

Pour Playwright, utiliser `pnpm exec playwright install chromium` si le téléchargement est autorisé. Un Chromium déjà installé peut être sélectionné avec `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` ; dans le cloud actuel : `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium pnpm test:e2e`. Les tests navigateur simulent les réponses de disponibilité ; ils ne constituent pas une session financière réelle. `pnpm test:db` crée puis supprime uniquement une base au nom aléatoire `caissepro_test_…`, avec un compte de développement autorisé à créer des bases. Ne jamais l’exécuter contre un serveur de production.

La persistance sensible reste interdite dans l’application : mémoire volatile, expiration et périmètres contrôlés. SQLCipher est testé sur des données synthétiques ; son ouverture publique reste bloquée jusqu’à qualification Windows/macOS et des clés natives. HTTPS est requis hors développement Vite sur loopback.

Les identifiants PostgreSQL n’appartiennent qu’au backend. `.env`, clés, bases et dépendances sont ignorés par Git. Ne pas utiliser `prisma db push` à la place des migrations SQL : elles portent les protections financières.

Après une sauvegarde GitHub, vérifier que le SHA de `main` distant correspond au commit local. `pnpm backup` crée aussi une archive des **seuls fichiers suivis par Git**, hors du checkout, avec empreinte SHA-256. Une publication cloud ne remplace pas cette sauvegarde.

Lire [l’architecture](docs/architecture.md), [la décision de chiffrement](docs/chiffrement-local.md), [les résultats vérifiés](docs/validation.md) et [la procédure de restauration](docs/restauration.md). Le workflow `Qualification du stockage local` fournit la matrice Windows/macOS ; son existence n’est pas une preuve de réussite. Aucun changement de configuration cloud n’est publié par ces commandes.
