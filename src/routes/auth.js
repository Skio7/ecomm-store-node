import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { strictRateLimit } from '../lib/app.js';
import { isDuplicateKey } from '../lib/db.js';
import { AppError, errors } from '../lib/errors.js';
import { newId, nowIso, paginateQuery, paginationQuery, validate } from '../lib/util.js';

const email = z.string().trim().toLowerCase().email('Must be a valid email address').max(254);
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');
const name = z.string().trim().min(2, 'Name must be at least 2 characters').max(80);
const refreshBody = { refreshToken: z.string().min(10).max(512) };

export function publicUser(u) {
  return { id: u._id, email: u.email, name: u.name, role: u.role, status: u.status, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt };
}

const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function safeEqualHex(a, b) {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Access tokens: short-lived HS256 JWTs verified locally by both services.
 * Refresh tokens: opaque `<id>.<secret>`, stored hashed, rotated on every use.
 * Presenting an already-rotated token revokes its whole family (theft detection).
 */
function createTokenService({ config, db, jwt, logger }) {
  const refreshTokens = db.collection('refresh_tokens');

  async function issueSession(user, meta = {}, familyId) {
    const accessToken = await jwt.sign({ id: user._id, email: user.email, name: user.name, role: user.role }, config.ACCESS_TOKEN_TTL_SECONDS);
    const id = newId('rt');
    const secret = randomBytes(32).toString('base64url');
    await refreshTokens.insertOne({
      _id: id,
      userId: user._id,
      familyId: familyId ?? id,
      tokenHash: sha256(secret),
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      revokedAt: null,
      replacedBy: null,
      userAgent: meta.userAgent?.slice(0, 200) ?? null,
      ip: meta.ip ?? null,
    });
    return { accessToken, refreshToken: `${id}.${secret}`, tokenType: 'Bearer', expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, refreshTokenId: id };
  }

  async function findRecord(rawToken) {
    const [id, secret] = String(rawToken).split('.');
    const record = id && secret ? await refreshTokens.findOne({ _id: id }) : null;
    if (!record || !safeEqualHex(sha256(secret), record.tokenHash)) {
      throw errors.unauthorized('Refresh token is invalid', 'INVALID_REFRESH_TOKEN');
    }
    return record;
  }

  const revokeFamily = (familyId) => refreshTokens.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: nowIso() } });

  async function rotate(rawToken, meta, users) {
    const record = await findRecord(rawToken);
    if (record.revokedAt) {
      if (record.replacedBy) {
        await revokeFamily(record.familyId);
        logger.warn({ userId: record.userId, familyId: record.familyId }, 'Refresh token reuse detected; family revoked');
        throw errors.unauthorized('Refresh token reuse detected; please sign in again', 'REFRESH_TOKEN_REUSED');
      }
      throw errors.unauthorized('Refresh token has been revoked', 'INVALID_REFRESH_TOKEN');
    }
    if (record.expiresAt.getTime() <= Date.now()) throw errors.unauthorized('Refresh token has expired', 'REFRESH_TOKEN_EXPIRED');
    const user = await users.findOne({ _id: record.userId });
    if (!user || user.status !== 'active') {
      await revokeFamily(record.familyId);
      throw errors.unauthorized('Account is not active', 'ACCOUNT_DISABLED');
    }
    // Claim the token atomically so two concurrent refreshes cannot both succeed.
    const claimed = await refreshTokens.findOneAndUpdate({ _id: record._id, revokedAt: null }, { $set: { revokedAt: nowIso() } });
    if (!claimed) throw errors.unauthorized('Refresh token has been revoked', 'INVALID_REFRESH_TOKEN');
    const session = await issueSession(user, meta, record.familyId);
    await refreshTokens.updateOne({ _id: record._id }, { $set: { replacedBy: session.refreshTokenId } });
    return { user, session };
  }

  async function revoke(rawToken) {
    try {
      const record = await findRecord(rawToken);
      await refreshTokens.updateOne({ _id: record._id, revokedAt: null }, { $set: { revokedAt: nowIso() } });
    } catch {
      /* logout is idempotent; unknown tokens are ignored */
    }
  }

  const revokeAllForUser = (userId) => refreshTokens.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: nowIso() } });

  return { issueSession, rotate, revoke, revokeAllForUser };
}

