# Retrouver et sauvegarder les sources

Le dépôt durable est `https://github.com/Djoys-ilunga/GESTION-DE-CAISSE`, branche `main`. Une publication de l’environnement cloud sauvegarde sa configuration ; elle ne remplace pas un commit et un push des fichiers du projet.

Sur une machine ou un environnement neuf :

```sh
git clone https://github.com/Djoys-ilunga/GESTION-DE-CAISSE.git
cd GESTION-DE-CAISSE
git switch main
git log -3 --oneline
pnpm install --frozen-lockfile
pnpm setup:env
pnpm db:generate
```

Les secrets, bases et dépendances ne sont pas versionnés. Recréer `.env` localement avec `pnpm setup:env` ; ce script produit une configuration de développement et ne remplace pas un fichier existant. Consulter le README pour lancer PostgreSQL, appliquer les migrations et démarrer l’application.

Après des modifications vérifiées :

```sh
git status
git add <fichiers-voulus>
git diff --cached --check
git commit -m "Description du changement"
git push origin main
git rev-parse HEAD
git ls-remote origin refs/heads/main
pnpm backup
```

Les deux SHA doivent correspondre. `pnpm backup` archive uniquement le commit HEAD, avec une somme SHA-256, dans le dossier `scratch/caissepro-backups` à côté du checkout. L’archive exclut naturellement les fichiers non suivis et `.env` ; elle ne remplace donc pas le commit. Copier cette archive hors de l’environnement cloud pour une seconde sauvegarde durable, par exemple sur votre ordinateur. Une archive restée uniquement sur la même machine cloud peut elle aussi disparaître.

Vérification et extraction depuis le dossier des archives :

```sh
sha256sum -c caissepro-<SHA>.tar.gz.sha256
tar -tzf caissepro-<SHA>.tar.gz
mkdir projet-restaure
tar -xzf caissepro-<SHA>.tar.gz -C projet-restaure
```

macOS propose également `shasum -a 256`. L’archive Git contient les sources, sans historique `.git`. Utiliser le clone pour retrouver les commits. Cette version a été reconstruite à partir des spécifications : l’ancien checkout non sauvegardé n’a pas été récupéré à l’identique.
