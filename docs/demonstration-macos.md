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

### Choisir un mot de passe plus facile à retenir

Laisser le Terminal de lancement et Docker Desktop ouverts. Ouvrir **une autre fenêtre de Terminal** avec ⌘+N, puis exécuter depuis le dossier du projet :

```sh
pnpm demo:password
```

Choisir un mot de passe personnel de **12 caractères minimum**, puis le saisir une seconde fois pour confirmer. Une phrase facile à retenir convient. La saisie est masquée : aucun caractère ne s'affiche pendant que vous tapez. Ne pas mettre le mot de passe dans la commande ni dans le chat.

La première fois, la commande récupère l'ancien mot de passe dans le fichier privé : vous n'avez pas à le recopier. Elle vérifie le serveur de démonstration et utilise le changement authentifié de l'API. Après confirmation, se reconnecter dans CaissePro avec `CAISSEPRO-DEMO`, `admin@demo.caissepro.test` et le nouveau mot de passe. Les anciennes sessions de ce compte sont révoquées. Les cinq autres comptes conservent leur mot de passe initial.

Le nouveau mot de passe n'est pas enregistré dans le fichier d'accès. Ce fichier signale que l'administrateur utilise désormais un mot de passe personnalisé. Un changement ultérieur demande le mot de passe actuel de ce compte. Si le résultat réseau du changement est inconnu, essayer d'abord le nouveau mot de passe dans CaissePro ; aucun changement n'est rejoué automatiquement.

Si la commande s'arrête, le message précise désormais l'étape et le code HTTP, sans reprendre le contenu de la réponse serveur. Une erreur de **vérification de disponibilité** survient avant toute demande de mot de passe : vérifier le serveur et PostgreSQL avant de retenter un changement. Un code **503** indique que le serveur n'est pas prêt ; un code **404** signifie que la route attendue n'a pas été trouvée sur le port 3001. Pour un diagnostic sans mot de passe :

```sh
curl --max-time 5 -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:3001/api/v1/health/ready
docker compose ps
```

Ces commandes ne modifient ni les accès ni les données. Transmettre seulement leur résultat et le message d'erreur, sans fichiers privés ni mot de passe.

## 4. Arrêter et reprendre

Appuyer sur **Ctrl+C** dans Terminal pour arrêter le serveur de démonstration et le développement desktop. PostgreSQL et vos données sont conservés. Fermer la fenêtre seule peut laisser le processus de développement actif : utiliser Ctrl+C pour terminer la session.

Pour reprendre plus tard, ouvrir Docker Desktop puis exécuter :

```sh
cd "$HOME/CaissePro/GESTION-DE-CAISSE"
bash scripts/demo-macos.command
```

Si un ancien lancement conserve le port 3001 ou 1420, utiliser la commande d'arrêt ciblé avant de relancer :

```sh
pnpm demo:stop && bash scripts/demo-macos.command
```

`demo:stop` contrôle les deux ports, le programme Node, sa commande, son dossier de travail et son identité de processus. Il demande seulement l'arrêt gracieux des services API/Vite reconnus de cette copie du dépôt. Un processus d'un autre projet entraîne un refus avant tout signal. La commande attend aussi la fin du verrou du lanceur. Elle n'arrête pas PostgreSQL et ne réinitialise ni les données ni les mots de passe. Si l'arrêt gracieux échoue ou si un verrou reste présent, elle s'arrête avec un message explicite, sans suppression automatique.

La préparation réutilise la même base et conserve vos essais comptabilisés ou transmis. L’interface indique le mode de conservation des brouillons : les versions qualifiées de l’étape 13-B sur Apple Silicon utilisent SQLCipher et le trousseau macOS, au plus sept jours ; les versions en mémoire uniquement perdent encore les brouillons non transmis à la fermeture. Après redémarrage, un bail encore valide et un déverrouillage, ou une nouvelle authentification serveur, sont nécessaires. Voir [le bilan 13-B](etape-13b/BILAN.md). Ne pas supprimer les volumes Docker, `.env`, le dossier `scratch/caissepro-demo` ou son fichier `state.json`. Le fichier d'état contient des secrets de connexion ; ne pas le partager.

