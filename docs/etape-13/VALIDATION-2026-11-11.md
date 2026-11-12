> Résultats historiques. La validation finale se trouve dans VALIDATION.md.

# Validation de l’étape 13

Exécution cloud Linux le 11 novembre 2026. Les données sont synthétiques ; les tests financiers utilisent API NestJS et PostgreSQL réels dans des bases jetables. Aucun taux de test n’a été injecté dans une entreprise existante.

| Contrôle                                                            | Résultat                                                                                                                                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                                        | Réussi : ESLint, TypeScript, compilations API/React, 23 tests Node, 30 tests partagés, 22 tests unitaires API dont 18 BCC, 102 tests React/logique avec passerelles simulées |
| `pnpm test:db`                                                      | **150/150**, soit 131 régressions et 19 scénarios BCC avec fournisseur synthétique injecté                                                                                   |
| Courtier Rust                                                       | **49/49**, dont transmission du même identifiant de proposition après accusé perdu, commandes protégées et refus avant confirmation                                          |
| Clippy Rust, tous les targets du courtier, avertissements interdits | Réussi                                                                                                                                                                       |
| Playwright Chromium                                                 | **15/15**, doubles IPC explicites, dont écran BCC fermé sans cours fictif                                                                                                    |
| `pnpm db:validate`                                                  | Schéma Prisma valide                                                                                                                                                         |
| `pnpm test:bcc:upgrade`                                             | 43 tables historiques préservées, rollback DDL et RLS vérifiés ; sauvegarde/restauration de 50 tables identiques                                                             |
| `pnpm test:currency:upgrade`                                        | Test de l’étape 12 conservé : 39 tables historiques préservées ; sauvegarde/restauration de 43 tables identiques                                                             |

Les scénarios BCC couvrent normalisation par 100, cours manquants et invalides, dates impossibles/futures, format modifié, spread incohérent, croisement EUR/USD, type acheteur distinct du moyen, panne réseau synthétique, absence de nouvelle publication, déduplication, concurrentes, fraîcheur et TTL, nouvelle publication avant/après remise, refus des propositions d’un autre auteur, politique et permissions manuelles, immutabilité et refus des ajouts tardifs aux publications.

Le coordinateur planifié est testé avec horloge contrôlée. Le transport HTTP refuse les destinations arbitraires ; son accès effectif et le parseur d’un document BCC réel restent non vérifiés. Les tests du fournisseur synthétique ne qualifient pas les publications officielles.

Le premier passage de régression a donné 130/131 : un conflit de synchronisation concurrente n’était pas reconnu pour réessai lorsque Prisma le plaçait dans la cause de l’erreur. `CentralAccess` inspecte désormais aussi le message/code SQL d’origine et les variantes de sérialisation. Les suites suivantes de 147 puis 150 tests ont réussi. Le contrat de sortie des propositions de taux a également été corrigé : il n’expose plus les champs internes qui faisaient échouer la validation stricte.

Les journaux de cette exécution se trouvent dans `/workspace/scratch/etape13-reprise/` : `check-final.log`, `postgresql-validation.log`, `rust.log`, `clippy.log`, `e2e.log`, `tests-migration.log`, `migration-etape12.log`, `prisma-validation.log`. Ils ne contiennent pas d’identifiants de connexion de l’entreprise.

Commandes reproductibles :

```bash
pnpm db:generate
pnpm check
pnpm test:db
pnpm test:bcc:upgrade
pnpm test:currency:upgrade
pnpm test:session
pnpm db:validate
CI=1 VITE_API_BASE_URL=http://127.0.0.1:3000 VITE_API_DEPLOYMENT_ID=caissepro-development PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium pnpm test:e2e
```

Les tests de migration utilisent Docker local et créent/suppriment uniquement leurs bases aléatoires `caissepro_test_*`. L’URL d’administration PostgreSQL reste privée dans la configuration locale. Aucune réinitialisation de PostgreSQL ou migration de la démonstration existante n’est nécessaire pour les exécuter.

Limites : intégration officielle BCC bloquée au niveau du proxy ; format et conditions d’utilisation non vérifiés ; pas de qualification native macOS/Windows, d’impression physique ou d’installateurs. L’avertissement Vite concernant un bundle supérieur à 500 ko n’empêche pas la compilation. L’adaptateur SQLCipher et la conservation durable hors connexion ne sont pas activés.
