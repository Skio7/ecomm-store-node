import fs from 'node:fs';
import { z } from 'zod';

/** Loads `./.env` for local development. Never runs in production: there, config comes from the platform. */
export function loadEnv() {
  if (process.env.NODE_ENV === 'production') return;
  if (fs.existsSync('.env')) process.loadEnvFile('.env');
}

export const trimTrailingSlash = (url) => String(url).replace(/\/+$/, '');

function parseTrustProxy(value) {
  const v = value.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return value;
}

export const zEnv = {
  bool: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()))),
  csv: z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  url: z.string().url().transform(trimTrailingSlash),
};

const baseShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string(),
  SERVICE_VERSION: z.string().default('2.0.0'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: zEnv.csv.default([]),
  TRUST_PROXY: z.string().default('1').transform(parseTrustProxy),
  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb:// or mongodb+srv:// URL'),
  MONGODB_DB: z.string().min(1).optional(),
  SEED_DATA: zEnv.bool.default(true),
  JWT_SECRET: z.string().min(16, 'must be at least 16 characters'),
  JWT_ISSUER: z.string().default('deploykar-shop'),
  JWT_AUDIENCE: z.string().default('deploykar-shop'),
  INTERNAL_API_KEY: z.string().min(16, 'must be at least 16 characters'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  ENABLE_DEBUG_ENDPOINTS: zEnv.bool.default(false),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
};

const DEV_DEFAULTS = {
  MONGODB_URI: 'mongodb://127.0.0.1:27017/deploykar_shop',
  JWT_SECRET: 'dev-jwt-secret-not-for-production',
  INTERNAL_API_KEY: 'dev-internal-key-not-for-production',
};

/**
 * Builds a validated, frozen config object.
 *
 * - `defaults` apply everywhere (e.g. PORT).
 * - `devDefaults` apply only outside production (localhost URLs, dev secrets), so a
 *   production deploy with missing configuration fails fast instead of half-working.
 * - DATABASE_URL is accepted as an alias for MONGODB_URI.
 */
export function loadConfig({ service, schema = {}, defaults = {}, devDefaults = {}, env = process.env, refine }) {
  const isProd = (env.NODE_ENV ?? 'development') === 'production';
  const input = { ...defaults, ...(isProd ? {} : { ...DEV_DEFAULTS, ...devDefaults }) };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') input[key] = value;
  }
  if (!env.MONGODB_URI && env.DATABASE_URL) input.MONGODB_URI = env.DATABASE_URL;
  input.SERVICE_NAME = service;

  const full = z.object({ ...baseShape, ...schema }).superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV === 'production') {
      for (const key of ['JWT_SECRET', 'INTERNAL_API_KEY']) {
        if (cfg[key].length < 32) ctx.addIssue({ code: 'custom', path: [key], message: 'must be at least 32 characters in production' });
      }
    }
    refine?.(cfg, ctx);
  });

  const result = full.safeParse(input);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    const err = new Error(`Invalid configuration for ${service}:\n${lines.join('\n')}`);
    err.code = 'CONFIG_INVALID';
    throw err;
  }
  return Object.freeze({
    ...result.data,
    isProduction: result.data.NODE_ENV === 'production',
  });
}
