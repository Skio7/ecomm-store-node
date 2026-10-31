import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-internal-key"]',
  'password',
  '*.password',
  'currentPassword',
  'newPassword',
  'card',
  '*.card',
  'refreshToken',
  '*.refreshToken',
  'accessToken',
  '*.accessToken',
];

export function createLogger(config) {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: config.SERVICE_NAME, version: config.SERVICE_VERSION, env: config.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: { level: (label) => ({ level: label }) },
  });
}

/** Per-request context so outbound service calls propagate the request id automatically. */
export const requestContext = new AsyncLocalStorage();

export function currentRequestId() {
  return requestContext.getStore()?.requestId;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestIdMiddleware(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', req.id);
  requestContext.run({ requestId: req.id }, next);
}
