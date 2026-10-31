import bcrypt from 'bcryptjs';
import { buildSeedProducts, CATEGORIES, SEED_REVIEWS } from './catalog.js';
import { SEED_USERS } from './seed-users.js';

/** Creates this service's indexes (idempotent; runs on every boot). */
export async function ensureIndexes(db) {
  await Promise.all([
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('refresh_tokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }), // MongoDB purges expired tokens
    db.collection('refresh_tokens').createIndex({ familyId: 1 }),
    db.collection('refresh_tokens').createIndex({ userId: 1 }),
    db.collection('addresses').createIndex({ userId: 1 }),
    db.collection('products').createIndex({ slug: 1 }, { unique: true }),
    db.collection('products').createIndex({ sku: 1 }, { unique: true }),
    db.collection('reviews').createIndex({ productId: 1, userId: 1 }, { unique: true }),
  ]);
}

/** Inserts each document only if its _id is missing, so re-seeding never overwrites live data. */
async function insertMissing(collection, docs) {
  if (!docs.length) return;
  await collection.bulkWrite(
    docs.map(({ _id, ...doc }) => ({ updateOne: { filter: { _id }, update: { $setOnInsert: doc }, upsert: true } })),
    { ordered: false },
  );
}

/** Demo catalog, accounts, addresses and reviews. Safe to run on every boot. */
export async function seed(db, config, logger) {
  const createdAt = '2026-01-15T09:30:00.000Z';
  const users = [];
  for (const u of SEED_USERS) {
    let password = config.SEED_CUSTOMER_PASSWORD;
    if (u.role === 'admin') {
      // A well-known admin password is fine locally, never in production.
      password = config.SEED_ADMIN_PASSWORD ?? (config.isProduction ? undefined : 'Admin@12345');
      if (!password) {
        logger.warn('SEED_ADMIN_PASSWORD not set: skipping demo admin account');
        continue;
      }
    }
    const { id, ...rest } = u;
    users.push({
      _id: id,
      ...rest,
      passwordHash: await bcrypt.hash(password, config.BCRYPT_ROUNDS),
      status: 'active',
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt,
      updatedAt: createdAt,
    });
  }
  await insertMissing(db.collection('users'), users);

  const at = '2026-02-01T10:00:00.000Z';
  const [, jane, rahul] = SEED_USERS;
  await insertMissing(db.collection('profiles'), SEED_USERS.map((u) => ({ _id: u.id, phone: null, preferences: { marketingEmails: false, orderUpdates: true, currency: 'INR' }, createdAt: at, updatedAt: at })));
  await insertMissing(db.collection('addresses'), [
    {
      _id: 'adr_seed_jane_home', userId: jane.id, label: 'home', fullName: 'Jane Doe', phone: '+91 98450 12345',
      line1: '42, 3rd Cross, Indiranagar', line2: 'Near 100 Feet Road', city: 'Bengaluru', state: 'Karnataka',
      postalCode: '560038', country: 'IN', isDefault: true, createdAt: at, updatedAt: at,
    },
    {
      _id: 'adr_seed_jane_work', userId: jane.id, label: 'work', fullName: 'Jane Doe', phone: '+91 98450 12345',
      line1: 'Prestige Tech Park, Tower B, Floor 7', line2: 'Marathahalli', city: 'Bengaluru', state: 'Karnataka',
      postalCode: '560103', country: 'IN', isDefault: false, createdAt: at, updatedAt: at,
    },
    {
      _id: 'adr_seed_rahul_home', userId: rahul.id, label: 'home', fullName: 'Rahul Sharma', phone: '+91 99300 54321',
      line1: 'Flat 1204, Sea Breeze Apartments', line2: 'Carter Road, Bandra West', city: 'Mumbai', state: 'Maharashtra',
      postalCode: '400050', country: 'IN', isDefault: true, createdAt: at, updatedAt: at,
    },
  ]);

  await insertMissing(db.collection('categories'), CATEGORIES.map((c) => ({ _id: c.slug, ...c })));
  await insertMissing(db.collection('products'), buildSeedProducts().map(({ id, ...p }) => ({ _id: id, ...p })));
  await insertMissing(
    db.collection('reviews'),
    SEED_REVIEWS.map(([productId, userId, userName, rating, title, body], i) => ({
      _id: `rev_seed_${i + 1}`, productId, userId, userName, rating, title, body,
      createdAt: new Date(Date.parse('2026-05-01T12:00:00Z') + i * 86_400_000).toISOString(),
    })),
  );
  logger.info('Seed data ensured');
}
