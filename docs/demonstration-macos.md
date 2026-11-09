# Explorer CaissePro sur votre Mac

Ce parcours ouvre l'application native avec une base locale de démonstration. Il n'existe pas encore de site public de connexion ni d'installateur macOS signé prêt à télécharger. Le premier lancement compile l'application sur votre Mac et nécessite une connexion Internet. Cette procédure concerne uniquement des données fictives ; le lancement et l'impression macOS restent à vérifier sur un vrai Mac.

## 1. Installer les prérequis une seule fois

- [Node.js](https://nodejs.org/en/download) **24 LTS**, version 24.11 ou supérieure dans la branche 24.
- [Docker Desktop pour Mac](https://docs.docker.com/desktop/setup/install/mac-install/), version adaptée à votre processeur Apple Silicon ou Intel. Ouvrir Docker Desktop et attendre qu'il soit prêt.
- Les outils de développement Apple : ouvrir **Terminal** et exécuter `xcode-select --install`, puis terminer l'installation proposée par macOS. Ces outils fournissent aussi Git.
- [Rust via rustup](https://www.rust-lang.org/tools/install), puis exécuter `rustup toolchain install 1.90.0 --profile minimal` dans Terminal.
- Dans Terminal, installer la version du gestionnaire de paquets utilisée par le projet : `npm install --global pnpm@11.25.0`. En cas de problème de droits, utiliser une installation Node appartenant à votre utilisateur plutôt que lancer le projet avec `sudo`.

Les [prérequis officiels de Tauri pour macOS](https://v2.tauri.app/start/prerequisites/#macos) détaillent les outils Apple. Aucun outil système n'est installé automatiquement par le lanceur.

## 2. Récupérer et lancer le projet

Dans Terminal, copier ces commandes :

```sh
mkdir -p "$HOME/CaissePro"
cd "$HOME/CaissePro"
git clone https://github.com/Djoys-ilunga/GESTION-DE-CAISSE.git
cd GESTION-DE-CAISSE
bash scripts/demo-macos.command
```

Si GitHub demande une connexion, utiliser votre accès habituel au dépôt. Ne pas mettre de mot de passe ou de jeton dans la commande ni dans ce chat.

Si ce dossier existe déjà, ne pas relancer `git clone`. Ouvrir cette copie, préserver vos changements éventuels et utiliser le lanceur lorsqu'il est présent. Éviter d'utiliser un dossier configuré pour un vrai serveur : le lanceur refuse une connexion différente de la base Docker locale attendue.

La première compilation peut durer plusieurs minutes. Garder Terminal ouvert. Le lanceur installe les dépendances verrouillées, démarre PostgreSQL local, prépare une base séparée nommée `caissepro_demo_<identifiant>` et ouvre la fenêtre **CaissePro**. Il ouvre aussi votre fichier privé d'identifiants dans un éditeur de texte.

## 3. Se connecter dans la fenêtre CaissePro

- **Entreprise** : `CAISSEPRO-DEMO`.
- **E-mail** : `admin@demo.caissepro.test` pour explorer l'administration, ou `finance-source@demo.caissepro.test` pour les fonctions financières autorisées.
- **Mot de passe** : copier celui généré localement dans le fichier ouvert par le lanceur. Aucun mot de passe fixe n'est fourni.

Avec le dossier proposé ci-dessus, ce fichier est :

```text
~/CaissePro/scratch/caissepro-demo/acces-prives.txt
```

Pour le rouvrir depuis Terminal :

```sh
open -t "$HOME/CaissePro/scratch/caissepro-demo/acces-prives.txt"
```

Six profils et deux caisses sont disponibles. Chaque caisse reçoit initialement **1 000,00 USD** et **2 800 000,00 CDF** fictifs. Consulter le tableau de bord, changer de thème, explorer les rapports et l'administration, puis essayer les [parcours de démonstration](demonstration.md#parcours-à-essayer). Les droits restent différents selon les profils ; utiliser deux responsables financiers distincts pour remettre puis réceptionner un transfert.

L'API locale utilise le port 3001 et l'interface de développement le port 1420. L'accès fonctionnel se fait dans la fenêtre native CaissePro ; ouvrir le port 1420 dans Safari ne permet pas de se connecter.

## 4. Arrêter et reprendre

Appuyer sur **Ctrl+C** dans Terminal pour arrêter le serveur de démonstration et le développement desktop. PostgreSQL et vos données sont conservés. Fermer la fenêtre seule peut laisser le processus de développement actif : utiliser Ctrl+C pour terminer la session.

Pour reprendre plus tard, ouvrir Docker Desktop puis exécuter :

```sh
cd "$HOME/CaissePro/GESTION-DE-CAISSE"
bash scripts/demo-macos.command
```

La préparation réutilise la même base et conserve vos essais comptabilisés ou transmis. Les brouillons restés uniquement en mémoire sont perdus à la fermeture. Ne pas supprimer les volumes Docker, `.env`, le dossier `scratch/caissepro-demo` ou son fichier `state.json`. Le fichier d'état contient des secrets de connexion ; ne pas le partager.

## En cas de blocage

Pour vérifier les prérequis sans installer de dépendances, démarrer de conteneur ou préparer de base :

```sh
bash scripts/demo-macos.command --check
```

- **Commande manquante** : installer le prérequis indiqué, puis ouvrir un nouveau Terminal.
- **Docker indisponible** : ouvrir Docker Desktop. Un contexte Docker distant est refusé. Choisir le contexte local dans Docker Desktop.
- **Port 3001 ou 1420 occupé** : terminer l'ancien lancement avec Ctrl+C. Le lanceur ne tue aucun processus préexistant. Le port PostgreSQL 5432 doit aussi être disponible ou déjà utilisé par le service Compose de ce projet.
- **Configuration locale refusée** : conserver la configuration existante et utiliser une copie dédiée à la démo dans un autre dossier. Ne pas remplacer une configuration de serveur réel pour contourner ce contrôle.
- **Lancement précédent interrompu brutalement** : vérifier qu'aucune démo ne tourne encore. Seulement dans ce cas, retirer le verrou vide avec `rmdir "$HOME/CaissePro/scratch/caissepro-demo/lancement-macos.lock"`, puis relancer. Ne pas supprimer la base ou les fichiers d'état.
- **API indisponible** : son journal est dans `~/CaissePro/scratch/caissepro-demo/api-macos.log`. Ne pas transmettre de secrets ou tout le fichier sans vérification.
- **Échec de compilation ou d'ouverture** : transmettre le message d'erreur et préciser Apple Silicon ou Intel ainsi que la version de macOS. Ne pas désactiver les protections de macOS.

Les protections financières, les permissions et le verrou de qualification du stockage sensible restent actifs. Cette préparation ne constitue pas une qualification native macOS ; les tests Linux déjà effectués ne la remplacent pas.
