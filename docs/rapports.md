# Étape 8 — Tableau de bord et rapports financiers

Le tableau de bord et la rubrique **Rapports** interrogent le serveur avec la session native. Aucune statistique de démonstration n'est embarquée dans les écrans. Les données de la base de démonstration restent identifiées par le nom de l'entreprise « DONNÉES FICTIVES ». Un serveur indisponible n'est jamais remplacé par des chiffres simulés. Hors connexion, les rapports et exports sont désactivés ; la consultation locale autorisée des autres modules conserve ses règles propres.

## Indicateurs et périmètre

Le serveur vérifie `ledger:read`, la session et les affectations actuelles d'agence et de caisse dans une transaction sérialisable. Les demandes de caisse/agence non autorisées sont refusées, y compris pour les exports. Les identités ne sont jamais acceptées dans le corps de requête comme preuve d'authentification.

- Solde, réservé et disponible de chaque caisse et total du **périmètre autorisé**, séparément en CDF et USD. Le disponible inclut les réservations de dépenses et de transferts en cours de remise.
- Encaissements/décaissements du jour : opérations `RECEIPT`/`DISBURSEMENT`, nettes de leurs contre-écritures. Les transferts, conversions et leurs contre-écritures ne sont pas des recettes/dépenses.
- Demandes en attente : demandes `PENDING` actuelles, en nombre et montant par devise ; une approbation ne compte pas comme un paiement.
- Trésorerie : soldes de fin de journée calculés avec toutes les écritures de trésorerie du périmètre, y compris transferts, conversions et corrections. Le solde d'ouverture vient de toutes les écritures antérieures. Aucun jour futur n'est projeté ; le solde de clôture d'une période en cours est le dernier solde observé, pas une prévision.
- Écarts : comptages physiques réellement enregistrés à la clôture, nombre de PV présentant un écart et écart net par devise. L'absence de comptage est `null` et affichée **Non mesuré**, jamais transformée en écart nul. Des écarts opposés peuvent se compenser dans le net ; les PV individuels restent consultables.
- Journal : une ligne par écriture sur un compte de trésorerie ; les contreparties techniques ne sont pas ajoutées. Une opération de transfert peut donc apparaître deux fois si les deux caisses sont autorisées. Références comptables, acteur et sens sont conservés.

Les montants sont calculés avec PostgreSQL numeric et Decimal à 60 chiffres, puis échangés en chaînes exactes. Les totaux globaux peuvent dépasser la taille d'un montant d'opération sans passer par un flottant JavaScript. Les graphes utilisent les centimes entiers pour normaliser la position visuelle ; aucun solde affiché n'est recalculé dans React.

Les cartes journalières et les soldes/courbes reflètent les caisses choisies. Les filtres utilisateur, catégorie et type concernent le journal et ses regroupements ; ils ne transforment pas une sélection partielle d'écritures en un faux solde bancaire. Le filtre utilisateur des demandes/décisions désigne le demandeur. Les PV sont filtrés par caisse/agence et période.

## Périodes et rapports

Le fuseau métier est explicitement **Africa/Kinshasa (UTC+1)**. Le jour commence à minuit local et la borne supérieure est exclusive au minuit suivant. La semaine commence le lundi. Mois et années sont calendaires, avec années bissextiles. Une période personnalisée est limitée à 366 jours et son début ne peut pas se situer dans le futur.

Rapports disponibles : journal de caisse ; périodes quotidienne, hebdomadaire, mensuelle, annuelle ou personnalisée ; regroupements par catégorie, agence et acteur ; décisions de dépenses approuvées/rejetées selon leur date de décision ; PV et écarts de clôture. Les catégories proviennent des reçus existants. Les dépenses et anciens mouvements sans catégorie sont explicitement indiqués comme non catégorisés ; aucune catégorie métier n'est déduite du texte libre.

Les filtres sont appliqués après **Appliquer**. Le journal propose une recherche de consultation et des pages de 25 mouvements. La devise et la recherche locales ne changent pas le périmètre des fichiers exportés. Le calendrier appliqué est renvoyé avec sa date de référence pour éviter qu'un export à minuit ne bascule involontairement sur un autre mois.

## Clôture avec comptage et PV

Un utilisateur `session:manage` peut sélectionner une session ouverte, saisir les USD et CDF **physiquement comptés** et confirmer explicitement la clôture. Le serveur verrouille les comptes et la session, refuse les réservations encore actives, ferme la session et crée le PV dans la même transaction. Une défaillance annule tout. Le comptage ne crée pas d'écriture et ne corrige jamais le solde : l'écart reste un constat, à traiter par les procédures comptables autorisées.

