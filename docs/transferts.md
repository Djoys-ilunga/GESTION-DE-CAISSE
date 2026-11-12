# Étape 7 — Transferts internes et conversions

## Circuit et responsabilités

La rubrique **Transferts et conversions** distingue quatre actions :

1. **Préparer** une proposition dans le courtier natif, avec UUID stable, caisse source, caisse destination, devises, montant exact et motif. Pour une conversion, saisir également le taux et sa source.
2. **Transmettre ou retrouver** cette proposition après connexion. Le serveur revalide la session, les deux périmètres, les comptes, le montant calculé et les fonds disponibles. Il conserve une copie `DRAFT` sans réservation ni écriture. La transmission ne constitue jamais une remise ou une réception.
3. L’auteur confirme explicitement la **remise effective**. Le serveur revalide ses autorisations et les sessions de caisse ouvertes, verrouille les comptes dans un ordre stable, vérifie le disponible et réserve le montant source. État `HANDED_OVER`, version 2. Les fonds remis sont indisponibles pour toute autre dépense ou transfert ; le solde comptable source n’est pas encore débité et la destination n’est pas créditée.
4. **Un autre utilisateur autorisé** confirme explicitement la réception effective du montant de destination. Dans une seule transaction sérialisable : validation des droits, des caisses et des sessions ouvertes, création des écritures, consommation de la réservation et émission de l’instantané immuable du bordereau. État `RECEIVED`, version 3. Une défaillance annule la totalité de la réception ; les fonds restent réservés.

La remise exige `transfer:post` sur les deux caisses ; une conversion exige aussi `fx:post`. Ces permissions restent attribuées par défaut aux responsables financiers et comptables. La préparation utilise les permissions existantes de brouillon et exige l’affectation aux deux caisses. L’administrateur n’obtient pas automatiquement le pouvoir de comptabiliser. Les caissiers peuvent préparer ; un opérateur autorisé doit être l’auteur du brouillon serveur pour confirmer sa remise. Les sessions sont ouvertes via le module Caisses par un utilisateur habilité. Les mêmes contrôles de périmètre protègent la lecture de l’historique. Les révocations sont revérifiées dans les transactions.

Les deux confirmations matérialisent la validation du mouvement ; aucun nouveau circuit d’approbation préalable distinct n’est ajouté. Le taux et le montant destination doivent être explicitement acceptés lors de la remise d’une conversion. Le réceptionnaire voit les mêmes valeurs figées.

## Devises, précision et écritures

- CDF → CDF et USD → USD : deux caisses distinctes, deux écritures de même montant, crédit source / débit destination, opération `TRANSFER`.
- CDF → USD et USD → CDF : les caisses peuvent être distinctes ou identiques. Une seule caisse à deux devises reste une seule caisse, et une conversion interne reste possible.
- Le taux signifie **unités de destination pour une unité de source**. Aucun taux implicite, automatique ou inversé n’est appliqué. Source du taux obligatoire. Le taux proposé est figé dans la copie serveur puis validé lors de la remise par un utilisateur ayant `fx:post`.
- Montants en chaînes à deux décimales, positifs, au plus `9999999999999999.99`. Taux décimal positif, au plus douze chiffres avant et douze après la virgule. Les entrées utilisent le point décimal (`20.00`), l’affichage est français.
- Calcul à 60 chiffres de précision : `destination = montant_source × taux`, **un seul arrondi final HALF_UP à deux décimales**. Exemple : `1.00 USD × 2800.125 CDF/USD = 2800.13 CDF`. Les résultats nuls après arrondi et les dépassements de capacité sont refusés.
- La conversion produit une opération `FX` à quatre écritures : crédit trésorerie source / débit contrepartie source, puis débit trésorerie destination / crédit contrepartie destination. L’équilibre est exact dans chaque devise. Le montant avant arrondi est reproductible à partir du montant d’origine et du taux figés ; aucun écart n’est ajouté à un solde flottant.
- Les contreparties techniques `CLEARING` ne constituent pas des recettes. Aucun `CashReceipt`, aucun justificatif de vente et aucune opération `RECEIPT` ne sont créés par ce circuit. Les rapports de recettes doivent sélectionner les opérations `RECEIPT`, et non sommer indistinctement les comptes de contrepartie.

Les contraintes SQL historiques restent actives : sessions, droits, équilibres, précision numérique, fonds disponibles, audit comptable, scellement et immutabilité des écritures. La migration 13 est additive ; elle préserve les douze précédentes.

## Concurrence, idempotence et journal

