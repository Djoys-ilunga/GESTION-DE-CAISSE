# Authentification et autorisations — étape 3

## Ce qui est livré

La fenêtre Tauri comporte une connexion en français, le renouvellement obligatoire du mot de passe initial, le verrouillage, la déconnexion, les soldes autorisés, les brouillons privés, les affectations des utilisateurs et le journal des accès. NestJS authentifie chaque route privée et revalide les permissions. L’étape 3 ne créait pas de confirmation financière ; l’étape 4 ajoute le parcours d’encaissement décrit dans [encaissements.md](encaissements.md), avec permissions de lecture des reçus et configuration des caisses par administrateur.

L’aperçu `pnpm dev:web` permet d’examiner la présentation ; sa connexion est désactivée. L’authentification exige `pnpm dev` ou `pnpm dev:desktop` et le courtier natif Rust. Les tests React utilisent un double explicite de ce courtier. `pnpm test:auth:desktop` utilise réellement Rust, NestJS et PostgreSQL, sans piloter la fenêtre graphique.

## Créer le premier administrateur

Sur la machine **du serveur**, après installation des dépendances et configuration PostgreSQL :

```sh
pnpm setup:env
pnpm db:generate
pnpm db:up
pnpm db:deploy
```

Créer un fichier `initialisation-admin.local.json` à la racine du dépôt, ignoré par Git, en remplaçant les exemples par vos informations :

```json
{
  "companyCode": "MON-ENTREPRISE",
  "companyName": "Nom de votre entreprise",
  "adminEmail": "votre-adresse@votre-domaine.cd",
  "adminName": "Votre nom"
}
```

Le code contient 3 à 32 caractères : lettres majuscules, chiffres et tirets. Le fichier ne contient **aucun mot de passe**. Puis exécuter dans un terminal interactif :

```sh
pnpm setup:admin -- --config initialisation-admin.local.json
pnpm dev
```

La commande demande un mot de passe de 12 à 128 caractères, avec saisie masquée. Ne pas le transmettre dans le chat ni dans la ligne de commande. Elle crée l’entreprise, les six modèles de rôles, une agence et une caisse principales, leurs comptes USD/CDF et un administrateur. Aucun mouvement ni solde initial n’est inventé. Elle refuse une entreprise ou une adresse déjà enregistrée. À la première connexion, le mot de passe doit être renouvelé ; une nouvelle connexion est ensuite nécessaire.

La création initiale exige un compte de **provisionnement PostgreSQL**, distinct du compte API restreint en production. Ne jamais exécuter cette commande dans le desktop. Le fichier JSON peut être supprimé ensuite. Pour un gestionnaire de secrets ou les tests automatisés seulement, `--password-stdin` accepte le mot de passe sur l’entrée standard ; aucun fichier de mot de passe n’est requis. Aucun compte de démonstration ni mot de passe universel n’est installé automatiquement.

L’administrateur technique gère les utilisateurs et affectations. Pour travailler sur les brouillons, créer un utilisateur **Caissier** dans « Utilisateurs et accès », lui affecter l’agence et la caisse voulues, puis changer d’utilisateur. La création exige un mot de passe initial à renouveler. La liste est limitée à 200 utilisateurs et le journal aux 100 événements récents ; la pagination n’est pas livrée ici.

## Rôles et périmètres

Les six modèles sont fixes à cette étape ; un utilisateur peut cumuler plusieurs rôles. Les permissions de `packages/shared/src/auth.ts` sont installées en base et évaluées par le serveur. La présence d’un bouton ne confère aucun droit.

| Rôle                  | Permissions principales                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Administrateur        | Lecture, utilisateurs/affectations et journal ; aucune comptabilisation ou autorisation hors connexion par défaut |
| Directeur             | Lecture, approbation des dépenses, journal, consultation hors connexion                                           |
| Responsable financier | Lecture, brouillons, opérations financières internes, approbations, sessions de caisse et journal                 |
| Comptable             | Lecture, brouillons, encaissements, demandes de dépenses, transferts, conversions et contre-écritures internes    |
| Caissier              | Lecture, brouillons, encaissements, demandes/paiements approuvés et sessions de caisse internes                   |
| Auditeur              | Lecture, journal et consultation hors connexion ; aucune modification financière                                  |

