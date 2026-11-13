# CaissePro mère — sauvegarde avant une éventuelle édition hors connexion

Point de suspension du **13 novembre 2026**, fuseau de référence Africa/Kinshasa.

Le développement du projet mère est suspendu à la demande de son propriétaire. Cette intervention conserve le code et ajoute uniquement le présent rapport. Elle ne crée aucune édition caissier, ne duplique pas le projet et ne transforme pas son fonctionnement hybride.

## Référence exacte de reprise

| Élément                                      | Valeur                                              |
| -------------------------------------------- | --------------------------------------------------- |
| Dépôt                                        | `Djoys-ilunga/GESTION-DE-CAISSE`                    |
| URL                                          | <https://github.com/Djoys-ilunga/GESTION-DE-CAISSE> |
| Branche de sauvegarde                        | `backup/caissepro-mere-avant-offline`               |
| Branche examinée avant sauvegarde            | `feat/etape-13b-brouillons-chiffres`                |
| Dernier commit avant cette sauvegarde        | `f8b208eb8eb61ad3eb48e39b33ce7da4661ccb09`          |
| Code qualifié par la dernière matrice native | `bd4b8b5ed4d7f3a97b61f864c1ad19bb9cc4067b`          |
| Étape 13-A conservée dans l’historique       | `b761b852263dac12653c9329a0febb6dbf9b9dac`          |
| `main` observée au début de la sauvegarde    | `a347622b28952db2408cad3f0d30a06af2a94930`          |

Le commit de sauvegarde descend directement de `f8b208e`. Son identifiant se consulte sur GitHub ou avec `git rev-parse backup/caissepro-mere-avant-offline`. Le code applicatif, les contrats, les fichiers de verrouillage et les migrations restent identiques au point de suspension ; seul ce document est ajouté.

La branche `main` est plus ancienne que ce point de reprise. Reprendre depuis la branche de sauvegarde pour retrouver également les étapes 12, 13, 13-A et 13-B. Aucune fusion n’est effectuée.

## État Git et contrôle des fichiers

Avant intervention, le dépôt cloud ne contenait aucune modification suivie, aucun fichier indexé en attente et aucun nouveau fichier non suivi. Aucun commit des branches locales n’était absent de l’historique accessible par les branches distantes observées. La branche locale 13-A n’a pas de branche distante homonyme, mais son commit est déjà inclus dans la branche distante 13-B.

Le contrôle porte sur les **318 fichiers suivis** avant ajout de ce rapport, les noms sensibles, les signatures de jetons et clés privées, les littéraux de connexion et les correspondances avec les secrets de configuration locale. Les **862 objets de fichiers uniques des 37 commits accessibles** au point de suspension sont également examinés pour les signatures et noms sensibles. Aucun secret opérationnel ni fichier de base réelle n’a été détecté par ces contrôles. Les constantes d’authentification identifiées appartiennent aux scénarios synthétiques de test ; elles ne sont pas les accès de la démonstration ou d’une entreprise.

Ces contrôles sont documentés et bornés : ils ne constituent pas une certification exhaustive d’absence de secret. Les médias préexistants sont des icônes, une police et des captures de démonstration ou de tests ; aucun nouveau reçu, rapport financier ou export utilisateur n’est ajouté.

Restent exclus de la publication :

- `.env`, secrets de connexion et fichier privé des accès de démonstration ;
- bases PostgreSQL, volumes Docker, bases SQLCipher et leurs journaux ;
- coffres Windows/macOS, clés de chiffrement, jetons et sessions ;
- dépendances, clients générés, dossiers `dist`, `target`, journaux et résultats locaux de tests.

Les fichiers ignorés sont conservés sur place. Aucune base, clé, configuration privée ou donnée financière n’est supprimée, réinitialisée ou copiée dans GitHub.

**Portée : cette sauvegarde concerne le dépôt cloud examiné.** Elle ne permet pas de capturer des modifications présentes uniquement sur le Mac du propriétaire. Les chemins `.agents`, `.claude`, `.windsurf` et `skills-lock.json` précédemment signalés sur ce Mac ne sont pas présents comme nouveaux fichiers dans ce dépôt cloud ; leur contenu n’a pas été inspecté ni sauvegardé ici. Les conserver séparément sur le Mac et contrôler leurs secrets avant toute publication éventuelle.

## Fonctionnalités présentes et livrées dans leur périmètre

