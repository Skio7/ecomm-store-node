import { z } from 'zod';
import { requireInternal } from '../lib/auth.js';
import { out } from '../lib/db.js';
import { errors } from '../lib/errors.js';
import { newId, nowIso, validate } from '../lib/util.js';

const MAX_ADDRESSES = 10;
const DEFAULT_PREFERENCES = { marketingEmails: false, orderUpdates: true, currency: 'INR' };

const addressFields = {
  label: z.enum(['home', 'work', 'other']).default('home'),
  fullName: z.string().trim().min(2).max(80),
  phone: z.string().trim().regex(/^\+?[0-9][0-9 -]{6,16}$/, 'Must be a valid phone number'),
  line1: z.string().trim().min(3).max(120),
  line2: z.string().trim().max(120).optional().default(''),
  city: z.string().trim().min(2).max(60),
  state: z.string().trim().min(2).max(60),
  postalCode: z.string().trim().regex(/^[A-Za-z0-9 -]{3,10}$/, 'Must be a valid postal code'),
  country: z.string().trim().length(2).toUpperCase().default('IN'),
  isDefault: z.boolean().optional(),
};
const addressCreate = z.object(addressFields);
const addressUpdate = z
  .object(Object.fromEntries(Object.entries(addressFields).map(([k, v]) => [k, v instanceof z.ZodDefault ? v.unwrap().optional() : v.optional()])))
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update');

const profileUpdate = z
  .object({
    phone: z.string().trim().regex(/^\+?[0-9][0-9 -]{6,16}$/, 'Must be a valid phone number').nullable().optional(),
    preferences: z
      .object({ marketingEmails: z.boolean().optional(), orderUpdates: z.boolean().optional(), currency: z.enum(['INR']).optional() })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update');

export function registerUsersRoutes(router, { config, db, auth }) {
  const profiles = db.collection('profiles');
  const addresses = db.collection('addresses');
  const idParam = { id: z.string().min(1).max(64) };

  // Profiles are created lazily from token claims, so registration never depends on them.
  const ensureProfile = (userId) =>
    profiles.findOneAndUpdate(
      { _id: userId },
      { $setOnInsert: { phone: null, preferences: DEFAULT_PREFERENCES, createdAt: nowIso(), updatedAt: nowIso() } },
      { upsert: true, returnDocument: 'after' },
    );

  const view = async (user, profile) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    phone: profile.phone,
    preferences: profile.preferences,
    addressCount: await addresses.countDocuments({ userId: user.id }),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  });

  const listFor = async (userId) => (await addresses.find({ userId }).sort({ isDefault: -1, createdAt: 1 }).toArray()).map(out);

  const ownAddress = async (userId, id) => {
    const a = await addresses.findOne({ _id: id, userId });
    if (!a) throw errors.notFound('Address');
    return out(a);
  };

  const makeDefault = async (userId, id) => {
    await addresses.updateMany({ userId, isDefault: true, _id: { $ne: id } }, { $set: { isDefault: false } });
    return out(await addresses.findOneAndUpdate({ _id: id }, { $set: { isDefault: true, updatedAt: nowIso() } }, { returnDocument: 'after' }));
  };

  router.get('/me', auth.authenticate, async (req, res) => {
    res.json({ profile: await view(req.user, await ensureProfile(req.user.id)) });
  });

  router.patch('/me', auth.authenticate, validate({ body: profileUpdate }), async (req, res) => {
    await ensureProfile(req.user.id);
    const { phone, preferences = {} } = req.valid.body;
    const set = { updatedAt: nowIso() };
    if (phone !== undefined) set.phone = phone;
    for (const [k, v] of Object.entries(preferences)) set[`preferences.${k}`] = v;
    const updated = await profiles.findOneAndUpdate({ _id: req.user.id }, { $set: set }, { returnDocument: 'after' });
    res.json({ profile: await view(req.user, updated) });
  });

  router.get('/me/addresses', auth.authenticate, async (req, res) => {
    res.json({ data: await listFor(req.user.id) });
  });

  router.post('/me/addresses', auth.authenticate, validate({ body: addressCreate }), async (req, res) => {
    const count = await addresses.countDocuments({ userId: req.user.id });
    if (count >= MAX_ADDRESSES) throw errors.unprocessable(`You can save at most ${MAX_ADDRESSES} addresses`, 'ADDRESS_LIMIT_REACHED');
    const now = nowIso();
    const { isDefault, ...fields } = req.valid.body;
    const doc = { _id: newId('adr'), userId: req.user.id, ...fields, isDefault: false, createdAt: now, updatedAt: now };
    await addresses.insertOne(doc);
    const address = isDefault || count === 0 ? await makeDefault(req.user.id, doc._id) : out(doc);
    res.status(201).json({ address });
  });

  router.patch('/me/addresses/:id', auth.authenticate, validate({ params: idParam, body: addressUpdate }), async (req, res) => {
    await ownAddress(req.user.id, req.valid.params.id);
    const { isDefault, ...fields } = req.valid.body;
    let address = out(await addresses.findOneAndUpdate({ _id: req.valid.params.id }, { $set: { ...fields, updatedAt: nowIso() } }, { returnDocument: 'after' }));
    if (isDefault) address = await makeDefault(req.user.id, address.id);
    res.json({ address });
  });

  router.post('/me/addresses/:id/default', auth.authenticate, validate({ params: idParam }), async (req, res) => {
    await ownAddress(req.user.id, req.valid.params.id);
    res.json({ address: await makeDefault(req.user.id, req.valid.params.id) });
  });

  router.delete('/me/addresses/:id', auth.authenticate, validate({ params: idParam }), async (req, res) => {
    const address = await ownAddress(req.user.id, req.valid.params.id);
    await addresses.deleteOne({ _id: address.id });
    if (address.isDefault) {
      const [next] = await listFor(req.user.id);
      if (next) await makeDefault(req.user.id, next.id);
    }
    res.status(204).end();
  });

  // ---- Internal (called by ecomm-orders-python at checkout) ----
  router.get(
    '/internal/users/:userId/addresses/:addressId',
    requireInternal(config.INTERNAL_API_KEY),
    validate({ params: { userId: z.string().min(1).max(64), addressId: z.string().min(1).max(64) } }),
    async (req, res) => {
      res.json({ address: await ownAddress(req.valid.params.userId, req.valid.params.addressId) });
    },
  );
}