Les droits s’appliquent uniquement à l’entreprise, aux agences et aux caisses affectées. Une caisse doit appartenir à une agence également affectée. Les changements de rôle, de périmètre ou d’activation incrémentent la version d’autorisation et révoquent les sessions concernées. Une mise à jour périmée est refusée. Le dernier administrateur actif ne peut pas être retiré. L’interdiction d’auto-approbation reste applicable même au responsable financier.

## Secrets et sessions

- Le mot de passe serveur est dérivé avec scrypt : `N=131072`, `r=8`, `p=1`, sel aléatoire de 16 octets, résultat de 64 octets, comparaison en temps constant. Les calculs simultanés sont bornés. Une identité inexistante suit aussi une vérification coûteuse ; le message d’erreur reste générique.
- Le serveur émet un jeton opaque aléatoire de 32 octets. Seule son empreinte SHA-256 est enregistrée en base. Durée absolue : 8 heures ; expiration après 15 minutes sans activité serveur. Le verrouillage local intervient après 5 minutes sans activité. Un déverrouillage en ligne fait tourner le jeton.
- Les tentatives sont limitées : 5 échecs par identité sur 15 minutes et 120 tentatives par adresse réseau sur 15 minutes. Les compteurs sont pseudonymisés par HMAC avec `AUTH_RATE_LIMIT_SECRET`, généré par `pnpm setup:env` et réservé au serveur. Ne pas remplacer un secret existant à chaque démarrage. Derrière un proxy de production, configurer explicitement les proxys de confiance et la limitation en amont.
- Rust conserve le jeton et le vérificateur de déverrouillage en **mémoire du processus**, avec effacement de leurs buffers à leur libération. React reçoit un profil et un état, jamais le jeton, une clé SQLCipher ou l’URL PostgreSQL. Les copies transitoires nécessaires à HTTPS/IPC ne sont pas présentées comme un effacement garanti de toute la mémoire du système.
- Les commandes Tauri sont limitées à des actions explicites, attachées à la fenêtre locale principale. Aucun proxy HTTP général, plugin SQL, système de fichiers ou shell n’est exposé au frontend. Les réponses sensibles ne sont pas mises en cache HTTP. Les journaux de sécurité contiennent des codes, dates et identifiants, sans mots de passe, jetons ni texte des dépenses.
- HTTPS, certificat valide, absence de redirection, identité de déploiement attendue et disponibilité PostgreSQL sont contrôlés. L’identifiant de déploiement est public ; il complète TLS. HTTP est permis uniquement sur loopback en développement natif debug. Avant un build distribué, fournir `VITE_API_BASE_URL` en HTTPS et `VITE_API_DEPLOYMENT_ID` dans l’environnement de compilation.

Les jetons ne sont volontairement **pas persistés** dans le magasin Windows/macOS à ce stade. La décision de stockage chiffré reste celle de [chiffrement-local.md](chiffrement-local.md) : SQLCipher Rust, clé aléatoire future dans Windows Credential Manager/macOS Keychain, qualification native encore requise. Aucun fichier sensible ni repli en clair n’est activé. La fermeture ou le redémarrage du processus nécessite une nouvelle connexion en ligne ; il n’existe pas de fonction « rester connecté ». La mémoire volatile n’est pas une garantie contre un système d’exploitation compromis, les dumps ou l’hibernation.

## Accès hors connexion