| Domaine                             | État conservé et preuve de référence                                                                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Socle desktop et serveur            | Tauri 2/Rust/React/TypeScript, NestJS, PostgreSQL/Prisma ; fichiers de verrouillage et migrations versionnés conservés.                                                                                                                                               |
| Authentification et accès           | Sessions, verrouillage, rôles cumulables explicitement, permissions et affectations d’agence/caisse ; contrôles natifs et serveur.                                                                                                                                    |
| Caisses et encaissements            | Configuration mono/multicaisse, ouverture de session, brouillon privé, transmission, confirmation explicite, reçu numéroté et mouvements immuables.                                                                                                                   |
| Dépenses                            | Préparation, transmission, soumission, décision motivée, interdiction d’auto-approbation, réservation, paiement explicite et bon de sortie.                                                                                                                           |
| Transferts et conversions           | Préparation, taux explicite, remise et réservation, réception par un autre utilisateur, écritures atomiques, bordereau et déduplication.                                                                                                                              |
| Tableaux de bord et rapports        | Données serveur, journal, périodes quotidienne/hebdomadaire/mensuelle/annuelle, filtres autorisés, PDF et Excel ; devises séparées.                                                                                                                                   |
| Clôtures et supervision             | Comptage, PV et écarts, administration et journal d’audit dans le périmètre autorisé.                                                                                                                                                                                 |
| Multidevise — étape 12              | Catalogue extensible, activation par entreprise, précisions et arrondis, préférences monétaires individuelles et migrations compatibles. Voir [validation 12](../etape-12/VALIDATION.md).                                                                             |
| Change/BCC — étape 13               | Architecture de fournisseur, politique, taux manuels justifiés, preuves et historique immuables. La collecte BCC automatique reste désactivée. Voir [bilan 13](../etape-13/BILAN.md).                                                                                 |
| Permissions/navigation — étape 13-A | Actions financières visibles, explications des refus, raccourcis de caisse, journal et clôture, séparation administration/finance. Voir [bilan 13-A](../etape-13a/BILAN.md).                                                                                          |
| Brouillons persistants — étape 13-B | SQLCipher et clés système, reprise verrouillée, isolation par auteur/entreprise/déploiement, révisions et verrou interprocessus, instantanés exacts après accusé perdu. Activé sur Windows x64/MSVC et macOS Apple Silicon. Voir [bilan 13-B](../etape-13b/BILAN.md). |

Le projet mère demeure **hybride** : PostgreSQL est la vérité financière. Hors connexion, seules les préparations et consultations déjà autorisées sont permises. Aucune confirmation d’encaissement, approbation, paiement, remise/réception définitive ou clôture n’est comptabilisée localement. Les brouillons chiffrés sont conservés au plus sept jours ; le bail d’accès hors connexion reste limité à quinze minutes et aux expirations de session.

## Points inachevés ou restant à qualifier

1. **Étape 10 non exécutée** : audit final global, recette des parcours sur postes utilisateurs, applications signées, installateurs Windows/macOS et mises à jour. Les compilations natives de développement réussies ne remplacent pas cette qualification de distribution.
2. **BCC réel** : aucun flux automatique officiel autorisé n’est opérationnel. Le connecteur livré signale `BCC_AUTHORIZATION_REQUIRED`. Obtenir un accord ou un fournisseur habilité et vérifier son contrat avant toute activation ; ne pas réactiver un collecteur par simple changement de configuration. Les preuves consultées datent du 12 novembre 2026.
3. **Préférences visuelles individuelles** : thèmes clair/sombre/système présents, mais l’apparence utilise actuellement une préférence locale `caissepro.appearance`. Une gestion serveur séparée par utilisateur des choix visuels reste à concevoir ; les préférences monétaires individuelles sont déjà livrées.
4. **Autres architectures natives** : Mac Intel, Windows ARM et persistance sensible Linux non qualifiés et non activés. Les essais graphiques manuels exhaustifs, dialogues d’impression physique et scénarios de distribution restent à effectuer.
5. **Retours d’utilisation sur Mac** : vérifier que le code et le binaire exécutés correspondent à cette branche. Le dernier retour Terminal vérifié indiquait encore `main` / `a347622` ; la bascule demandée ensuite n’a pas été confirmée par un nouveau résultat Git. Une capture montrait aussi l’ancien libellé de conservation temporaire.
6. **Validation des montants et ergonomie** : un refus d’enregistrement de dépense a été signalé avec `50` en USD et un message générique. Le contrôle reproduit exige deux décimales (`50,00` ou `50.00`). Reproduire sur la version exacte du Mac et améliorer les explications de saisie, sans modifier silencieusement les montants ni leurs arrondis. Aucune correction applicative de ce retour n’a été réalisée pendant cette sauvegarde.
7. **Rapports et exports** : l’export PDF/Excel inclut toutes les pages dans les limites prévues ; « Imprimer la vue » concerne l’affichage courant. Vérifier les documents et l’impression sur les postes cibles. Les brouillons et demandes non payées ne deviennent pas des dépenses comptabilisées.

