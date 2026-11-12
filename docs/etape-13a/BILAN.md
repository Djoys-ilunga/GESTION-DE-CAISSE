# Étape 13-A — accès financiers et navigation

Travaux du 12 novembre 2026, branche `feat/etape-13a-permissions-navigation`, à partir de `a23ce0dd288600c24015e0dff144445a6d196539`.

## Diagnostic et choix retenus

Le RBAC existant gère déjà plusieurs rôles par membre d’entreprise (`MemberRole`), leur union de permissions et les affectations d’agence et de caisse (`AgencyGrant`, `CashRegisterGrant`). Il ne fallait pas ajouter les droits financiers au rôle Administrateur. Aucun rôle par défaut, contrat API, service comptable, schéma ou migration n’a été changé.

`AdminService.updateAccess` exige `users:manage` et `roles:assign`, vérifie l’entreprise, les agences et les caisses actives, leur rattachement, la version des accès et le maintien d’un administrateur actif. Une modification explicite révoque les sessions du destinataire et incrémente sa version d’autorisation. Une attribution à soi-même exige donc une reconnexion ; elle n’accorde aucun droit dans la session déjà ouverte. Les tests de cette étape emploient les rôles standard installés par `installRoles`, après retrait du rôle spécial de la fixture.

La politique d’attribution existante reste applicable : un administrateur habilité à affecter des rôles peut explicitement cumuler Administrateur et un rôle métier, selon la politique de son entreprise. L’étape n’ajoute pas de droit implicite, de nouvelle délégation ou de contournement des contrôles financiers. L’auto-approbation reste interdite, même avec plusieurs rôles.

## Interfaces livrées

| Module        | Changement et traitement réutilisé                                                                                                                                                                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Encaissements | **+ Nouvelle entrée** ouvre le formulaire existant. Le bouton reste visible et explique un rôle manquant ou l’absence de caisse active affectée. La transmission demeure distincte de la confirmation de réception et du reçu serveur.                                                                                                                         |
| Dépenses      | **Nouvelle demande de dépense** figure dans l’en-tête, y compris depuis la liste des demandes. Le circuit Préparer → Soumettre → Approuver → Payer indique les droits de la session. **Voir les demandes en attente de validation** applique le filtre serveur `PENDING`, sans inventer un compteur.                                                           |
| Transferts    | **Nouveau transfert** et **Nouvelle conversion** utilisent le même formulaire et les services existants. Une nouvelle préparation remplace une saisie seulement après confirmation. Annuler la conserve. La conversion choisit deux devises actives distinctes, sans changer une opération existante ; le raccourci est interdit avec une seule devise active. |
| Caisses       | L’ouverture reste disponible via l’API existante. Le bouton de clôture mène à **Rapports → Clôtures et écarts** ; le journal mène au rapport filtré sur l’identifiant exact de la caisse. Les actions interdites sont désactivées et expliquées.                                                                                                               |
| Clôture       | Le raccourci conserve la caisse. Le bouton **Préparer une clôture avec comptage** relit les sessions serveur, sans clôturer. Il présélectionne seulement cette caisse si sa session est encore accessible. Sinon, il explique le refus, sans substituer une autre caisse. Comptage et attestation restent obligatoires.                                        |
| Utilisateurs  | Explication de la séparation technique/finance, accès **Examiner mes rôles et affectations**, sélection cumulative existante, aperçu des droits proposés, confirmation et avertissement de révocation. Les actions d’attribution exigent aussi `roles:assign` dans l’interface.                                                                                |
| Rôles         | Lien direct **Gérer les attributions** vers Utilisateurs ; libellé français de l’autorisation de taux manuel.                                                                                                                                                                                                                                                  |

Les écrans utilisent les styles et thèmes existants. Les messages des boutons désactivés sont visibles et associés par `aria-describedby`. Les menus et raccourcis ne remplacent aucune autorisation native ou serveur.

## Contrôles serveur réutilisés

