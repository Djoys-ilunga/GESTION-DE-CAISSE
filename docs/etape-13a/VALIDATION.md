# Validation de l’étape 13-A

Validation du 12 novembre 2026 sous Linux, Node 24.22.1, pnpm 11.25.0, PostgreSQL réel et Chromium. Base du développement : `a23ce0dd288600c24015e0dff144445a6d196539`.

## Résultats exécutés

| Vérification                                                                | Résultat                                                                                                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                                                | Réussi : ESLint sans avertissement, TypeScript des trois packages, tests et builds API/frontend.                                                  |
| Tests Node du catalogue, des permissions IPC et des lanceurs                | **23/23** réussis. Les doubles de commande du lanceur ne sont pas des essais natifs macOS.                                                        |
| Tests du package partagé                                                    | **30/30** réussis.                                                                                                                                |
| Tests unitaires API                                                         | **27/27** réussis, dont les 19 tests du fournisseur BCC et les contrôles de reprise transactionnelle.                                             |
| Tests React/logique desktop                                                 | **117/117** réussis. Inclut 13 nouveaux cas de rôles et de navigation, plus le raccourci de clôture avec caisse disparue.                         |
| `pnpm test:db`                                                              | **159/159**, 12 fichiers, sur une base PostgreSQL jetable. Inclut les 8 nouveaux scénarios RBAC, les 20 tests BCC et les régressions financières. |
| `pnpm test:e2e`                                                             | **16/16**, Chromium avec IPC explicitement simulé. Suite complète finale réussie en 36,4 s.                                                       |
| Formatage ciblé et `git diff --check`                                       | Réussis sur les fichiers modifiés.                                                                                                                |
| Schéma, migrations, définitions des rôles, services comptables et code Rust | Inchangés par rapport à la base Git.                                                                                                              |

Le contrôle général a été exécuté avec les permissions d’environnement nécessaires aux sous-processus locaux des tests du lanceur. Le test PostgreSQL a utilisé le mécanisme existant de création/suppression d’une base isolée ; aucune migration n’a été appliquée à la base de démonstration ou de l’entreprise. Les builds signalent les avertissements Rollup sur des commentaires Zod et la taille du bundle ; ils terminent avec succès.

## Preuves fonctionnelles des rôles standard

`apps/api/test/integration/rbac-financial.spec.ts` installe le véritable référentiel `ROLE_PERMISSIONS` et authentifie les utilisateurs par HTTP. Il ne s’appuie pas sur le rôle spécial `ADMIN_TEST` pour les opérations contrôlées.

1. Administrateur seul : permissions exactement égales au référentiel technique ; appels directs d’ouverture, confirmation, soumission, approbation, paiement, transfert et clôture refusés ; aucune opération financière créée.
2. Administrateur avec rôle financier : attribution explicite dans l’API existante, ancienne session refusée HTTP 401, reconnexion avec union exacte des permissions et seulement les caisses choisies. Le rôle Administrateur lui-même conserve ses permissions initiales.
3. Affectations invalides : rejet des couples agence/caisse incohérents et des caisses d’une autre entreprise, sans ajout d’affectation.
4. Caissier non affecté : possède le droit métier de session, mais ouverture, clôture et journal de caisse refusés ; catalogue de caisses vide.
5. Caissier affecté : clôture comptée, nouvelle ouverture, transmission puis confirmation d’un encaissement de test, confirmation idempotente et une seule ligne de journal. Approbation, remise/réception de transfert et lecture d’une autre caisse restent refusées.
6. Administrateur + Responsable financier : auto-approbation refusée avec `SELF_APPROVAL_FORBIDDEN`, paiement avant approbation refusé, approbation par un autre responsable puis paiement réussi ; solde exact de 80,00 USD après une dépense de 20,00 USD sur 100,00 USD disponibles.
7. Transfert entre caisses : préparation, remise et réception distinctes ; réception par l’émetteur refusée ; réception par un autre responsable autorisée ; solde source exact de 98,00 USD après transfert de 2,00 USD.
8. Conversion dans une caisse : proposition de taux manuel explicite de 2 500 CDF pour 1 USD, conversion de 2,00 USD en 5 000,00 CDF, réception distincte, preuve `MANUAL` conservée. Une demande BCC reste refusée avec `BCC_AUTHORIZATION_REQUIRED`.

Les suites existantes vérifient aussi les montants, arrondis, grandes valeurs, concurrence, déduplication, fonds réservés, restrictions de sessions, périmètres/RLS, refus des écritures forgées, rollback, immutabilité, rapports et exports, ainsi que la synchronisation sans comptabilisation implicite.

## Interface et captures

Les tests React vérifient les boutons visibles mais désactivés pour l’administrateur technique, le formulaire utilisable pour un administrateur cumulant un rôle financier, les caissiers affectés/non affectés et le responsable financier. Ils contrôlent l’attribution cumulative avec confirmation/version, le filtre serveur des dépenses en attente, l’annulation d’une nouvelle préparation et le refus d’une conversion avec une seule devise active.

Le raccourci journal/clôture transmet l’identifiant exact de la caisse à la requête de rapport. Le test de clôture vérifie le comptage vide, la confirmation obligatoire et l’absence de substitution quand la session ciblée n’est plus accessible.

Les captures suivantes proviennent de Chromium avec entreprise et données **synthétiques**, via double IPC ; elles ne représentent pas une session réelle ni un test financier serveur :

- [Conversion — thème clair, largeur 1 440 px](conversion-light-ipc-simule.png).
- [Conversion — thème sombre, largeur 650 px](conversion-dark-ipc-simule.png).

Le test navigateur vérifie les raccourcis, l’annulation préservant la saisie, les thèmes et l’absence de débordement horizontal global à ces deux tailles. Les parcours existants vérifient encore entrées, dépenses, synchronisation, rapports, documents et impression PDF dans Chromium.

## Limites et conclusion

L’étape 13-A est validée pour les interfaces, permissions et services réutilisés dans l’environnement testé. Aucun blocage n’est identifié dans ce périmètre.

Les essais natifs Windows/macOS et les installateurs de l’étape 10 restent à effectuer. Aucun code Rust n’a été modifié ni nouvelle qualification native annoncée. Les brouillons restent temporaires en mémoire, et la collecte automatique BCC reste bloquée dans l’attente d’un accès autorisé, conformément au bilan de l’étape 13. Ces limitations existantes n’ont pas été masquées par de nouveaux boutons.

Les journaux complets et une archive vérifiée du commit de livraison sont conservés hors checkout dans `/workspace/scratch/etape13a-verification/`. Le manifeste d’archive indique le SHA du commit et les sommes de contrôle. Cette sauvegarde locale ne constitue pas une publication cloud ou un envoi GitHub.
