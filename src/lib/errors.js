export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.isAppError = true;
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const errors = {
  badRequest: (message = 'Bad request', details) => new AppError(400, 'BAD_REQUEST', message, details),
  validation: (details, message = 'Request validation failed') => new AppError(400, 'VALIDATION_ERROR', message, details),
  unauthorized: (message = 'Authentication required', code = 'UNAUTHORIZED') => new AppError(401, code, message),
  forbidden: (message = 'You do not have permission to perform this action', code = 'FORBIDDEN') =>
    new AppError(403, code, message),
  notFound: (resource = 'Resource', code = 'NOT_FOUND') => new AppError(404, code, `${resource} not found`),
  conflict: (message, code = 'CONFLICT', details) => new AppError(409, code, message, details),
  unprocessable: (message, code = 'UNPROCESSABLE', details) => new AppError(422, code, message, details),
  tooManyRequests: (message = 'Too many requests, please try again later') =>
    new AppError(429, 'RATE_LIMITED', message),
  upstream: (service, message, code = 'UPSTREAM_UNAVAILABLE', status = 503) =>
    new AppError(status, code, message ?? `The ${service} service is currently unavailable`, { service }),
};

export function isAppError(err) {
  return Boolean(err && (err instanceof AppError || err.isAppError));
}

export function notFoundHandler(req, _res, next) {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`));
}

export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    let appErr = err;
    if (err?.type === 'entity.parse.failed') {
      appErr = new AppError(400, 'INVALID_JSON', 'Request body contains invalid JSON');
    } else if (err?.type === 'entity.too.large') {
      appErr = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    } else if (err?.type === 'encoding.unsupported' || err?.type === 'charset.unsupported') {
      appErr = new AppError(415, 'UNSUPPORTED_ENCODING', 'Unsupported request body encoding');
    } else if (err?.name?.startsWith('Mongo')) {
      (req.log ?? logger).error({ err }, 'Database error');
      appErr = new AppError(503, 'DATABASE_UNAVAILABLE', 'The database is currently unavailable');
    } else if (!isAppError(err)) {
      (req.log ?? logger).error({ err }, 'Unhandled error');
      appErr = new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    } else if (appErr.status >= 500) {
      (req.log ?? logger).warn({ code: appErr.code, details: appErr.details }, appErr.message);
    }

    if (res.headersSent) return;
    res.status(appErr.status).json({
      error: {
        code: appErr.code,
        message: appErr.message,
        ...(appErr.details !== undefined ? { details: appErr.details } : {}),
        requestId: req.id,
      },
    });
  };
}
