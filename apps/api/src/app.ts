import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import { ValidationFilter, DataErrorFilter } from './validation.filter';
export function configureApp(app: INestApplication, origins: string[]) {
  app.use(helmet());
  app.enableCors({ origin: origins, methods: ['GET', 'POST', 'PUT'], credentials: false });
  app.useGlobalFilters(new ValidationFilter(), new DataErrorFilter());
  app.use(
    (_req: unknown, res: { setHeader(name: string, value: string): void }, next: () => void) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
  );
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
}
