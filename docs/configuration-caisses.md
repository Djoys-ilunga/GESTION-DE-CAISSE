# Une ou plusieurs caisses dans la même application

## Architecture déjà disponible

Le modèle multicaisse accepte déjà une entreprise avec une seule caisse. La commande de création du premier administrateur initialise une agence et une caisse principales, avec des comptes CDF et USD distincts. Il n’existe aucune obligation de créer une deuxième caisse.

L’adaptation conserve ce modèle, les neuf migrations existantes et les services financiers. Aucun indicateur « mode monocaisse », migration, regroupement de comptes, recalcul de solde ou réécriture de mouvement n’est ajouté.

## Configuration par l’administrateur

Pour démarrer avec une seule caisse, conserver la caisse principale et modifier son nom dans **Caisses → Configuration des caisses** si nécessaire. Affecter explicitement les utilisateurs et leurs rôles dans **Utilisateurs**. Une caisse unique n’accorde aucun droit supplémentaire et conserve ses fonds CDF/USD séparés.

Pour agrandir l’entreprise, utiliser **Créer la caisse** à tout moment et, si nécessaire, créer une autre agence. Les nouvelles affectations nécessitent une reconnexion des utilisateurs concernés, comme auparavant. Les comptes, reçus, écritures et numéros existants sont conservés ; les nouveaux comptes commencent à zéro.

Ne pas supprimer ou fusionner d’anciennes caisses pour obtenir un écran simplifié. Leur désactivation existante bloque les nouveaux encaissements tout en conservant les soldes et l’historique autorisés.

## Simplification automatique de l’interface

- **Encaissement :** lorsqu’une seule caisse active est autorisée, afficher son nom et son agence sans demander un choix inutile. La devise CDF/USD reste toujours sélectionnable.
- **Historique :** masquer le filtre de caisse s’il ne présente qu’un seul choix. Conserver ce filtre dès que plusieurs caisses sont consultables, y compris une ancienne caisse désactivée.
- **Configuration :** lorsqu’une seule agence est disponible, afficher son nom au lieu d’un sélecteur. Les formulaires de création d’agence et de caisse restent accessibles à l’administrateur.
- **Ajout de choix :** réafficher les sélecteurs automatiquement sans réinitialiser les champs saisis ni déplacer le brouillon vers une nouvelle caisse ou agence. Une caisse devenue indisponible n’est jamais remplacée silencieusement par une autre.
- **Soldes :** afficher « Votre caisse » lorsqu’une seule caisse est consultable ; conserver l’affichage distinct des deux devises et les informations de session.

Ces choix reposent sur le **périmètre autorisé**, pas sur un nombre global d’entreprise révélé à tous les utilisateurs. Un utilisateur affecté à une seule caisse bénéficie aussi de cette simplicité dans une entreprise multicaisse. Aucun nouvel accès à une autre caisse n’en découle. Un catalogue vide ne crée aucune affectation implicite.

Les choix qui restent utiles sont préservés : permissions et affectations explicites, devises, filtres de période et de catégorie, confirmation de réception effective, ainsi que l’option de brouillon de dépense sans caisse. La simplification n’altère pas le workflow d’approbation.

À l’étape 4, **aucun écran de transfert entre caisses n’est exposé**, en monocaisse ou multicaisse. Il n’y a donc pas de bouton existant à masquer ni de nouveau module de transfert à développer pour cette adaptation. Les services internes de transfert, conversion, dépense et fermeture restent présents et leurs tests de régression sont conservés ; aucune nouvelle interface de décaissement ou de clôture n’est annoncée ici.

## Contrôles

Les tests React vérifient les choix uniques/multiples, l’arrivée différée du catalogue, la conservation de la saisie à l’ajout d’une caisse ou d’une agence, l’absence de réaffectation implicite, les filtres d’anciennes caisses et la création d’une nouvelle caisse depuis une configuration initiale unique.

Les tests sur PostgreSQL réel exercent les encaissements CDF/USD, le refus de dépense sans approbation et d’auto-approbation, le paiement approuvé, l’ouverture et la fermeture de session dans les deux configurations. Un test compare les opérations, écritures, reçus et compteurs avant/après ajout de la deuxième caisse : ils restent identiques. Il vérifie aussi qu’un utilisateur demeurant affecté à une seule caisse ne reçoit toujours que celle-ci.

Commandes : `pnpm check`, `pnpm test:db`, `pnpm test:e2e`, compilation Tauri et contrôle de fenêtre Linux. Les essais PostgreSQL utilisent uniquement une base temporaire, supprimée ensuite ; aucune modification de la base financière de développement n’est nécessaire à l’adaptation.

Le mode hybride conserve ses limites : session préalable, déverrouillage, permissions, données datées, expiration et aucune confirmation financière hors connexion. Les brouillons locaux restent en mémoire temporaire, sans persistance sensible sur disque. Les qualifications Windows/macOS et des magasins de clés restent à effectuer, comme indiqué dans [encaissements.md](encaissements.md) et [validation.md](validation.md).
