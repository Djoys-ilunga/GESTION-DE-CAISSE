import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
export function configureApp(app: INestApplication, origins: string[]) {
  app.use(helmet());
  app.enableCors({ origin: origins, methods: ['GET'], credentials: false });
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
}
