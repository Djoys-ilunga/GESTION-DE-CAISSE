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
    const domainCode = error.code.replace(/^CAISSEPRO_/, '');
    const publicCodes = [
      'REPORT_TOO_LARGE',
      'REPORT_DATES_INVALID',
      'CLOSURE_CONFLICT',
      'CLOSURE_RESERVED_FUNDS',
      'TRANSFER_CONFLICT',
      'TRANSFER_DISTINCT_RECEIVER_REQUIRED',
      'EXPENSE_POLICY_REQUIRED',
      'EXPENSE_LIMIT_EXCEEDED',
      'EXPENSE_EVIDENCE_REQUIRED',
      'INSUFFICIENT_FUNDS',
      'CASH_SESSION_REQUIRED',
      'EXPENSE_VERSION_CONFLICT',
      'EXPENSE_NOT_APPROVED',
      'EXPENSE_STATE_CONFLICT',
      'EXPENSE_POLICY_CONFLICT',
      'SELF_APPROVAL_FORBIDDEN',
      'DRAFT_ALREADY_SUBMITTED',
      'EVIDENCE_INVALID',
      'POLICY_INVALID',
      'POLICY_CONFLICT',
      'SYNC_RATE_LIMIT',
      'DRAFT_DATES_INVALID',
      'DRAFT_EXPIRED',
      'DRAFT_CASH_REQUIRED',
    ];
    const status = error.code.includes('SYNC_RATE_LIMIT')
      ? 429
      : error.code.includes('SESSION_REVOKED')
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
        ...(publicCodes.includes(domainCode) ? { code: domainCode } : {}),
        message:
          status === 403
            ? 'Autorisation insuffisante.'
            : status === 401
              ? 'Session indisponible.'
              : 'Conflit ou données invalides.',
      });
  }
}
