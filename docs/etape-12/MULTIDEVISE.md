# Étape 12 — gestion multidevise extensible

Branche : `feat/etape-12-multidevise`, issue de l’audit de l’étape 11. L’intégration BCC et les installateurs de l’étape 10 ne font pas partie de cette livraison.

## Modèle livré

- `CurrencyDefinition` : code ISO, code numérique, nom, symbole, précision immuable, statut global, statut de disponibilité BCC et date de la source.
- `CompanyCurrency` : activation et version par entreprise. CDF et USD sont activées pour chaque entreprise existante, et pour toute nouvelle entreprise. Une activation ouvre les comptes manquants, de solde nul, dans les caisses de l’entreprise ; elle ne crée aucune écriture et n’accorde aucun accès supplémentaire.
- `CompanyMonetarySettings` : devise de référence des rapports, facultative, avec version. Aucun choix arbitraire de devise globale n’est introduit dans les écritures existantes.
- `UserMoneyPreference` : devise d’affichage, favorite des nouveaux formulaires, locale et version, séparées par entreprise et utilisateur. RLS interdit la lecture ou la modification des préférences d’un autre utilisateur.

Les montants comptabilisés conservent leur devise réelle. Une modification des préférences ne réaffecte pas un formulaire commencé, un brouillon restauré, un compte ou une opération. Les nouveaux formulaires utilisent la favorite autorisée ; les choix historiques CDF/USD servent uniquement de choix initial lorsqu’ils sont encore autorisés.

L’administrateur dispose du menu **Devises et préférences** pour autoriser les monnaies et choisir une référence de reporting. Chaque utilisateur y enregistre ses propres préférences. Les droits `cash:configure`, les sessions authentifiées, les affectations aux agences et aux caisses et les plafonds d’approbation restent vérifiés au serveur. Les changements de configuration sont journalisés.

### Catalogue et actualisation

Le catalogue initial contient **166 entrées monétaires** du XML ISO 4217 List One daté du **25 juin 2024**, distribué dans `currency-codes@2.2.0` sous licence MIT. Le XML, la licence et les métadonnées sont conservés dans `data/`. Les précisions proviennent du XML, jamais de la valeur par défaut d’`Intl` : notamment MGA reste à deux décimales. Les noms et symboles de présentation proviennent d’`Intl`.

Ce fichier historique n’atteste pas l’actualité de toutes les monnaies en novembre 2026. Vérifier la liste officielle courante avant d’activer une devise supplémentaire en exploitation. L’actualisation n’exige pas une migration SQL par devise :

```bash
pnpm currencies:import /chemin/vers/liste-officielle-ISO-4217.xml
pnpm currencies:import /chemin/vers/liste-officielle-ISO-4217.xml --apply
```

La première commande simule les ajouts. La seconde exige un compte de migration PostgreSQL, ajoute les nouveaux codes et laisse les activations d’entreprise inchangées. Le fichier doit être obtenu et vérifié auprès de l’autorité ISO/SIX ; le parseur n’en certifie pas la provenance. Il refuse les entités XML externes, les fichiers trop volumineux, les contradictions et les précisions hors 0 à 4. Une modification de précision existante est refusée. L’import n’efface pas les monnaies retirées, les taux ou les historiques ; une modification de statut nécessite une décision de gestion distincte.

`bccRateStatus` reste `UNVERIFIED` pour toutes les devises initiales. Aucun cours officiel BCC n’est téléchargé, inventé ou présenté comme disponible.

## Calculs et documents

Les colonnes monétaires deviennent `numeric(24,8)` : les **16 chiffres entiers** de capacité historique sont conservés. Les contrats autorisent au maximum quatre décimales et les gardes SQL imposent la précision propre à la devise, ainsi que la borne d’une opération individuelle. Les taux restent `numeric(24,12)`. Les calculs emploient Decimal à 60 chiffres et les échanges utilisent des chaînes ; aucun montant n’est converti en flottant binaire.