L’étape 14 et l’édition caissier entièrement hors connexion ne sont pas commencées.

## Vérifications déjà acquises, sans nouvelle revendication fonctionnelle

Les résultats ci-dessous sont ceux consignés le **12 novembre 2026**, pas une nouvelle exécution le jour de la sauvegarde :

- Linux : `pnpm check` réussi, 23 tests Node, 30 partagés, 27 unitaires API, 123 React ; format conforme.
- PostgreSQL réel : 161 tests réussis ; Chromium avec IPC simulé : 16 parcours réussis.
- Rust Linux : 14 tests SQLCipher, 71 tests du courtier ; compilation et ouverture d’une fenêtre Tauri réelle.
- Windows x64/MSVC et macOS Apple Silicon : pour chaque cible, 15 tests du magasin SQLCipher/coffre et 74 tests du courtier, contrôles JavaScript et compilation réelle Tauri `--debug --no-bundle` réussis. Le helper ignoré dans la suite ordinaire est exécuté explicitement par le parent dans trois processus enfants.
- [Matrice native réussie](https://github.com/Djoys-ilunga/GESTION-DE-CAISSE/actions/runs/43237829801), code `bd4b8b5` ; le commit `f8b208e` ajoute ensuite le rapport de qualification.

La sauvegarde actuelle vérifie Git, les fichiers à publier, les empreintes de l’archive, l’intégrité du bundle et la correspondance du SHA distant. Elle ne relance pas les scénarios financiers, ne démarre pas les services et ne migre aucune base.

## Conservation et reprise du projet mère

Une archive des fichiers versionnés et un bundle Git contenant l’historique accessible depuis la branche de sauvegarde sont conservés hors du checkout, avec empreintes SHA-256 et manifeste de contrôle. Les fichiers de preuve locaux restent dans le dossier privé de sauvegarde du workspace ; aucun fichier de données ou secret n’est ajouté à ces archives de source.

La sauvegarde Git ne remplace pas celle des bases et configurations privées. Conserver séparément les `.env`, volumes PostgreSQL, dossier privé de démonstration et, pour retrouver les brouillons locaux, le profil système et son coffre de clés. Copier uniquement un fichier SQLCipher ne permet pas de le déchiffrer sans sa clé. Cette intervention n’exporte pas ces secrets et n’affirme pas sauvegarder le disque du Mac.

Pour une reprise future du projet mère, après autorisation et après avoir préservé toute modification locale, créer une branche de travail depuis la référence sauvegardée :

```bash
git fetch origin
git switch -c reprise/caissepro-mere origin/backup/caissepro-mere-avant-offline
```

Puis :

1. Vérifier le commit, ce rapport et l’absence de modifications locales imprévues ; utiliser le SHA communiqué avec la livraison pour identifier exactement le point figé.
2. Retrouver les configurations privées par leur emplacement sécurisé, sans les committer. Conserver Node 24 LTS (version référencée par `.node-version`), pnpm `11.25.0`, Rust `1.90.0` et les fichiers de verrouillage existants.
3. Installer les dépendances verrouillées, générer le client Prisma, puis exécuter les vérifications dans un environnement de développement isolé : `pnpm install --frozen-lockfile`, `pnpm db:generate`, `pnpm check` ; les commandes financières de régression utilisent exclusivement leurs bases de test prévues.
4. Reprendre les retours Mac et l’ergonomie des montants, puis les préférences visuelles individuelles si demandées. Traiter l’autorisation BCC comme un chantier externe distinct.
5. Planifier l’audit et la distribution de l’étape 10 quand le propriétaire l’autorisera. Préserver l’immuabilité du grand livre, les rôles et périmètres, l’idempotence et les protections multidevises.

Ces commandes de reprise sont documentées pour plus tard ; elles ne sont pas exécutées dans cette intervention. Les branches existantes et leurs historiques restent inchangés. Le point de sauvegarde doit rester la référence du projet mère pendant les travaux éventuels sur une autre édition.