Les comptes sont verrouillés par identifiant trié. Les transactions sont sérialisables avec les reprises bornées existantes. L’UUID du brouillon est réutilisé comme clé d’idempotence comptable. Une retransmission identique retrouve la même copie ; un UUID réutilisé avec un contenu différent est refusé. Les remises/réceptions répétées avec leur version initiale et le même acteur retrouvent le résultat sans nouveau mouvement. Une réponse réseau incertaine exige de retrouver ce même UUID dans l’historique, jamais de recréer un transfert pour le confirmer de nouveau.

L’ordre serveur est figé dès transmission : montants, taux, devises, comptes, motif et auteur ne peuvent plus être changés. Une correction avant remise exige une nouvelle proposition explicite ; le brouillon initial reste sans effet financier. La réception est irréversible dans ce module ; les corrections comptables restent des contre-écritures liées et autorisées.

Le bordereau porte une référence unique `TRF-<entreprise>-<UUID>`. Noms d’entreprise, agences, caisses, remettant et réceptionnaire, dates, montants, taux, motif et référence comptable sont conservés, indépendamment des futurs renommages. L’API retourne cet instantané uniquement après comptabilisation. Le desktop permet son impression ou son export PDF via le dialogue système. L’historique est paginé par 25, trié avec identifiant de départage.

Les réservations de transferts sont incluses dans `AvailableFunds` même lorsqu’un autre opérateur de la caisse source n’a pas accès à la destination. L’agrégat utilise une fonction `SECURITY DEFINER` à propriétaire dédié `caissepro_transfer_reader` **NOLOGIN, NOSUPERUSER, NOBYPASSRLS**, uniquement autorisé à lire les réservations du tenant courant sous RLS forcée. Elle ne retourne aucune description ni identité de transfert. Le rôle d’exécution API reste sans héritage, sans superutilisateur et sans contournement RLS dans le test intégré.

## Mode hybride et limites

Les préparations utilisent les buffers du courtier, avec quota partagé de vingt saisies et conservation maximale de sept jours. Sur les cibles qualifiées à l’étape 13-B, elles sont chiffrées dans SQLCipher et récupérables après fermeture ; sur les autres cibles, elles restent temporaires en mémoire. Une saisie devient conservée après **Conserver le brouillon**. « Reprendre la préparation » conserve son UUID et impose une nouvelle vérification serveur du taux de conversion en ligne. Après une transmission incertaine, l’instantané initial est conservé à l’identique et se retrouve sur le même UUID, sans écriture financière automatique. Le centre de synchronisation ouvre le module de transfert pour reprendre ses préparations. Voir [le bilan 13-B](etape-13b/BILAN.md).

Le catalogue de caisses peut provenir d’un instantané autorisé, daté et marqué non actualisé hors connexion. Aucun montant destination n’est ajouté localement au solde. La transmission après reconnexion est **manuelle** depuis la page Transferts. Les synchronisations automatiques des étapes précédentes n’envoient aucune remise ni réception. Le courtier refuse les actions de transfert en ligne lorsque la session est hors connexion/verrouillée, et vérifie la génération pour rejeter les réponses tardives. La copie locale est conservée même après transmission, jusqu’à suppression explicite ou expiration, pour préserver les reprises et les corrections en cours. Une interruption réseau peut verrouiller la session ; déverrouiller puis retrouver le même UUID.

Un transfert remis ne peut pas être annulé automatiquement ou libéré par expiration : les fonds ont été déclarés physiquement remis. En cas d’absence de réception, de perte des fonds ou de révocation d’un intervenant, le montant reste réservé et exige résolution par les responsables habilités. Ce module n’invente pas une réception et ne propose pas encore un circuit de retour physique/annulation d’un transfert remis. Une interruption après remise ne rend donc jamais ces fonds disponibles silencieusement.

La qualification des installateurs Windows/macOS et des magasins de clés reste distincte des validations Linux/API/Chromium. La portée exacte du stockage natif activé et ses preuves sont consignées dans le bilan 13-B ; les installateurs signés restent hors de cette étape.

## API et vérification

- `POST /api/v1/transfers/drafts` : proposition stricte et idempotente.
- `GET /api/v1/transfers?page=1&state=HANDED_OVER` : historique filtré et paginé.
- `GET /api/v1/transfers/:id` : détail et éventuel bordereau.
- `POST /api/v1/transfers/:id/handover` : `{ expectedVersion: 1, handedOver: true, rateValidated: true }`.
- `POST /api/v1/transfers/:id/receive` : `{ expectedVersion: 2, received: true }`.

Depuis la racine : `pnpm db:generate`, `pnpm check`, `pnpm test:db`, `pnpm test:session`, `pnpm test:auth:desktop`, `pnpm test:local`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium pnpm test:e2e`. Activer d’abord Rust selon `docs/environnement-cloud.md`. Les tests PostgreSQL utilisent exclusivement des bases locales jetables. Les tests Chromium utilisent un double IPC déclaré ; le test intégré Rust/API/PostgreSQL utilise les composants réels.
