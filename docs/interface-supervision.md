# Étape 9 — Interface, administration et supervision

L’interface française regroupe la navigation en Pilotage, Opérations, Supervision et Administration. Les rubriques sans autorisation sont retirées du menu. Les tableaux et formulaires se réorganisent selon la taille de la fenêtre ; les onglets restent défilables dans une fenêtre étroite. Les actions sensibles d’administration et les seuils d’approbation présentent une confirmation explicite avant tout appel de modification.

## Apparence et documents

Le sélecteur Apparence propose Système, Clair et Sombre. Il suit le thème du système lorsque ce choix est actif. La seule valeur éventuellement conservée dans Web Storage est `caissepro.appearance` : aucun compte, montant, brouillon, jeton ou rapport n’y est stocké. Une indisponibilité de ce stockage empêche seulement la mémorisation du thème.

Les documents officiels conservent une prévisualisation sur papier blanc. Les styles d’impression remettent aussi les rapports et le journal d’audit en clair, puis masquent navigation, notifications et sélecteur de thème. Reçus, bons, bordereaux et PV restent liés à leur source serveur ; le répertoire Documents ouvre leurs rubriques respectives. Les exports PDF et Excel sont produits sur le serveur ; le dialogue natif écrit uniquement le fichier volontairement choisi. Les autorisations, le périmètre et la génération de session sont revérifiés après ce dialogue. Un changement de droits ou de caisses entraîne le refus de l’écriture du fichier préparé.

Le code utilise des API desktop communes Windows/macOS et les contrôles web natifs. Les builds et parcours manuels Windows/macOS restent à qualifier sur ces systèmes. Les preuves disponibles dans cet environnement sont Linux et Chromium ; une capture navigateur avec IPC simulé ne constitue pas une preuve d’exécution native.

## Tableau de bord et notifications

Les soldes, mouvements, courbes, demandes et écarts gardent les calculs de l’[étape 8](rapports.md), avec CDF et USD séparés. La supervision ajoute l’état actif/désactivé et l’ouverture de session de chaque caisse effectivement autorisée. Les administrateurs peuvent aussi consulter l’état des utilisateurs affectés à ces caisses et leurs sessions serveur valides. Une session valide ne prouve pas une présence en temps réel. Les autres rôles ne reçoivent pas ces informations sur les utilisateurs.

Les notifications internes viennent exclusivement de l’API : dépenses en attente, transferts remis mais non reçus, écarts réellement déclarés sur les PV des trente derniers jours. Elles ne signifient ni paiement ni correction comptable. Le serveur renvoie le total et vingt événements récents au plus ; masquer une notification ne vaut ni résolution ni validation et ne concerne que la session courante. La supervision est actualisée chaque minute ; une erreur retire les informations précédentes et signale l’indisponibilité.

## Administration

La permission `cash:configure` réserve les paramètres à l’administration de l’entreprise. Les transactions relisent la session et les permissions courantes. Les mises à jour utilisent une version attendue ; un conflit exige une actualisation.

- **Entreprise** : raison sociale, adresse, téléphone, courriel et identification fiscale. Le code demeure fixe. Les rapports reprennent l’identité courante ; les reçus, bons, bordereaux et PV déjà figés conservent leurs instantanés.
- **Agences** : création, renommage et état actif. La désactivation est refusée tant que des caisses de l’agence sont actives. Les identifiants et codes existants ne sont pas réaffectés.
- **Caisses** : configuration et affectations existantes, sans création de soldes modifiables.
- **Utilisateurs** : création, recherche et filtre d’état ; affectation de rôles standards, agences et caisses. Les changements d’accès révoquent les sessions concernées et le dernier administrateur actif reste protégé. L’éditeur signale les affectations d’agences ou de caisses désactivées et les retire uniquement de la proposition à confirmer. La liste comporte au plus 200 utilisateurs ; ses filtres portent sur cette liste.
- **Rôles et permissions** : consultation des permissions réellement installées sur le serveur et affectation des rôles standards. Cette étape ne crée pas un éditeur arbitraire de permissions personnalisées.
- **Catégories** : création, renommage et désactivation, avec code et usage stables. Le catalogue actif est proposé en ligne pour les encaissements et dépenses. Les libellés existants ne sont pas renommés rétroactivement. La saisie libre de brouillon reste possible ; la catégorie des dépenses historiques est explicitement « Dépenses non catégorisées ». Une catégorie de dépense soumise est immuable.
- **Seuils** : plafonds exacts par rôle, action et devise, justificatifs et confirmation des changements. Les règles existantes de réservation et d’approbation restent obligatoires.
- **Taux** : références publiées, append-only, avec source et date d’application. Les cinquante références les plus récentes sont présentées ; les taux futurs sont exclus des suggestions avant leur date d’application. Aucun calcul monétaire en flottant et aucune conversion automatique. La remise impose toujours la validation explicite du taux retenu.
- **Sessions** : durée absolue de 15 à 480 minutes, inactivité serveur de 1 à 15 minutes et accès hors connexion de 0 à 15 minutes. La durée hors connexion ne peut dépasser l’inactivité. Zéro désactive l’accès hors connexion. Le verrouillage local de cinq minutes reste une limite supplémentaire. Modifier ces durées révoque toutes les sessions de l’entreprise, y compris celle de l’administrateur ; le courtier natif ferme immédiatement la session qui reçoit cette confirmation.