export function registerAuthRoutes(router, { config, db, jwt, auth, orders, logger }) {
  const users = db.collection('users');
  const tokens = createTokenService({ config, db, jwt, logger });
  const dummyHash = bcrypt.hashSync('timing-equaliser-password', 4);
  const credentialLimiter = strictRateLimit({ limit: config.AUTH_RATE_LIMIT_MAX });
  const requestMeta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });
  const sessionResponse = (user, { refreshTokenId: _omit, ...session }) => ({ user: publicUser(user), ...session });

  // Cross-service call: notifications live in orders-service. Best-effort — auth never fails because of it.
  const notify = (user, type) =>
    orders
      .post('/api/notifications/internal/notifications', { userId: user._id, email: user.email, type, data: { name: user.name } }, { retry: true })
      .catch((err) => logger.warn({ err: err.message, type }, 'Failed to send notification'));

  router.post('/register', credentialLimiter, validate({ body: { email, password, name } }), async (req, res) => {
    const { email: e, password: p, name: n } = req.valid.body;
    const now = nowIso();
    const user = {
      _id: newId('usr'),
      email: e,
      name: n,
      role: 'customer',
      status: 'active',
      passwordHash: await bcrypt.hash(p, config.BCRYPT_ROUNDS),
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await users.insertOne(user);
    } catch (err) {
      if (isDuplicateKey(err)) throw errors.conflict('An account with this email already exists', 'EMAIL_TAKEN');
      throw err;
    }
    const session = await tokens.issueSession(user, requestMeta(req));
    req.log.info({ userId: user._id }, 'User registered');
    notify(user, 'welcome');
    res.status(201).json(sessionResponse(user, session));
  });

  router.post(
    '/login',
    credentialLimiter,
    validate({ body: { email, password: z.string().min(1, 'Password is required').max(128) } }),
    async (req, res) => {
      const { email: e, password: p } = req.valid.body;
      const user = await users.findOne({ email: e });
      if (!user) {
        await bcrypt.compare(p, dummyHash); // equalise timing to avoid account enumeration
        throw errors.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
      }
      if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
        throw new AppError(423, 'ACCOUNT_LOCKED', 'Account temporarily locked after repeated failed sign-ins', { lockedUntil: user.lockedUntil });
      }
      if (!(await bcrypt.compare(p, user.passwordHash))) {
        const attempts = (user.failedLoginAttempts ?? 0) + 1;
        const lock = attempts >= config.LOGIN_MAX_ATTEMPTS;
        await users.updateOne(
          { _id: user._id },
          { $set: { failedLoginAttempts: lock ? 0 : attempts, lockedUntil: lock ? new Date(Date.now() + config.LOGIN_LOCK_MINUTES * 60_000).toISOString() : null } },
        );
        if (lock) req.log.warn({ userId: user._id }, 'Account locked after failed sign-ins');
        throw errors.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
      }
      if (user.status !== 'active') throw errors.forbidden('This account has been disabled', 'ACCOUNT_DISABLED');
      const updated = await users.findOneAndUpdate(
        { _id: user._id },
        { $set: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: nowIso() } },
        { returnDocument: 'after' },
      );
      const session = await tokens.issueSession(updated, requestMeta(req));
      res.json(sessionResponse(updated, session));
    },
  );

  router.post('/refresh', validate({ body: refreshBody }), async (req, res) => {
    const { user, session } = await tokens.rotate(req.valid.body.refreshToken, requestMeta(req), users);
    res.json(sessionResponse(user, session));
  });

  router.post('/logout', validate({ body: refreshBody }), async (req, res) => {
    await tokens.revoke(req.valid.body.refreshToken);
    res.status(204).end();
  });

  router.get('/me', auth.authenticate, async (req, res) => {
    const user = await users.findOne({ _id: req.user.id });
    if (!user) throw errors.notFound('User');
    res.json({ user: publicUser(user) });
  });

  router.patch('/me', auth.authenticate, validate({ body: { name } }), async (req, res) => {
    const user = await users.findOneAndUpdate({ _id: req.user.id }, { $set: { name: req.valid.body.name, updatedAt: nowIso() } }, { returnDocument: 'after' });
    if (!user) throw errors.notFound('User');
    res.json({ user: publicUser(user) });
  });

  router.post(
    '/change-password',
    auth.authenticate,
    validate({ body: { currentPassword: z.string().min(1).max(128), newPassword: password } }),
    async (req, res) => {
      const { currentPassword, newPassword } = req.valid.body;
      const user = await users.findOne({ _id: req.user.id });
      if (!user) throw errors.notFound('User');
      if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
        throw errors.unprocessable('Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
      }
      if (currentPassword === newPassword) throw errors.unprocessable('New password must differ from the current password', 'PASSWORD_UNCHANGED');
      await users.updateOne({ _id: user._id }, { $set: { passwordHash: await bcrypt.hash(newPassword, config.BCRYPT_ROUNDS), updatedAt: nowIso() } });
      await tokens.revokeAllForUser(user._id);
      const session = await tokens.issueSession(user, requestMeta(req));
      notify(user, 'password_changed');
      res.json(sessionResponse(user, session));
    },
  );

  // ---- Admin ----
  router.get(
    '/users',
    auth.authenticate,
    auth.requireRole('admin'),
    validate({ query: { ...paginationQuery, q: z.string().trim().max(100).optional(), role: z.enum(['customer', 'admin']).optional() } }),
    async (req, res) => {
      const { q, role, page, limit } = req.valid.query;
      const filter = {
        ...(role ? { role } : {}),
        ...(q ? { $or: [{ email: { $regex: escapeRegex(q.toLowerCase()) } }, { name: { $regex: escapeRegex(q), $options: 'i' } }] } : {}),
      };
      res.json(await paginateQuery(users, filter, { sort: { createdAt: -1 }, page, limit, map: publicUser }));
    },
  );

  router.patch(
    '/users/:id',
    auth.authenticate,
    auth.requireRole('admin'),
    validate({
      params: { id: z.string().min(1).max(64) },
      body: z
        .object({ role: z.enum(['customer', 'admin']).optional(), status: z.enum(['active', 'disabled']).optional() })
        .refine((b) => b.role || b.status, 'Provide role and/or status'),
    }),
    async (req, res) => {
      const { id } = req.valid.params;
      if (id === req.user.id) throw errors.unprocessable('Administrators cannot change their own role or status', 'SELF_MODIFICATION');
      const user = await users.findOneAndUpdate({ _id: id }, { $set: { ...req.valid.body, updatedAt: nowIso() } }, { returnDocument: 'after' });
      if (!user) throw errors.notFound('User');
      if (user.status === 'disabled') await tokens.revokeAllForUser(user._id);
      req.log.info({ targetUserId: id, changes: req.valid.body }, 'User updated by admin');
      res.json({ user: publicUser(user) });
    },
  );
}
