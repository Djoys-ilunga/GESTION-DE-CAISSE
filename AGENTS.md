# CaissePro — règles permanentes

- Respecter l'étape demandée. Examiner l'existant, annoncer un plan court, développer, tester et présenter les résultats réels. Ne pas commencer une autre étape sans instruction.
- Desktop Windows/macOS : Tauri 2, Rust, React, Vite, TypeScript, Tailwind. Backend NestJS, PostgreSQL et Prisma ; API HTTPS.
- PostgreSQL est l'unique vérité financière. Séparer strictement CDF et USD. Montants/taux décimaux exacts ; échanges sous forme de chaînes, jamais de calcul financier en flottants binaires.
- Les opérations comptabilisées et journaux sont immuables. Corriger par contre-écriture liée et traçable. Les soldes proviennent des écritures, jamais d'un champ modifiable sur un compte.
- Toutes les permissions et périmètres entreprise/agence/caisse sont vérifiés côté serveur. Le contexte utilisateur devra provenir d'une session authentifiée, jamais d'une identité affirmée par le client.
- Aucune dépense sans approbation préalable valide ; personne n'approuve sa propre demande. Réservations et mouvements financiers atomiques et idempotents, y compris en concurrence.
- Hors connexion : consultation locale expressément autorisée, datée et signalée non actualisée ; brouillons d'encaissements/demandes de dépenses uniquement. Aucune confirmation, approbation, conversion, transfert, clôture définitive ou modification de solde officiel.
- Synchroniser des brouillons avec UUID stable, révision et dernière version serveur connue ; dédupliquer et revalider côté serveur, exposer les erreurs/conflits. Ne jamais confirmer une opération financière automatiquement.
- SQLite standard ne chiffre pas. L'adaptateur SQLCipher Rust reste bloqué en application tant que la validation Windows/macOS et des magasins de clés n'est pas obtenue. Pas de repli en clair, de plugin SQL/fichiers/shell ou de stockage navigateur sensible.
- Clés aléatoires protégées par le magasin natif, sans clé codée en dur ou placée dans `.env`. Ne jamais embarquer d'identifiants PostgreSQL dans le desktop. Ne pas exposer de données sensibles dans les logs.
- Borner l'accès hors connexion et les données locales ; effacer les données lors des changements de périmètre et événements de sécurité. L'authentification future devra déclencher ces actions.
- Préserver TLS, signatures et sommes de contrôle. Ne pas demander de secrets dans la conversation.
- Tester les montants, soldes, concurrence, doublons, autorisations, auto-approbation interdite, rollback, immutabilité, RLS et absence de modification financière hors connexion. Préserver les contraintes SQL versionnées ; ne pas les remplacer par `prisma db push`.
- Distinguer tests Linux, tests natifs Windows/macOS, tests avec doubles et tests sur PostgreSQL réel. Ne jamais annoncer une fonctionnalité opérationnelle ou une restauration exacte sans preuve.
- Préserver les modifications utilisateur. Après reconstruction : commit, archive vérifiée hors checkout et vérification du SHA distant lors d'une sauvegarde GitHub autorisée. Ne pas confondre publication cloud et sauvegarde Git.
- Utiliser pnpm et les verrouillages pnpm/Cargo. `apps/desktop`, `apps/api`, `packages/shared`, `packages/local-store`, `docs` sont les frontières du monorepo.