1. L’utilisateur doit avoir ouvert une session en ligne dans **le même processus** et posséder `offline:access`. Aucun premier accès ou changement d’utilisateur ne fonctionne hors connexion.
2. La perte de disponibilité de l’API verrouille l’accès. Le mot de passe de l’utilisateur déverrouille localement un vérificateur scrypt indépendant, avec sel aléatoire, gardé uniquement en RAM. Cinq échecs effacent la session et les données. Un premier mot de passe non encore renouvelé ne permet aucun accès hors connexion.
3. Le bail local expire au plus tard 15 minutes après la dernière validation serveur et avant l’expiration de session. L’activité ou les déverrouillages locaux ne le prolongent pas. Une horloge monotone empêche un recul de l’heure de prolonger ce délai. Le verrouillage automatique de 5 minutes reste actif.
4. Seuls les soldes déjà reçus et autorisés sont consultables ; la date, l’ancienneté et l’état non actualisé sont affichés. Les montants restent des chaînes exactes, séparées par devise. Les brouillons, UUID et versions sont gardés dans la session native ; leur durée est au plus 15 minutes. Ils sont perdus à la fermeture ou à l’effacement de sécurité.
5. Aucun mouvement financier définitif n’est possible hors connexion. Au retour du réseau, l’identité du serveur, la session et les permissions sont revalidées **avant** tout envoi. La synchronisation produit uniquement un brouillon central ; elle ne paie, n’approuve et ne comptabilise rien. Chaque résultat ou conflit est affiché.
6. Déconnexion, expiration, révocation connue et changement d’utilisateur effacent la session et ses données locales. Une modification de périmètre reçue du serveur invalide les caches concernés. Les générations natives et les séquences React rejettent les réponses tardives d’une ancienne session.

Une révocation survenue pendant une coupure est inconnue du poste jusqu’au retour réseau. Exemple : révocation à 10 h 03 après validation à 10 h 00 ; la consultation déjà autorisée peut subsister jusqu’à 10 h 15 au maximum, sous réserve des autres expirations et du déverrouillage. Elle cesse dès que la révocation est reçue. Une révocation immédiate à distance est impossible sans liaison ; les actions financières définitives restent bloquées pendant toute la coupure.

## Contrôles et limites réelles

```sh
pnpm check
pnpm test:db
pnpm test:session
pnpm test:auth:desktop
pnpm test:local
pnpm test:api:live
pnpm test:e2e
pnpm check:rust
```

`test:db` et `test:auth:desktop` créent puis suppriment leur propre base PostgreSQL locale `caissepro_test_…`. Ils exigent un compte de développement autorisé à créer des bases, jamais un serveur de production. Le second exige également la création d’un rôle PostgreSQL temporaire et Rust/Cargo : il utilise un LOGIN API NOINHERIT/NOBYPASSRLS distinct du provisionneur. L’outil synthétique reçoit le mot de passe sur stdin et vérifie l’API réelle, les affectations et révocations. Depuis l’étape 4, il vérifie aussi qu’un brouillon ne change pas le solde avant sa confirmation explicite, puis qu’un seul reçu et un seul mouvement sont créés après confirmation. Le rôle temporaire est supprimé après le test.

Les migrations 003 à 006 ajoutent les sessions, identifiants dérivés, droits de caisse, journal immuable et contraintes de périmètre. En production, le LOGIN API doit être sans propriété de tables, SUPERUSER, BYPASSRLS, CREATEDB ou CREATEROLE, avec NOINHERIT et appartenance à **`caissepro_auth_runtime` et `caissepro_runtime`**. Les transactions sélectionnent le rôle requis ; l’authentification ne reçoit aucun droit de comptabilisation. Migrations et provisionnement utilisent un compte séparé. Vérifier ce compte réel avant déploiement.

Le rapport [validation.md](validation.md) distingue PostgreSQL, le courtier réel, les doubles React, la fenêtre Linux et les qualifications Windows/macOS reportées. Aucun installateur signé, reprise hors connexion après redémarrage, récupération de mot de passe, MFA ou stockage sensible sur disque n’est annoncé comme vérifié à cette étape.
