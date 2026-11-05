# Synchronisation sécurisée — étape 6

Le courtier Rust transmet uniquement des brouillons au serveur central. Une copie reçue reste **non comptabilisée**. L’encaissement exige sa confirmation de réception effective ; une dépense exige encore sa soumission explicite, une décision par un autre utilisateur autorisé, puis son paiement explicite. Le moteur ne possède aucune file de confirmations, approbations ou paiements à rejouer.

## Connexion et identité

L’application vérifie toutes les quinze secondes, ainsi qu’aux événements réseau et de retour au premier plan, la disponibilité de l’API. Le signal réseau de l’appareil ne suffit pas. Le courtier vérifie HTTPS et les certificats système, refuse les redirections, contrôle le service `caissepro-api`, le protocole et l’identifiant de déploiement configuré. HTTP est limité au loopback en compilation de développement. Les réponses ont des tailles et délais bornés. Une erreur d’identité ou un accusé malformé efface la session locale.

Avant un lot, le courtier revalide la session et ses permissions auprès du serveur. Les jetons restent dans Rust. Un changement de rôle, de version d’autorisation ou de périmètre purge les brouillons, captures et caches, et incrémente la génération de session : une commande ou réponse tardive ne peut alimenter l’utilisateur suivant. Les permissions et périmètres sont aussi vérifiés par l’API et les transactions PostgreSQL.

Une perte de réseau verrouille une session en ligne. Un utilisateur préalablement autorisé doit la déverrouiller localement et reste limité par son autorisation hors connexion, au plus quinze minutes. Une révocation encore inconnue de l’appareil reste possible pendant cette fenêtre ; elle ne permet aucun traitement financier définitif et est appliquée lors de la revalidation suivante.

## Responsabilités du stockage

| Emplacement                       | Contenu et durée                                                                                                  | Effet financier                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Session native Rust               | Brouillons privés, captures de champs incomplets, instantanés autorisés et métadonnées temporaires ; durée bornée | Aucun calcul ni modification du solde officiel                                 |
| PostgreSQL `ImportedDraft`        | Copie de travail reçue, UUID client, identifiant serveur et révision                                              | Aucun mouvement financier à l’importation                                      |
| PostgreSQL `SyncEvent`            | Identifiants, versions, dates et codes de tentative propres à l’auteur                                            | Journal append-only, sans montant, motif, bénéficiaire, justificatif ou secret |
| Écritures et opérations centrales | Transactions financières explicites existantes                                                                    | Seule source des soldes officiels                                              |

**La persistance sensible sur disque reste interdite.** L’adaptateur SQLCipher existant a des tests Linux, mais sa qualification Windows/macOS et des magasins de clés n’est pas acquise. Le moteur n’ouvre ni SQLite, ni Web Storage, ni fichier pour conserver ces données. Aucun repli en clair n’est ajouté. Voir [chiffrement-local.md](chiffrement-local.md).

Fermer l’application efface donc les brouillons et champs **non reçus** par le serveur. Le redémarrage ne restaure pas une session hors connexion. Après une nouvelle connexion en ligne, le centre permet de consulter puis restaurer expressément les copies déjà reçues. Un envoi dont l’accusé a été perdu peut ainsi être retrouvé par son UUID. La reprise durable des brouillons jamais transmis reste bloquée par la qualification du chiffrement ; elle n’est pas annoncée comme disponible.

## Cycle d’un brouillon

Chaque brouillon possède un UUID stable, une version locale, la dernière version serveur connue, des dates de création/modification, une expiration et, après réception, un identifiant serveur distinct. Les états sont :

- **Local** : enregistré dans la session, non transmis.
- **En attente de synchronisation** : nouvelle révision ou reprise réseau différée.
- **En cours** : une transmission détient le verrou du moteur.
- **Synchronisé** : l’accusé valide correspond à la révision envoyée.
- **Conflit** : la version serveur diffère ou la source est devenue définitive.
- **Erreur** : données refusées ou limite des reprises atteinte, intervention nécessaire.

Les indicateurs « encaissement confirmé » et « demande soumise » reflètent uniquement un état central obtenu après action explicite. Ils ne rendent pas le brouillon à nouveau transmissible. Une correction locale plus récente qu’un état final reste visible en conflit et ne remplace pas les données comptabilisées.