Les conversions utilisent un taux explicite en unités de destination pour une unité d’origine. L’arrondi final est **HALF_UP à la précision de destination**, sans arrondi intermédiaire. Exemples testés : KWD → JPY à zéro décimale, JPY → KWD à trois décimales, JPY → CLF à quatre décimales. Les bordereaux enregistrent `HALF_UP_0` à `HALF_UP_4`. Les anciens bordereaux `HALF_UP_2` restent lisibles et inchangés.

Les soldes, réservations, indicateurs, graphiques, journaux, décisions et écarts restent séparés par devise. Les transferts et conversions ne deviennent pas des recettes. La clôture exige le comptage de **toutes les devises réellement présentes dans les comptes de la caisse**, y compris les devises désactivées conservées dans l’historique ; les comptages incomplets ou dupliqués sont refusés. L’ancien contrat `countedUSD`/`countedCDF` reste accepté uniquement lorsque le comptage correspond exactement aux comptes concernés.

Les reçus, bons de sortie, bordereaux et PV conservent leur identité et leurs montants d’origine. Les exports PDF/Excel suivent les devises réelles. Excel conserve les décimaux en chaînes pour éviter la perte de précision des grands montants.

L’**équivalence de reporting** est une estimation séparée, calculée au serveur sur les seules caisses autorisées. L’utilisateur choisit et confirme chaque taux publié, dans le bon sens, avec source et date ; aucun taux n’est choisi implicitement, même pour un solde nul. Le serveur revalide la session, les périmètres, la devise cible, les identifiants des taux et leur date d’effet. Il arrondit chaque solde par devise convertie, puis additionne dans la monnaie cible. La réponse mentionne `accounting: false`. Les exports financiers ordinaires conservent les monnaies d’origine ; cette estimation n’est pas une nouvelle écriture.

## API et mode hybride

Le préfixe HTTP reste `/api/v1`. Le **protocole de compatibilité desktop devient 2** ; le client refuse un ancien serveur et la disponibilité du nouveau serveur exige le nouveau catalogue en base. Mettre à jour le serveur et le desktop ensemble.

| Endpoint                  | Accès et effet                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `GET /money/context`      | Catalogue, devises de l’entreprise et préférences du seul utilisateur authentifié       |
| `PUT /money/preferences`  | Préférences propres à l’utilisateur ; version attendue obligatoire                      |
| `PUT /money/currencies`   | `cash:configure`, confirmation et version ; activation/désactivation                    |
| `PUT /money/reporting`    | `cash:configure`, confirmation et version de référence                                  |
| `POST /reports/valuation` | `ledger:read`, taux explicitement sélectionnés ; estimation sans comptabilisation       |
| `POST /reports/close`     | Comptages extensibles `counts: [{currency, amount}]`, confirmation et droits de session |

La désactivation ne supprime rien. Elle est refusée pour la dernière devise active, une devise de référence encore sélectionnée, une réservation active ou un transfert remis non réceptionné. Les opérations nouvelles en devise inactive sont refusées ; une contre-écriture d’une opération historique reste possible avec ses permissions habituelles.

Hors connexion, le catalogue connu et les préférences restent en mémoire native, bornés par la session antérieure et son autorisation hors connexion. Ils ne sont pas stockés dans Web Storage. Le verrouillage, l’expiration, le changement d’utilisateur ou de périmètre protègent ces données. La devise réelle et la chaîne décimale des brouillons sont conservées ; aucune conversion automatique ni action financière n’est exécutée. Les paramètres ne peuvent pas être modifiés hors connexion. Les taux doivent être explicitement revalidés après reconnexion ; le serveur vérifie de nouveau droits, caisses, unités monétaires et fonds avant toute comptabilisation.

Le stockage SQLCipher reste **désactivé en application** tant que sa qualification native Windows/macOS et des magasins de clés n’est pas acquise. Les brouillons de session sont donc temporaires en RAM, comme avant cette étape ; transmettre un brouillon au serveur est nécessaire pour le retrouver après fermeture de l’application. La migration locale `002_multicurrency.sql` conserve les anciens brouillons et accusés lorsqu’elle est exercée dans l’adaptateur de test chiffré ; elle ne débloque pas cette fonctionnalité en production.

