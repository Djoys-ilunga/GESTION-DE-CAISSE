import { config } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';
export function readConfig() {
  config({ path: resolve(__dirname, '../../../.env'), quiet: true });
  const parsed = z
    .object({
      DATABASE_URL: z.string().startsWith('postgresql://'),
      API_DEPLOYMENT_ID: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
      API_HOST: z.string().default('127.0.0.1'),
      API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      CORS_ORIGINS: z.string().default('http://localhost:1420,http://127.0.0.1:1420'),
    })
    .safeParse(process.env);
  if (!parsed.success) throw new Error('Configuration API invalide.');
  return parsed.data;
}
