# CaissePro — frontières des données

Cette reconstruction couvre les fondations des étapes 1 et 2. L’authentification, les routes métier publiques et l’activation des saisies desktop restent à développer dans une étape autorisée ultérieurement.

| Élément                        | PostgreSQL central                      | Stockage local                          |
| ------------------------------ | --------------------------------------- | --------------------------------------- |
| Vérité financière              | Unique autorité                         | Aucune                                  |
| Montants                       | `numeric(18,2)` ; taux `numeric(24,12)` | Chaînes décimales exactes               |
| Soldes                         | Vues calculées depuis les écritures     | Consultation datée autorisée uniquement |
| Encaissements / dépenses       | Opérations explicites et autorisées     | Brouillons uniquement                   |
| Persistance actuelle           | PostgreSQL                              | Mémoire volatile                        |
| Persistance chiffrée candidate | Sans objet                              | SQLCipher Rust, porte publique fermée   |

Le modèle Prisma relie entreprises, agences, utilisateurs, appartenances, rôles, permissions, droits d’agence, caisses, comptes par devise, sessions, opérations, écritures, dépenses, approbations, réservations, transferts, taux, justificatifs, audit et brouillons importés. Les clés étrangères composites empêchent de relier des objets d’entreprises ou de devises différentes.

Une opération comporte au moins deux écritures et doit être équilibrée par devise. Un débit augmente un compte de trésorerie ; un crédit le diminue. Les comptes CLEARING/EQUITY servent de contreparties techniques : cette fondation de trésorerie n’est pas un plan comptable réglementaire complet. Les conversions comportent quatre écritures équilibrées séparément en USD et CDF. L’arrondi cible est au centime, à mi-chemin en s’éloignant de zéro (`ROUND_HALF_UP`), avec un taux immuable, daté et traçable.

Le produit montant × taux utilise 60 chiffres de précision pour couvrir les 18 chiffres du montant et les 24 chiffres du taux sans arrondi intermédiaire. PostgreSQL recalcule le produit exact et vérifie le résultat au commit. Le test de grande conversion protège notamment `9007199254740993.01 × 0.500000000255 = 4503599629667332.31` après arrondi au centime.

`AccountBalance` calcule le solde à partir du grand livre. `AvailableFunds` soustrait les réservations actives. Une approbation réserve des fonds sans changer le solde ; le paiement consomme la réservation et comptabilise un mouvement dans la même transaction. Une seconde personne disposant de la permission requise doit approuver la demande. Il n’existe pas de champ de solde à mettre à jour.

Les services utilisent des transactions SERIALIZABLE, un verrouillage ordonné des comptes et une reprise bornée des conflits de sérialisation. Les UUID d’idempotence et les empreintes canoniques distinguent la répétition identique d’une clé réutilisée avec un autre contenu. Les déclencheurs différés vérifient l’opération complète au commit et annulent toute transaction incohérente. Un mouvement ne reçoit plus d’écriture après sa transaction initiale. Toute correction se fait par une unique opération de contre-écriture liée, jamais par UPDATE/DELETE du grand livre.

Les contraintes SQL sont des migrations versionnées, complémentaires de Prisma. Ne pas les remplacer par `prisma db push`. Les vues utilisent `security_invoker`, les tables d’entreprise imposent RLS et les fonctions vérifient les utilisateurs actifs, les permissions et l’accès à chaque agence concernée. `CentralAccess` configure le rôle restreint et le contexte uniquement dans la transaction. Les services attendent un contexte issu d’une authentification serveur future : ne jamais exposer `companyId`/`userId` client comme preuve d’identité. Aucune route métier publique n’est créée à cette étape.

## Connexion et synchronisation

Le contrôle de disponibilité appelle réellement `/api/v1/health/ready`, vérifie son contrat et l’identifiant de déploiement attendu, avec délai, absence de cache et refus des redirections. HTTPS vérifie le certificat du nom de serveur ; l’identifiant public du déploiement est un contrôle supplémentaire, pas un secret ou une authentification. HTTP est limité au loopback en développement. La configuration de production doit définir un serveur HTTPS réel et un identifiant attendu explicite. Aucun certificat n’est ignoré. La présence d’Internet ou `navigator.onLine` ne suffit pas.

Le coordinateur de synchronisation est une fondation injectable sans transport authentifié actif. Il transmet l’UUID, la révision locale et la dernière version serveur connue ; il écarte un résultat tardif après changement de session ou modification du brouillon. Le serveur déduplique et détecte les conflits de version. Un brouillon importé reste un brouillon : aucune demande de dépense, opération comptabilisée ou confirmation de paiement n’est créée par sa synchronisation. Les résultats sont codés, sans recopier une erreur serveur sensible.

L’interface présente l’état réseau et des informations d’installation réelles ; elle n’invente aucun solde ni session. La saisie sensible et la consultation financière restent indisponibles sans authentification. Les caches autorisés sont signalés non actualisés et bornés à quinze minutes au maximum, ainsi qu’à l’expiration de l’autorisation. Changement de périmètre, déconnexion, révocation et événement de sécurité devront déclencher l’effacement via l’intégration de session future.

## Exploitation PostgreSQL

Le compte Docker local sert uniquement au développement et aux migrations. En production, utiliser un compte de migration distinct et un LOGIN API sans SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB ni droits de propriétaire. Lui accorder l’appartenance au rôle `caissepro_runtime` pour `SET LOCAL ROLE` ; employer NOINHERIT et tester le rôle réel. Ne jamais donner au desktop l’URL PostgreSQL. Conserver la configuration API dans le gestionnaire de secrets du serveur, avec TLS PostgreSQL adapté à l’hébergeur. La migration du rôle exige un administrateur de base ; cela ne justifie pas d’exécuter l’API en administrateur.

Les administrateurs de base peuvent toujours altérer le schéma : RLS et les déclencheurs protègent le compte applicatif, pas une compromission de l’administration. Prévoir sauvegardes chiffrées, contrôle des accès administrateurs, audit externe et essais de restauration avant production. Les justificatifs sont des métadonnées contrôlées ; aucun téléversement, antivirus ou service de fichiers n’est annoncé opérationnel ici. L’audit stocke des codes et des identifiants, pas le texte libre des dépenses ni des secrets.
