# Environnement cloud utilisé pour les vérifications

La source se trouve dans `/workspace/GESTION-DE-CAISSE` et doit être récupérée depuis GitHub lorsqu’une instance est remplacée. Aucun changement de configuration cloud n’a été publié pendant cette reconstruction.

Outils observés : Node.js 24.22.1, pnpm 11.25.0, Git 2.52.0, Tauri CLI 2.12.4. Rust/Cargo 1.90.0 sont installés dans un répertoire de travail distinct ; ils ne font pas partie de l’archive des sources. Dans cette instance seulement, les activer avec :

```sh
export CARGO_HOME=/workspace/.toolchains/caissepro/cargo
export RUSTUP_HOME=/workspace/.toolchains/caissepro/rustup
export PATH="$CARGO_HOME/bin:$PATH"
rustc --version
cargo --version
pnpm test:local
```

Sur une autre machine, installer Rust avec les méthodes officielles avant d’exécuter les commandes du README. Le fichier `rust-toolchain.toml` fixe la version utilisée.

Le système hôte Linux ne possède pas les fichiers de développement GTK/WebKit requis par Tauri. Les vérifications Rust du desktop ont donc été lancées dans le conteneur local `caissepro-rebuild-check`, image `caissepro-native-check:latest`, avec GTK 3.24.49 et WebKitGTK 2.54.0, dépendances Cargo verrouillées et réseau du conteneur désactivé. Cette image locale n’est pas livrée dans le dépôt. Pour reproduire sur une autre machine Linux, installer les paquets de développement indiqués dans le README, puis exécuter `pnpm check:rust`. Le binaire réel a ensuite été compilé et sa fenêtre contrôlée sous Xvfb. Le test `tests/native/smoke-linux.sh` produit `native-test-results/caissepro-native.png` après vérification d’un rendu non vide ; aucun bac à sable WebKit n’a été désactivé. Pour reproduire ce contrôle, installer aussi `xvfb`, `xauth`, `dbus-x11` et les en-têtes X11. La compilation par Cargo exige d’avoir exécuté `pnpm build` pour embarquer les fichiers frontend.

Le frontend navigateur et l’API fonctionnent sur loopback avec `pnpm dev:web` et `pnpm dev:api`. L’installation d’un Chromium supplémentaire a été refusée par la politique réseau ; `/usr/bin/chromium` était disponible et a servi aux deux tests navigateur. Aucun accès Internet global n’a été activé.

PostgreSQL est fourni par Docker sur `127.0.0.1:5432`. Les tests créent une base temporaire distincte puis la suppriment, sans réinitialiser la base de développement. Les variables PostgreSQL restent dans `.env` ignoré par Git. Un clone de restauration a généré sa propre configuration locale et n’a pas reçu une copie des secrets du premier checkout.

La bibliothèque chiffrée reste bloquée dans l’application. Les résultats Linux, les tests navigateur et une compilation TypeScript ne valident pas les installateurs ou magasins de clés Windows/macOS. Consulter le rapport de validation et les résultats du workflow natif dans GitHub Actions avant toute décision d’activation.