## Journal d’audit

Le journal métier et le journal des connexions sont distincts. La permission `auth:logs:read` autorise leur consultation ; le journal métier filtre également les caisses/agences affectées. Il affiche les événements déjà collectés : écritures comptabilisées, demandes et décisions de dépenses, paiements, configuration, nouvelles ouvertures/clôtures de caisse et étapes des nouveaux transferts. Les événements absents de l’historique ne sont pas reconstruits artificiellement.

Les événements détaillés d’un transfert exigent l’accès à ses deux caisses, comme son historique. Le solde disponible d’une caisse continue néanmoins d’intégrer les réservations réelles, même quand l’utilisateur ne peut plus consulter le transfert lui-même.

Le journal métier est paginé par cinquante événements, avec filtres de dates, caisse et action. Les événements de configuration d’entreprise sont visibles hors filtre de caisse ; les brouillons ne sont visibles que par leur auteur. Les UUID servent de références traçables ; aucune donnée brute de mot de passe ou jeton n’est exposée. Les événements sont immuables en SQL et sont créés dans la même transaction que l’action métier ; les reprises idempotentes ne créent pas un nouvel événement.

Les exports PDF/Excel portent sur tous les événements autorisés des filtres appliqués, et non sur la seule page affichée. Le relevé est recomputé dans une transaction sérialisable. Au-delà de 10 000 événements ou de 1,3 Mo par fichier, l’export est refusé explicitement. L’impression porte sur la page affichée. Les textes Excel restent des chaînes, même si un libellé commence par `=`.

## Hors connexion et sécurité

L’indicateur Hors connexion est permanent. La dernière synchronisation connue est affichée lorsqu’elle est disponible ; sinon l’interface le dit sans inventer de date. L’accueil hors connexion peut consulter les soldes temporaires déjà autorisés dans la session native, accompagnés de leur date de lecture et du libellé « anciens ». Il ne reconstitue aucun solde ou rapport à partir de brouillons. Les brouillons et le centre de synchronisation conservent leurs protections des étapes précédentes.

Les paramètres, la supervision, les notifications sensibles et le journal d’audit sont retirés hors connexion. Les réponses tardives d’un ancien chargement sont ignorées. Aucun rapport sensible n’est persisté localement : la qualification du stockage protégé Windows/macOS reste obligatoire avant toute activation. Aucun plugin générique de fichiers, SQL ou shell n’est ouvert au frontend.

## Migration et vérification

La migration additive 15 `20261109000200_management` ajoute les champs d’identité et de politique, les versions d’agence, le catalogue, les références de taux et la catégorie des dépenses. Elle conserve les quatorze migrations précédentes. Une comparaison avant/après vérifie les comptes de lignes et empreintes de dix tables financières dans les bases de développement et de démonstration ; seul le nouveau champ de catégorie est exclu de l’empreinte historique des dépenses.

Vérifications : `pnpm check`, `pnpm test:db`, `pnpm test:session`, `pnpm test:local`, `pnpm test:api:live`, `pnpm test:auth:desktop`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium pnpm test:e2e`, `pnpm format:check`, `pnpm db:validate`, compilation et Clippy Tauri Linux. Les résultats observés sont détaillés dans [validation.md](validation.md).