- Encaissements : `CashController` / `CashService`, brouillon de l’auteur, attestation, session ouverte, atomicité et idempotence de la confirmation.
- Dépenses : `ExpensesController` / `ExpensesService`, plafonds par rôle et devise, refus `SELF_APPROVAL_FORBIDDEN`, réservation à l’approbation et paiement confirmé séparément.
- Transferts/conversions : `TransfersController` / `TransfersService`, permissions distinctes de préparation et d’exécution, périmètre des deux caisses, fonds disponibles, taux explicite et réception par un autre utilisateur.
- Sessions/journal : `CashService`, `ReportsService`, transactions, RLS et périmètres serveur. Le rapport reçu est filtré par la caisse demandée.
- Administration : `AdminController` / `AdminService`, permissions cumulées explicites, validation des affectations, contrôle de version, journalisation et révocation.

Un caissier peut préparer un transfert sans disposer du droit de remettre ou recevoir les fonds. Ce découpage existant est conservé. Le formulaire indique cette distinction.

## Multidevise, BCC et mode hybride

Les devises proviennent du catalogue de l’entreprise et des préférences utilisateur existantes. Aucun calcul financier en flottants n’est ajouté. La devise réelle, les unités, les arrondis et les montants comptabilisés ne sont pas modifiés par la navigation.

Une conversion en ligne exige toujours la proposition de taux serveur. Les taux manuels justifiés restent soumis à `fx:manual` et à la politique serveur. Le blocage légal BCC livré à l’étape 13 reste explicite (`BCC_AUTHORIZATION_REQUIRED`) ; cette étape ne prétend pas activer la collecte des cours officiels. Les preuves de taux et écritures confirmées restent immuables.

Hors connexion, les boutons de création n’autorisent que la préparation selon les permissions de la session. Les confirmations, paiements, transferts définitifs, conversions définitives et clôtures restent bloqués. La limite existante des brouillons en mémoire native (15 minutes maximum, effacement à la fermeture) est maintenue et affichée. La qualification SQLCipher et la persistance durable ne font pas partie de cette étape.

## Fichiers concernés

- Interface : `apps/desktop/src/App.tsx`, `ui/FinancialAccess.tsx`, `cash/CashPage.tsx`, `cash/ReceiptsPage.tsx`, `expenses/ExpensesPage.tsx`, `transfers/TransfersPage.tsx`, `reports/ReportsPage.tsx`, `management/RolesPage.tsx`, `cash/cash.css`.
- Tests React : `ui/financial-navigation.test.tsx`, `cash/receipts.test.tsx`, `expenses/expenses.test.tsx`, `hybrid/synchronization.test.tsx`, `reports/reports.test.tsx`.
- Tests HTTP/PostgreSQL : `apps/api/test/integration/rbac-financial.spec.ts`.
- Parcours Chromium : `tests/e2e/receipts.spec.ts`, `expenses.spec.ts`, `transfers.spec.ts`.
- Rapport et preuves : le présent dossier.

Les tests existants ont été adaptés aux nouveaux libellés. La fixture du test de verrouillage contient maintenant une caisse active, car l’absence d’affectation doit désactiver une nouvelle demande.

## Conservation et retour arrière

Aucune migration nouvelle ou historique modifiée, aucune réinitialisation et aucune modification des données de la démonstration. Les tests financiers créent une base `caissepro_test_<aléatoire>` isolée, contrôlent ce nom avant exécution puis suppriment uniquement cette base. Ils n’utilisent pas la base de l’entreprise pour leurs opérations synthétiques.

Le retour arrière consiste à restaurer le code précédent ou à annuler le commit de cette branche, puis reconstruire le desktop. Aucun retour arrière SQL ni aucune réécriture de mouvements n’est nécessaire. Les attributions de rôles qu’un utilisateur effectuera ensuite dans son entreprise restent des changements métier explicites, indépendants de la livraison du code.

Les résultats et limites de validation figurent dans [VALIDATION.md](VALIDATION.md). Les essais Chromium utilisent un double IPC explicitement identifié ; ils ne qualifient pas un exécutable natif macOS ou Windows. L’étape 10 et les installateurs n’ont pas été lancés.
