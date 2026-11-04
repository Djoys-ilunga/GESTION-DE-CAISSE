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

Pour l’interface seule : `pnpm dev:web`. Pour l’API seule : `pnpm dev:api`. Tauri nécessite Rust 1.90, les outils natifs Windows/MSVC/WebView2 ou Xcode sur macOS. SQLCipher/OpenSSL embarqués nécessitent aussi un compilateur C et Perl, avec NASM selon la cible Windows.

Vérifications : `pnpm check`, `pnpm test:db` (base PostgreSQL locale temporaire), `pnpm test:local` (Rust/SQLCipher), `pnpm test:e2e`, `pnpm check:rust`.

La persistance sensible reste interdite dans l’application : mémoire volatile, expiration et périmètres contrôlés. SQLCipher est testé sur des données synthétiques ; son ouverture publique reste bloquée jusqu’à qualification Windows/macOS et des clés natives. HTTPS est requis hors développement Vite sur loopback.

Les identifiants PostgreSQL n’appartiennent qu’au backend. `.env`, clés, bases et dépendances sont ignorés par Git. Ne pas utiliser `prisma db push` à la place des migrations SQL : elles portent les protections financières.

Après une sauvegarde GitHub, vérifier que le SHA de `main` distant correspond au commit local. `pnpm backup` crée aussi une archive des **seuls fichiers suivis par Git**, hors du checkout, avec empreinte SHA-256. Une publication cloud ne remplace pas cette sauvegarde.
