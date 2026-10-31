import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { errors } from './errors.js';

/**
 * HS256 access tokens. Both services share JWT_SECRET: store-service signs,
 * every route in both services verifies locally (no network call per request).
 */
export function createJwt(config) {
  const key = new TextEncoder().encode(config.JWT_SECRET);
  return {
    sign: (user, ttlSeconds) =>
      new SignJWT({ email: user.email, name: user.name, role: user.role })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(user.id)
        .setIssuer(config.JWT_ISSUER)
        .setAudience(config.JWT_AUDIENCE)
        .setIssuedAt()
        .setJti(randomUUID())
        .setExpirationTime(`${ttlSeconds}s`)
        .sign(key),
    verify: async (token) => {
      const { payload } = await jwtVerify(token, key, {
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        algorithms: ['HS256'],
        clockTolerance: 5,
      });
      return payload;
    },
  };
}

function classifyVerifyError(err) {
  if (err?.code === 'ERR_JWT_EXPIRED') return errors.unauthorized('Access token has expired', 'TOKEN_EXPIRED');
  if (err instanceof joseErrors.JOSEError) return errors.unauthorized('Access token is invalid', 'INVALID_TOKEN');
  return errors.unauthorized('Unable to verify credentials', 'INVALID_TOKEN');
}

export function createAuthMiddleware(verify) {
  async function resolveUser(req) {
    const header = req.get('authorization');
    if (!header) return null;
    const [scheme, token, extra] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token || extra) {
      throw errors.unauthorized('Authorization header must be "Bearer <token>"', 'INVALID_AUTH_HEADER');
    }
    let payload;
    try {
      payload = await verify(token);
    } catch (err) {
      throw classifyVerifyError(err);
    }
    return { id: payload.sub, email: payload.email, name: payload.name, role: payload.role ?? 'customer', tokenId: payload.jti };
  }

  return {
    authenticate: async (req, _res, next) => {
      const user = await resolveUser(req);
      if (!user) throw errors.unauthorized();
      req.user = user;
      next();
    },
    optionalAuth: async (req, _res, next) => {
      try {
        req.user = (await resolveUser(req)) ?? undefined;
      } catch {
        req.user = undefined;
      }
      next();
    },
    requireRole:
      (...roles) =>
      (req, _res, next) => {
        if (!req.user) throw errors.unauthorized();
        if (!roles.includes(req.user.role)) throw errors.forbidden();
        next();
      },
  };
}

const digest = (v) => createHash('sha256').update(String(v)).digest();

/** Guards service-to-service endpoints with a shared secret header. */
export function requireInternal(internalKey) {
  const expected = digest(internalKey);
  return (req, _res, next) => {
    const provided = req.get('x-internal-key');
    if (!provided || !timingSafeEqual(digest(provided), expected)) {
      throw errors.unauthorized('A valid internal service key is required', 'INTERNAL_AUTH_REQUIRED');
    }
    req.internal = true;
    next();
  };
}
