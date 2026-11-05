import { Catch, type ExceptionFilter, type ArgumentsHost } from '@nestjs/common';
import { ZodError } from 'zod';
import { DataError } from './data/central-access';
@Catch(ZodError)
export class ValidationFilter implements ExceptionFilter {
  catch(_error: ZodError, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<{ status(n: number): { json(value: unknown): void } }>()
      .status(400)
      .json({ statusCode: 400, message: 'Données invalides.' });
  }
}
@Catch(DataError)
export class DataErrorFilter implements ExceptionFilter {
  catch(error: DataError, host: ArgumentsHost) {
    const status = error.code.includes('SESSION_REVOKED')
      ? 401
      : error.code.includes('ACCESS_DENIED')
        ? 403
        : error.code.includes('NOT_FOUND')
          ? 404
          : 409;
    host
      .switchToHttp()
      .getResponse<{ status(n: number): { json(value: unknown): void } }>()
      .status(status)
      .json({
        statusCode: status,
        message:
          status === 403
            ? 'Autorisation insuffisante.'
            : status === 401
              ? 'Session indisponible.'
              : 'Conflit ou données invalides.',
      });
  }
}
