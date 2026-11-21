import { HttpException } from '@nestjs/common';
import { ERROR_CODES, ErrorCode } from '@pos/contracts';

export class AppError extends HttpException {
  constructor(
    status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const E = {
  unauthenticated: (m = 'Authentication required') => new AppError(401, ERROR_CODES.UNAUTHENTICATED, m),
  forbidden: (m = 'You do not have permission for this action') => new AppError(403, ERROR_CODES.FORBIDDEN, m),
  featureNotEnabled: (key: string) =>
    new AppError(403, ERROR_CODES.FEATURE_NOT_ENABLED, `Feature "${key}" is not enabled for this shop`, { feature: key }),
  planLimit: (resource: string, limit: number) =>
    new AppError(403, ERROR_CODES.PLAN_LIMIT, `Plan limit reached for ${resource} (${limit})`, { resource, limit }),
  subscriptionRestricted: (m = 'Subscription is restricted: read-only') =>
    new AppError(402, ERROR_CODES.SUBSCRIPTION_RESTRICTED, m),
  notFound: (what: string) => new AppError(404, ERROR_CODES.NOT_FOUND, `${what} not found`),
  validation: (m: string, details?: unknown) => new AppError(400, ERROR_CODES.VALIDATION, m, details),
  conflict: (m: string, details?: unknown) => new AppError(409, ERROR_CODES.CONFLICT, m, details),
  versionConflict: () =>
    new AppError(409, ERROR_CODES.VERSION_CONFLICT, 'Record was changed by someone else. Reload and try again.'),
  stockShort: (details: unknown) =>
    new AppError(409, ERROR_CODES.STOCK_SHORT, 'Not enough stock available', details),
  creditLimit: (details: unknown) =>
    new AppError(409, ERROR_CODES.CREDIT_LIMIT, 'Credit limit exceeded', details),
  approvalRequired: (action: string) =>
    new AppError(403, ERROR_CODES.APPROVAL_REQUIRED, `Supervisor approval required for ${action}`, { action }),
  idempotencyMismatch: () =>
    new AppError(409, ERROR_CODES.IDEMPOTENCY_MISMATCH, 'Idempotency key was already used with a different request'),
};