Un seul lot s’exécute à la fois. L’envoi conserve un instantané exact (UUID, version, données, base serveur et dates). Si l’utilisateur modifie son brouillon pendant la transmission, l’accusé met à jour la version serveur connue et conserve la correction locale en attente. Si la réponse est perdue, la reprise réutilise d’abord l’instantané incertain ; elle n’invente aucun nouvel UUID.

Les erreurs de transport suivent des délais de 5, 15, 60, 180 et 300 secondes, avec au plus cinq tentatives avant intervention. Un quota serveur impose au moins soixante secondes d’attente. Le serveur limite les tentatives à trente par minute et par entreprise/utilisateur, y compris pour l’ancien format du protocole. Une remise en attente explicite ne contourne pas cette limite. Les erreurs et conflits ne sont pas renvoyés automatiquement.

## Correction et reprise

Le centre affiche les six compteurs, les identifiants et versions, la dernière transmission réussie, la date d’actualisation du cache, les copies centrales, les conflits et les journaux. Les dates locales consultées hors connexion sont signalées comme non actualisées. Les manifestes centraux sont paginés par cinquante ; le journal présente au plus cent événements récents et la dernière réussite connue.

Une erreur de saisie peut être corrigée puis remise en attente. Pour un conflit, l’utilisateur choisit explicitement de remplacer sa copie par celle du serveur, ou de conserver sa correction avec une nouvelle révision basée sur la version serveur actuelle. Le choix local est refusé si la source a déjà été confirmée ou soumise. Une restauration conserve l’UUID, la date d’origine et la version serveur tout en donnant à la copie locale une nouvelle autorisation temporaire de consultation. Pour les anciens brouillons sans dates client, la date de réception serveur sert de référence documentée.

Après réception, le moteur actualise les consultations de soldes et de caisses autorisées. Si cette actualisation échoue, le brouillon reste reçu : un avertissement indique que les consultations doivent être actualisées. L’importation ne calcule aucun solde.

Les champs incomplets des formulaires sont capturés dans la mémoire native après une courte temporisation de 100 ms, avec un maximum de vingt saisies par session et une expiration bornée. L’indicateur « saisie capturée » permet de savoir si la capture a abouti ; les derniers caractères encore en cours de capture peuvent être perdus lors d’un verrouillage immédiat. Les captures ne font pas partie des brouillons transmis. Après déverrouillage, « Saisies interrompues » permet de reprendre le même UUID, de compléter les champs puis d’enregistrer le brouillon. Les fichiers non encore enregistrés doivent être sélectionnés de nouveau. La capture est supprimée après cet enregistrement ou une annulation explicite, et disparaît aux mêmes événements de sécurité que la session.

## API et migration

- `POST /api/v1/workspace/drafts/sync` : enveloppe v2 avec dates client ; réponse avec identifiant serveur, version, date et état central. L’ancien format conserve son accusé historique, ses protections et la limitation de tentatives.
- `GET /api/v1/workspace/sync/manifest?page=1` : copies de l’auteur dans son périmètre courant.
- `GET /api/v1/workspace/sync/drafts/:clientUuid` : copie détaillée pour restauration ou résolution explicite.
- `GET /api/v1/workspace/sync/events` : journal de l’auteur.

La migration additive `20261105000600_secure_synchronization` ajoute deux dates nullables à `ImportedDraft` et le journal `SyncEvent`. Elle ne réécrit aucun mouvement financier. RLS forcée, contrôles de contexte, immutabilité du journal et unicité du résultat final par tentative protègent la base ; les dates d’origine deviennent immuables lorsqu’elles sont renseignées. Les anciennes migrations ne sont pas modifiées. Ne pas remplacer ces protections par `prisma db push`.

## Exécution et vérification

Depuis un environnement configuré selon le README, générer le client Prisma, appliquer les migrations sur la base choisie et démarrer l’API et le desktop : `pnpm db:generate`, `pnpm db:deploy`, `pnpm dev`. Les identifiants de base restent exclusivement côté API.

Consulter [validation.md](validation.md) pour les contrôles effectivement exécutés. Les tests PostgreSQL utilisent des bases jetables ; les tests Chromium simulent explicitement le transport IPC. Le parcours intégré utilise le vrai courtier Rust et NestJS/PostgreSQL. La fenêtre Linux vérifie le lancement et le rendu, sans remplacer une qualification graphique complète sur Windows/macOS.