## Migration, sauvegarde et retour arrière

La nouvelle migration est `20261111000100_extensible_currencies`. Les **15 migrations historiques sont inchangées**, vérifiables par `sha256sum -c docs/audit-etape-11/migrations.sha256`.

L’enum fermé devient un domaine textuel de compatibilité pour les anciennes signatures SQL ; les colonnes Prisma utilisent des identifiants texte liés au catalogue par clés étrangères. Les contraintes, vues de solde avec `security_invoker`, permissions de vues et gardes financières sont rétablies dans la même transaction. Les fonctions modifiées sont reproduites dans la nouvelle migration, sans réécriture des fichiers historiques. Aucun montant comptabilisé ni instantané JSON n’est recalculé.

**Avant application sur une base utilisée :**

1. Arrêter les écritures et les anciennes instances API/desktop, noter le commit déployé et conserver sa configuration privée hors Git.
2. Effectuer une sauvegarde complète PostgreSQL au format custom et vérifier son SHA-256. Préserver aussi les rôles/propriétaires/permissions du cluster et la configuration de connexion dans un stockage protégé ; les rôles globaux ne sont pas contenus dans `pg_dump`.
3. Restaurer cette sauvegarde dans **une autre base vide**, avec les rôles requis et la même version PostgreSQL, puis y appliquer les migrations et effectuer les contrôles. Ne pas utiliser `--clean`, `db push` ou `migrate reset` sur la base existante.
4. Prévoir une fenêtre de maintenance et de l’espace libre : le changement de type et la revalidation des contraintes verrouillent et peuvent réécrire les tables. Mesurer leur durée sur une copie représentative. Un délai de verrou dépassé annule la migration transactionnelle.
5. Appliquer `pnpm db:deploy` avec le compte de migration, puis démarrer la nouvelle API et le nouveau desktop. Vérifier les valeurs, nombres de lignes, références, reçus/PV, RLS et soldes par devise avant de réautoriser les écritures.

Pour la démonstration Mac déjà préparée, `pnpm demo:backup` sauvegarde seulement sa base locale existante dans `../scratch/caissepro-demo/backups/`, en fichiers privés, avec empreinte SHA-256 et contrôle de lisibilité `pg_restore --list`. Le lanceur effectue cette sauvegarde **automatiquement avant toute migration en attente** ; un échec bloque la migration. Il conserve le port PostgreSQL existant, les identifiants et les données de démonstration. Aucun mot de passe n’est affiché par ces commandes. Le contrôle de lisibilité ne remplace pas une restauration testée.

**Retour arrière avant reprise des écritures :** un échec interne provoque `ROLLBACK` ; conserver l’ancienne version tant que la migration n’est pas complète. Si la migration a réussi mais que la validation échoue, restaurer la sauvegarde dans une autre base, vérifier les données, puis basculer l’ancienne version vers cette copie. Conserver la base migrée pour investigation, sans l’effacer.

**Après de nouvelles écritures multidevises :** ne pas revenir à l’ancien enum CDF/USD et ne pas restaurer une ancienne sauvegarde par-dessus la base courante. Procéder par correction en avant. Toute récupération d’incident doit conserver et rapprocher les opérations postérieures à la sauvegarde et leurs identifiants ; aucun rejeu financier automatique.

## Vérifications et limites

Voir [VALIDATION.md](VALIDATION.md) pour les commandes et résultats. Les essais de migration et de restauration ne concernent que des bases jetables. Les bases locales de développement et de démonstration préexistantes n’ont pas reçu cette migration pendant le développement de cette étape.

Les contrôles exécutés dans le cloud Linux ne certifient ni l’impression physique ni les installateurs Windows/macOS. L’étape 10 reste à effectuer ; l’étape BCC n’est pas commencée.
