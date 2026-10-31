import { createApp } from './lib/app.js';
import { createAuthMiddleware, createJwt } from './lib/auth.js';
import { connectDb } from './lib/db.js';
import { createServiceClient } from './lib/http-client.js';
import { createLogger } from './lib/logger.js';
import { getConfig } from './config.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCartRoutes } from './routes/cart.js';
import { createCatalog, registerProductsRoutes } from './routes/products.js';
import { registerUsersRoutes } from './routes/users.js';
import { ensureIndexes, seed } from './seed.js';

/**
 * ecomm-store-node: auth, users, products and cart in one process.
 * Calls ecomm-orders-python for notifications; ecomm-orders-python calls back into the
 * /internal routes here for carts, addresses and stock reservations.
 */
export async function createStoreService() {
  const config = getConfig();
  const logger = createLogger(config);
  const mongo = await connectDb(config, logger);
  await ensureIndexes(mongo.db);
  if (config.SEED_DATA) await seed(mongo.db, config, logger);

  const jwt = createJwt(config);
  const auth = createAuthMiddleware(jwt.verify);
  const orders = createServiceClient({
    name: 'ecomm-orders-python',
    baseUrl: config.ORDERS_SERVICE_URL,
    internalKey: config.INTERNAL_API_KEY,
    timeoutMs: config.UPSTREAM_TIMEOUT_MS,
    logger,
  });
  const ctx = { config, logger, db: mongo.db, jwt, auth, orders, catalog: createCatalog(mongo.db) };

  const app = createApp({
    config,
    logger,
    readiness: { mongodb: mongo.ping },
    dependencies: {
      mongodb: { check: mongo.ping },
      'ecomm-orders-python': { check: orders.ping, target: orders.baseUrl },
    },
    mounts: {
      '/api/auth': (r) => registerAuthRoutes(r, ctx),
      '/api/users': (r) => registerUsersRoutes(r, ctx),
      '/api/products': (r) => registerProductsRoutes(r, ctx),
      '/api/cart': (r) => registerCartRoutes(r, ctx),
    },
  });

  return { app, config, logger, shutdown: () => mongo.client.close() };
}
