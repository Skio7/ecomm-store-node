import { trimTrailingSlash } from './config.js';
import { AppError, errors } from './errors.js';
import { currentRequestId } from './logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

/**
 * JSON client for calls to the other service.
 *
 * - Adds the internal key and propagates the current request id.
 * - Retries idempotent requests on network errors / 5xx with backoff.
 * - Maps failures to meaningful errors: business 4xx pass through, while
 *   misrouting (404 route not found), internal-auth failures and 5xx become
 *   502/503 so a broken deployment is easy to diagnose.
 */
export function createServiceClient({ name, baseUrl, internalKey, timeoutMs = 5000, retries = 2, logger }) {
  const root = trimTrailingSlash(baseUrl);

  async function request(method, path, { body, headers = {}, retry, timeout = timeoutMs } = {}) {
    const url = `${root}${path}`;
    const canRetry = retry ?? IDEMPOTENT.has(method);
    const requestId = currentRequestId();
    for (let attempt = 1; ; attempt++) {
      let res;
      const started = performance.now();
      try {
        res = await fetch(url, {
          method,
          headers: {
            accept: 'application/json',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(internalKey ? { 'x-internal-key': internalKey } : {}),
            ...(requestId ? { 'x-request-id': requestId } : {}),
            ...headers,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeout),
        });
      } catch (err) {
        if (canRetry && attempt <= retries) {
          await sleep(100 * 2 ** attempt);
          continue;
        }
        const timedOut = err?.name === 'TimeoutError';
        logger?.warn({ upstream: name, method, url, err: { message: err.message, cause: err.cause?.code } }, 'Upstream call failed');
        throw errors.upstream(
          name,
          timedOut ? `The ${name} timed out` : `The ${name} is unreachable`,
          timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
          timedOut ? 504 : 503,
        );
      }

      if (res.status >= 500 && canRetry && attempt <= retries) {
        await sleep(100 * 2 ** attempt);
        continue;
      }

      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text.slice(0, 300) };
        }
      }
      logger?.debug({ upstream: name, method, url, status: res.status, durationMs: Math.round(performance.now() - started) }, 'Upstream call');
      if (res.ok) return data;

      const upstreamError = data?.error;
      if (res.status === 401 || res.status === 403) {
        throw new AppError(502, 'UPSTREAM_AUTH_FAILED', `Authentication with the ${name} failed (check INTERNAL_API_KEY)`, { service: name });
      }
      if (res.status === 404 && (!upstreamError || upstreamError.code === 'ROUTE_NOT_FOUND')) {
        throw new AppError(502, 'UPSTREAM_ROUTE_NOT_FOUND', `The ${name} route ${method} ${path} was not found`, { service: name, url });
      }
      if (res.status >= 500 || !upstreamError) {
        throw new AppError(502, 'UPSTREAM_ERROR', `The ${name} returned an error`, {
          service: name,
          status: res.status,
          ...(upstreamError ? { upstreamCode: upstreamError.code } : {}),
        });
      }
      throw new AppError(res.status, upstreamError.code, upstreamError.message, upstreamError.details);
    }
  }

  return {
    name,
    baseUrl: root,
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts) => request('POST', path, { ...opts, body }),
    patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
    delete: (path, opts) => request('DELETE', path, opts),
    ping: () => request('GET', '/healthz', { retry: false, timeout: 2000 }),
  };
}