Changer de caisse efface les montants comptés et l'attestation ; actualiser les sessions efface aussi la sélection. Il faut refaire le comptage et confirmer la session choisie. Une réponse de catalogue arrivée après un changement de contexte est ignorée : aucun ancien comptage n'est réaffecté à une nouvelle session.

Le PV fige le nom de caisse, le responsable, la date, la référence unique, le solde comptable et les montants comptés par devise. SQL construit l'instantané, vérifie les droits/périmètres et empêche mise à jour/suppression. La clé de session déduplique les reprises ; un autre comptage ou un autre auteur sur une clôture déjà enregistrée est refusé. Après une réponse réseau incertaine, consulter d'abord les PV ; ne pas ouvrir une nouvelle session pour répéter aveuglément une clôture.

Les anciennes sessions fermées sans comptage sont signalées séparément. Ce module ne leur attribue ni comptage rétroactif ni écart fabriqué. Le PV atteste le comptage déclaré par l'utilisateur, pas une mesure matérielle automatique.

## Exports et impression

PDF et Excel sont générés **par le serveur** à partir d'un nouveau relevé autorisé avec les mêmes filtres appliqués. L'heure portée sur le document fait foi ; de nouvelles opérations peuvent être incluses entre l'affichage et l'export. Tous les mouvements de la période sont exportés, pas seulement la page visible du journal.

Le PDF contient l'identité réelle d'entreprise, les dates, le fuseau, les filtres, les synthèses par devise, journal, regroupements, décisions et PV. La police DejaVu Sans est embarquée pour conserver les accents ; sa licence est dans `apps/api/assets/DejaVu-LICENSE.txt`. Lors du déploiement de l'API, conserver `apps/api/assets` à côté de `dist`.

Le classeur `.xlsx` contient des feuilles Identite, Synthese, Ecarts, Journal, Evolution, Regroupements, Decisions et Clotures avec en-têtes, filtres et volets figés. Les montants sont des **chaînes décimales exactes**, pas des nombres Excel susceptibles de perdre des chiffres. Les textes sont des cellules de texte ; aucune formule n'est construite à partir d'un nom ou motif. Pour les calculs externes, conserver les devises séparées et utiliser des outils décimaux adaptés.

Le courtier natif télécharge le fichier puis ouvre le dialogue système PDF/Excel. Seul l'emplacement explicitement choisi est écrit ; l'annulation ne crée rien. La génération et la session sont revérifiées, puis la session serveur est revalidée après le dialogue, avant écriture. Aucun plugin générique de fichiers, shell ou accès disque automatique n'est ouvert à React. Les exports sont des copies durables volontairement demandées par l'utilisateur, distinctes du cache sensible hors connexion qui reste désactivé.

**Imprimer la vue** utilise les styles d'impression du rapport actuellement visible. Les tableaux répètent leur en-tête et les styles sont isolés avec une page nommée : ils ne changent pas les reçus ou bons des modules précédents. L'export PDF reste le moyen d'obtenir l'intégralité du rapport. Les dialogues et impressions Windows/macOS sont prévus par les API natives, mais leur qualification sur ces systèmes reste à faire.

## Limites de volume explicites

Un relevé accepte au plus 10 000 écritures de trésorerie, 10 000 décisions et 1 000 PV ; la réponse JSON est bornée à 10 Mo. Un fichier est limité à 1,3 Mo avant base64. Au-delà, le serveur refuse avec `REPORT_TOO_LARGE` : réduire la période ou sélectionner une agence/caisse. Il ne tronque jamais un total ou un fichier en silence. Les exports massifs asynchrones ne sont pas inclus dans cette étape.

## Routes et vérification

`GET /api/v1/reports`, `/reports/pdf` et `/reports/xlsx` acceptent `period`, `date`, `from`, `to`, `agencyId`, `cashRegisterId`, `userId`, `category`, `kind`. Aucun `companyId` ou acteur affirmé n'est admis. `POST /api/v1/reports/close` exige les UUID de caisse/session, `confirmed: true`, `countedUSD` et `countedCDF` sous forme de chaînes à deux décimales.

Vérifications : `pnpm check`, `pnpm test:db`, `pnpm test:session`, `pnpm test:auth:desktop`, `pnpm test:local`, `pnpm test:api:live`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium pnpm test:e2e`, compilation et Clippy Tauri Linux dans le conteneur natif. La migration 14 est additive et conserve toutes les protections historiques.
