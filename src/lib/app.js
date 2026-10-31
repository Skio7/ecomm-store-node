import os from 'node:os';
import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { errorHandler, errors, notFoundHandler } from './errors.js';
import { requestIdMiddleware } from './logger.js';

const QUIET_PATHS = /\/(healthz|readyz|health(\/[a-z]+)?)$/;
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'x-internal-key']);

function corsOptions(config) {
  const origins = config.CORS_ORIGINS;
  let origin;
  if (origins.includes('*')) origin = true;
  else if (origins.length) origin = origins;
  else origin = !config.isProduction; // dev: reflect any origin; prod: same-origin only unless configured
  return {
    origin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After', 'Idempotent-Replayed'],
    maxAge: 600,
  };
}

/** Echoes what the service actually received — useful for debugging proxy/path routing. */
function echoHandler(req, res) {
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, SENSITIVE_HEADERS.has(k) ? '[present]' : v]));
  res.json({
    method: req.method,
    originalUrl: req.originalUrl,
    baseUrl: req.baseUrl,
    path: req.path,
    query: req.query,
    protocol: req.protocol,
    hostname: req.hostname,
    ip: req.ip,
    ips: req.ips,
    headers,
    body: req.body ?? null,
  });
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function runChecks(checks, timeoutMs) {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, fn]) => {
      const started = performance.now();
      try {
        await withTimeout(Promise.resolve().then(fn), timeoutMs);
        return [name, { status: 'up', latencyMs: Math.round(performance.now() - started) }];
      } catch (err) {
        return [name, { status: 'down', latencyMs: Math.round(performance.now() - started), error: err.message }];
      }
    }),
  );
  return { healthy: entries.every(([, r]) => r.status === 'up'), results: Object.fromEntries(entries) };
}

/**
 * Health endpoints:
 * - live: process is up (no dependency checks; safe for liveness probes)
 * - ready: this service's own resources (the database) are usable
 * - dependencies: database + the other service, with latency (diagnostics, not a probe)
 *
 * `dependencies` maps a name to `{ check, target }`.
 */
function createHealthHandlers({ config, readiness, dependencies }) {
  const startedAt = Date.now();
  const meta = (basePath) => ({
    service: config.SERVICE_NAME,
    version: config.SERVICE_VERSION,
    environment: config.NODE_ENV,
    ...(basePath ? { basePath } : {}),
    hostname: os.hostname(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
  const noStore = (res) => res.set('cache-control', 'no-store');

  return {
    live: (req, res) => noStore(res).json({ status: 'ok', ...meta(req.baseUrl) }),
    ready: async (req, res) => {
      const { healthy, results } = await runChecks(readiness, 2000);
      noStore(res).status(healthy ? 200 : 503).json({ status: healthy ? 'ready' : 'not_ready', ...meta(req.baseUrl), checks: results });
    },
    summary: async (req, res) => {
      const { healthy, results } = await runChecks(readiness, 2000);
      const mem = process.memoryUsage();
      noStore(res)
        .status(healthy ? 200 : 503)
        .json({
          status: healthy ? 'ok' : 'degraded',
          ...meta(req.baseUrl),
          node: process.version,
          memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
          checks: results,
        });
    },
    dependencies: async (req, res) => {
      const checks = Object.fromEntries(Object.entries(dependencies).map(([name, d]) => [name, d.check]));
      const { healthy, results } = await runChecks(checks, 3000);
      for (const [name, result] of Object.entries(results)) if (dependencies[name].target) result.target = dependencies[name].target;
      noStore(res).status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', ...meta(req.baseUrl), dependencies: results });
    },
  };
}

/**
 * Express app serving several API prefixes from one process. `mounts` maps a
 * prefix (e.g. `/api/cart`) to a function that registers that module's routes.
 * Every prefix also gets `/health*`, `/info` and (optionally) `/debug/echo`, so
 * path routing can be checked per prefix. `/healthz` and `/readyz` live at the root.
 */
export function createApp({ config, logger, mounts, readiness = {}, dependencies = {} }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => QUIET_PATHS.test(req.url.split('?')[0]) },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      customSuccessMessage: (req, res, time) => `${req.method} ${req.originalUrl} ${res.statusCode} ${Math.round(time)}ms`,
      customErrorMessage: (req, res) => `${req.method} ${req.originalUrl} ${res.statusCode} failed`,
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url, remoteAddress: req.remoteAddress }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(cors(corsOptions(config)));
  app.use(express.json({ limit: '100kb' }));

  const health = createHealthHandlers({ config, readiness, dependencies });
  app.get('/healthz', health.live);
  app.get('/readyz', health.ready);
  app.get('/', (_req, res) => res.json({ service: config.SERVICE_NAME, version: config.SERVICE_VERSION, prefixes: Object.keys(mounts) }));

  const limiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    limit: config.RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => req.path.startsWith('/internal/') || QUIET_PATHS.test(req.path),
    handler: (_req, _res, next) => next(errors.tooManyRequests()),
  });
  app.use(limiter);

  for (const [prefix, register] of Object.entries(mounts)) {
    const router = express.Router();
    router.get('/health', health.summary);
    router.get('/health/live', health.live);
    router.get('/health/ready', health.ready);
    router.get('/health/dependencies', health.dependencies);
    router.get('/info', (req, res) => {
      res.json({
        service: config.SERVICE_NAME,
        module: prefix.split('/').pop(),
        version: config.SERVICE_VERSION,
        environment: config.NODE_ENV,
        basePath: prefix,
        health: `${req.baseUrl}/health`,
        timestamp: new Date().toISOString(),
      });
    });
    if (config.ENABLE_DEBUG_ENDPOINTS) router.all('/debug/echo', echoHandler);
    register(router);
    app.use(prefix, router);
  }

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}

/** Stricter limiter for credential endpoints (login/register). */
export function strictRateLimit({ windowMs = 15 * 60_000, limit = 20 } = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(errors.tooManyRequests('Too many attempts, please try again later')),
  });
}
