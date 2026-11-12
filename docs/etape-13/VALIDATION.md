# Validation finale du livrable de l’étape 13

Exécution cloud Linux le 12 novembre 2026. Tests financiers sur API NestJS et PostgreSQL réels avec données synthétiques en bases jetables. Les tests du fournisseur BCC sont des doubles explicites et ne prouvent pas une collecte officielle autorisée.

## Résultats

| Contrôle                                           | Résultat                                                                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                       | Réussi : ESLint, TypeScript, compilations API et React                                                                                 |
| Tests Node                                         | 23 réussis                                                                                                                             |
| Contrats partagés                                  | 30 réussis                                                                                                                             |
| Tests unitaires API                                | 27 réussis : 19 fournisseur/normalisation/planification, 4 reprises transactionnelles, 4 disponibilité                                 |
| React et logique desktop avec passerelles simulées | **103 réussis**                                                                                                                        |
| `pnpm test:db`                                     | **151/151**, dont 20 scénarios BCC et 131 régressions                                                                                  |
| Courtier Rust                                      | **50/50**, dont propagation du refus d’automatisation et absence d’action financière                                                   |
| Clippy Rust, avertissements interdits              | Réussi                                                                                                                                 |
| Chromium / Playwright                              | **15/15**, doubles IPC explicites                                                                                                      |
| Schéma Prisma et migrations historiques            | Validation et empreintes vérifiées                                                                                                     |
| Migration BCC                                      | 43 tables historiques préservées ; rollback DDL et RLS ; sauvegarde/restauration de 50 tables identiques dans une seconde base jetable |

Le test de migration multidevise de l’étape 12 a également réussi le 11 novembre (39 tables préservées, restauration de 43 tables). Aucun résultat natif Windows/macOS ou d’impression physique n’est déduit de ces tests Linux.

## Parcours livré réellement vérifié

Le nouveau scénario lance le module avec le fournisseur configuré par défaut, sans remplacer celui-ci par un fournisseur BCC simulé. Il vérifie :

1. L’API expose `BCC_AUTHORIZATION_REQUIRED`, avec source non approuvée et cours non actualisés.
2. L’actualisation autorisée par le rôle renvoie `performed: false` et ne contacte pas le site.
3. Une proposition en mode BCC est refusée avec le même code explicite.
4. Une proposition manuelle avec permission, politique, source et justification est acceptée ; elle ne comptabilise rien.
5. Le brouillon de conversion est transmis sans écriture ; la remise réserve sans comptabilisation.
6. Un autre utilisateur confirme la réception, une seule opération `FX` est comptabilisée et la preuve manuelle immuable est conservée.

Les scénarios existants couvrent les cours distincts, unités 1/100, croisement EUR/USD, dates invalides, taux négatifs/nuls, devise non couverte, changement de publication, fraîcheur et TTL, nouvelle politique, isolation, concurrence, déduplication, rollback et immutabilité. Les données synthétiques ne sont pas importées dans la démonstration ou une entreprise existante.

## Vérification du site et limites

Les trois pages officielles fournies et les mentions légales ont répondu HTTP 200 avec TLS vérifié. Cette consultation confirme que le blocage réseau est résolu et identifie une restriction explicite de collecte automatisée. Les liens, date, empreinte et court extrait sont conservés dans `preuves/`.

Le connecteur livré n’effectue aucune collecte du site. Un accord ou un flux BCC autorisé et son contrat technique restent nécessaires pour une intégration automatique réelle. Il n’est pas annoncé qu’une API publique documentée existe ou qu’un scraper est opérationnel.

Le scénario Chromium vérifie l’écran d’autorisation requise, le bouton d’actualisation bloqué et l’absence de taux inventé. La capture associée utilise un double IPC clairement indiqué.

## Anomalies corrigées et exécution

Un premier passage concurrent a donné 149/151 : le test d’initialisation lisait les fichiers compilés pendant leur reconstruction, et une des six transmissions simultanées a reçu un conflit. Les vérifications dépendantes sont désormais exécutées après compilation. La reprise des conflits SQL conserve l’isolation SERIALIZABLE, reconnaît la cause SQL d’origine et utilise un délai exponentiel plafonné avec variation, pour neuf essais maximum. Les tests vérifient la récupération après six conflits, l’arrêt au plafond et l’absence de rejeu d’un refus métier. La suite complète finale passe sans relâcher ses assertions.

Les journaux sont dans `/workspace/scratch/etape13-verification-reelle/` : `check-final.log`, `unit-api-livraison.log`, `postgresql-livraison.log`, `rust.log`, `clippy.log`, `e2e.log`, `migration-bcc.log`, `prisma.log` et `migrations-historiques.log`. Les échecs initiaux restent conservés dans les premiers journaux ; ils ne sont pas masqués par une désactivation de tests.

Commandes reproductibles, compilation avant les tests qui dépendent de ses fichiers :

```bash
pnpm db:generate
pnpm check
pnpm test:db
pnpm test:bcc:upgrade
pnpm test:session
pnpm db:validate
CI=1 VITE_API_BASE_URL=http://127.0.0.1:3000 VITE_API_DEPLOYMENT_ID=caissepro-development PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium pnpm test:e2e
```

Les bases `caissepro_test_*` sont créées/supprimées par les scénarios eux-mêmes. Aucune base existante n’est réinitialisée ni migrée. Le stockage chiffré hors connexion, les corrections générales de permissions et les installateurs restent hors de cette intervention. L’avertissement Vite sur la taille du bundle ne bloque pas la compilation.
