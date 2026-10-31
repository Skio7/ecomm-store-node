import { loadConfig, zEnv } from './lib/config.js';
import { z } from 'zod';

export function getConfig(env = process.env) {
  return loadConfig({
    service: 'store-service',
    env,
    defaults: { PORT: 4001 },
    devDefaults: { ORDERS_SERVICE_URL: 'http://localhost:4002' },
    schema: {
      // Origin of orders-service (no path), e.g. https://orders.example.com — used for notifications.
      ORDERS_SERVICE_URL: zEnv.url,
      ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(900),
      REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
      BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(14).default(10),
      LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
      LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),
      AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
      SEED_ADMIN_PASSWORD: z.string().min(10).optional(),
      SEED_CUSTOMER_PASSWORD: z.string().min(8).default('Customer@123'),
    },
  });
}
