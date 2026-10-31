import http from 'node:http';
import { loadEnv } from './config.js';

/** Boots an HTTP server with proxy-friendly timeouts and graceful shutdown. */
export function startServer({ app, config, logger, onShutdown }) {
  const server = http.createServer(app);
  // Keep-alive must outlive typical load balancer idle timeouts (60s) to avoid 502s.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  server.on('error', (err) => {
    logger.fatal({ err }, 'HTTP server error');
    process.exit(1);
  });

  server.listen(config.PORT, config.HOST, () => {
    logger.info({ host: config.HOST, port: server.address().port }, `${config.SERVICE_NAME} listening on :${server.address().port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');
    const force = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000);
    force.unref();
    server.close(async (err) => {
      try {
        await onShutdown?.();
      } catch (shutdownErr) {
        logger.error({ err: shutdownErr }, 'Error during shutdown');
      }
      clearTimeout(force);
      process.exit(err ? 1 : 0);
    });
    server.closeIdleConnections();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });
  return server;
}

/** Entry point helper: load env, build the service, start it; exit clearly on config/startup errors. */
export async function runService(factory) {
  loadEnv();
  try {
    const service = await factory();
    startServer({ app: service.app, config: service.config, logger: service.logger, onShutdown: service.shutdown });
  } catch (err) {
    console.error(err.code === 'CONFIG_INVALID' ? err.message : err);
    process.exit(1);
  }
}