## En cas de blocage

Pour vérifier les prérequis sans installer de dépendances, démarrer de conteneur ou préparer de base :

```sh
bash scripts/demo-macos.command --check
```

- **Commande manquante** : installer le prérequis indiqué, puis ouvrir un nouveau Terminal.
- **Docker indisponible** : ouvrir Docker Desktop. Un contexte Docker distant est refusé. Choisir le contexte local dans Docker Desktop.
- **Port 3001 ou 1420 occupé** : terminer l'ancien lancement avec Ctrl+C, ou utiliser `pnpm demo:stop && bash scripts/demo-macos.command` pour les anciens services reconnus de ce dossier. Un processus inconnu reste protégé et doit être identifié séparément.
- **Port PostgreSQL 5432 déjà utilisé par un autre projet** : pour une première préparation, utiliser `bash scripts/demo-macos.command --db-port=5433`. Le lanceur met à jour uniquement le port de la connexion locale et `POSTGRES_PORT` dans `.env`, sans afficher ni remplacer les mots de passe. Le service reste lié à `127.0.0.1`. Les lancements suivants sans option conservent ce port. Le port choisi doit être libre. Une démo déjà préparée sur un autre port est refusée avant toute modification : diagnostiquer son déplacement en conservant les données. Ne pas arrêter ni supprimer la base de l'autre projet.
- **Configuration locale refusée** : conserver la configuration existante et utiliser une copie dédiée à la démo dans un autre dossier. Ne pas remplacer une configuration de serveur réel pour contourner ce contrôle.
- **Lancement précédent interrompu brutalement** : vérifier qu'aucune démo ne tourne encore. Seulement dans ce cas, retirer le verrou vide avec `rmdir "$HOME/CaissePro/scratch/caissepro-demo/lancement-macos.lock"`, puis relancer. Ne pas supprimer la base ou les fichiers d'état.
- **API indisponible** : son journal est dans `~/CaissePro/scratch/caissepro-demo/api-macos.log`. Ne pas transmettre de secrets ou tout le fichier sans vérification.
- **Arrêt du lanceur** : un Ctrl+C volontaire termine normalement. Un arrêt inattendu de l'API ferme la session de développement et indique le journal privé ; il ne doit plus être confondu avec une interruption demandée. Le lanceur Mac démarre directement son processus API et le suit jusqu'à son arrêt.
- **Échec de compilation ou d'ouverture** : transmettre le message d'erreur et préciser Apple Silicon ou Intel ainsi que la version de macOS. Ne pas désactiver les protections de macOS.

Les protections financières, les permissions et le verrou de qualification du stockage sensible restent actifs. Cette préparation ne constitue pas une qualification native macOS ; les tests Linux déjà effectués ne la remplacent pas.

## Mise à jour vers l’étape 12

Cette étape est sauvegardée sur la branche `feat/etape-12-multidevise`. Fermer la fenêtre CaissePro et arrêter l’ancien lanceur avant de changer de version. Depuis le dossier du projet :

```bash
pnpm demo:stop
git fetch origin
git switch feat/etape-12-multidevise
git pull --ff-only
bash scripts/demo-macos.command
```

Le serveur et le desktop doivent être actualisés ensemble : le protocole de compatibilité passe à 2. La préparation sauvegarde automatiquement la base locale existante avant toute migration en attente. Elle conserve les montants CDF/USD, les références, le port PostgreSQL et les comptes existants. Un échec de sauvegarde bloque la migration. Le mot de passe personnel déjà choisi reste valable.

Les sauvegardes privées se trouvent dans `../scratch/caissepro-demo/backups/` ; `pnpm demo:backup` permet aussi une sauvegarde explicite. Lire le [guide de migration et de retour arrière](etape-12/MULTIDEVISE.md) avant application à des données utilisées. Aucune réinitialisation, suppression de volume Docker ou création d’installateur n’est nécessaire.
