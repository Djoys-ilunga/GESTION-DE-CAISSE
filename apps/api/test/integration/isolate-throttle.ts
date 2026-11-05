import { randomBytes } from 'node:crypto';
// Uniquement les bases jetables : chaque fichier conserve ses compteurs et les vrais plafonds.
if (
  process.env.CAISSEPRO_INTEGRITY_TEST !== '1' ||
  !/^\/caissepro_test_[0-9a-f]+$/.test(new URL(process.env.DATABASE_URL!).pathname)
)
  throw new Error('Base de test jetable obligatoire.');
process.env.AUTH_RATE_LIMIT_SECRET = randomBytes(32).toString('hex');
