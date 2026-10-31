import { z } from 'zod';
import { requireInternal } from '../lib/auth.js';
import { zEnv } from '../lib/config.js';
import { isDuplicateKey, out } from '../lib/db.js';
import { errors } from '../lib/errors.js';
import { newId, nowIso, paginate, validate } from '../lib/util.js';

const slugSchema = z.string().trim().min(3).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase words separated by hyphens');
const money = z.coerce.number().int('Amount must be in minor units (paise)').min(0).max(100_000_000);

const productFields = {
  name: z.string().trim().min(3).max(150),
  slug: slugSchema,
  sku: z.string().trim().min(3).max(40),
  brand: z.string().trim().min(1).max(60),
  category: z.string().trim().min(1).max(60),
  description: z.string().trim().min(10).max(4000),
  price: money.refine((v) => v > 0, 'Price must be greater than zero'),
  compareAtPrice: money.nullable().default(null),
  stock: z.coerce.number().int().min(0).max(1_000_000).default(0),
  featured: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1).max(30)).max(15).default([]),
  attributes: z.record(z.string().max(60), z.string().max(200)).default({}),
};
const productCreate = z.object(productFields);
const productUpdate = z
  .object({
    ...Object.fromEntries(Object.entries(productFields).map(([k, v]) => [k, (v instanceof z.ZodDefault ? v.unwrap() : v).optional()])),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update');

const listQuery = {
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(60).optional(),
  brand: z.string().trim().max(60).optional(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  inStock: zEnv.bool.optional(),
  featured: zEnv.bool.optional(),
  sort: z.enum(['relevance', 'price_asc', 'price_desc', 'rating', 'newest', 'popular']).default('relevance'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(12),
  includeArchived: zEnv.bool.optional(),
};

const reservationItems = z
  .array(z.object({ productId: z.string().min(1).max(64), quantity: z.number().int().min(1).max(100) }))
  .min(1)
  .max(50);

function searchScore(p, terms) {
  const name = p.name.toLowerCase();
  const haystack = [p.brand, p.category, p.description, p.sku, ...p.tags].join(' ').toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (name.includes(t)) score += 3;
    else if (haystack.includes(t)) score += 1;
    else return 0;
  }
  return score;
}

const SORTERS = {
  price_asc: (a, b) => a.price - b.price,
  price_desc: (a, b) => b.price - a.price,
  rating: (a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount,
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  popular: (a, b) => b.reviewCount - a.reviewCount,
};

export function toPublic(doc) {
  const p = out(doc);
  return { ...p, inStock: p.stock > 0, lowStock: p.stock > 0 && p.stock <= 5 };
}

/** Product lookups shared with the cart module (same process, same database). */
export function createCatalog(db) {
  const products = db.collection('products');
  return {
    async getMany(ids) {
      if (!ids.length) return new Map();
      const docs = await products.find({ _id: { $in: ids } }).toArray();
      return new Map(docs.map((d) => [d._id, toPublic(d)]));
    },
  };
}

export function registerProductsRoutes(router, { config, db, auth, logger }) {
  const products = db.collection('products');
  const categories = db.collection('categories');
  const reviews = db.collection('reviews');
  const reservations = db.collection('reservations');
  const internal = requireInternal(config.INTERNAL_API_KEY);
  const admin = [auth.authenticate, auth.requireRole('admin')];

  const findProduct = (idOrSlug) => products.findOne({ $or: [{ _id: idOrSlug }, { slug: idOrSlug }] });
  const requireActive = async (idOrSlug, isAdmin = false) => {
    const p = await findProduct(idOrSlug);
    if (!p || (p.status !== 'active' && !isAdmin)) throw errors.notFound('Product');
    return p;
  };
  const assertUnique = async ({ slug, sku }, exceptId) => {
    if (slug && (await products.findOne({ slug, _id: { $ne: exceptId } }))) throw errors.conflict(`Slug "${slug}" is already in use`, 'SLUG_TAKEN');
    if (sku && (await products.findOne({ sku, _id: { $ne: exceptId } }))) throw errors.conflict(`SKU "${sku}" is already in use`, 'SKU_TAKEN');
  };
  const assertCategory = async (slug) => {
    if (slug && !(await categories.findOne({ _id: slug }))) throw errors.unprocessable(`Unknown category "${slug}"`, 'INVALID_CATEGORY');
  };
  const restock = (lines) =>
    Promise.all(lines.map((l) => products.updateOne({ _id: l.productId }, { $inc: { stock: l.quantity }, $set: { updatedAt: nowIso() } })));

  // ---- Public catalog ----
  router.get('/categories', async (_req, res) => {
    const counts = Object.fromEntries(
      (await products.aggregate([{ $match: { status: 'active' } }, { $group: { _id: '$category', n: { $sum: 1 } } }]).toArray()).map((c) => [c._id, c.n]),
    );
    const list = (await categories.find().toArray()).map((c) => ({ ...out(c), productCount: counts[c._id] ?? 0 }));
    res.set('cache-control', 'public, max-age=60').json({ data: list });
  });

  // The catalog is small, so search scoring and facets run in memory over the active products.
  router.get('/', auth.optionalAuth, validate({ query: listQuery }), async (req, res) => {
    const q = req.valid.query;
    const showArchived = q.includeArchived && req.user?.role === 'admin';
    const terms = q.q ? q.q.toLowerCase().split(/\s+/).filter(Boolean) : [];

    let list = (await products.find(showArchived ? {} : { status: 'active' }).toArray()).map(toPublic);
    const scores = new Map();
    if (terms.length) {
      list = list.filter((p) => {
        const s = searchScore(p, terms);
        if (s) scores.set(p.id, s);
        return s > 0;
      });
    }
    if (q.category) list = list.filter((p) => p.category === q.category);

    // Facets reflect the search + category scope, before brand/price/stock filters.
    const brandCounts = {};
    for (const p of list) brandCounts[p.brand] = (brandCounts[p.brand] ?? 0) + 1;
    const prices = list.map((p) => p.price);

    if (q.brand) list = list.filter((p) => p.brand === q.brand);
    if (q.minPrice !== undefined) list = list.filter((p) => p.price >= q.minPrice);
    if (q.maxPrice !== undefined) list = list.filter((p) => p.price <= q.maxPrice);
    if (q.inStock) list = list.filter((p) => p.stock > 0);
    if (q.featured !== undefined) list = list.filter((p) => p.featured === q.featured);

    const sorter =
      q.sort === 'relevance' ? (terms.length ? (a, b) => scores.get(b.id) - scores.get(a.id) || SORTERS.popular(a, b) : SORTERS.popular) : SORTERS[q.sort];
    list.sort(sorter);

    res.json({
      ...paginate(list, q.page, q.limit),
      facets: {
        brands: Object.entries(brandCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
        priceRange: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
      },
      query: { q: q.q ?? null, category: q.category ?? null, sort: q.sort },
    });
  });

  // ---- Admin ----
  router.post('/', ...admin, validate({ body: productCreate }), async (req, res) => {
    const body = req.valid.body;
    await assertCategory(body.category);
    await assertUnique(body);
    const now = nowIso();
    const doc = { _id: newId('prd'), ...body, currency: 'INR', rating: 0, reviewCount: 0, status: 'active', createdAt: now, updatedAt: now };
    try {
      await products.insertOne(doc);
    } catch (err) {
      if (isDuplicateKey(err)) throw errors.conflict('Slug or SKU is already in use', 'SLUG_TAKEN');
      throw err;
    }
    req.log.info({ productId: doc._id }, 'Product created');
    res.status(201).json({ product: toPublic(doc) });
  });

  router.patch('/:id', ...admin, validate({ params: { id: z.string().min(1).max(64) }, body: productUpdate }), async (req, res) => {
    const existing = await requireActive(req.valid.params.id, true);
    await assertCategory(req.valid.body.category);
    await assertUnique(req.valid.body, existing._id);
    const product = await products.findOneAndUpdate({ _id: existing._id }, { $set: { ...req.valid.body, updatedAt: nowIso() } }, { returnDocument: 'after' });
    res.json({ product: toPublic(product) });
  });

  router.delete('/:id', ...admin, validate({ params: { id: z.string().min(1).max(64) } }), async (req, res) => {
    const existing = await requireActive(req.valid.params.id, true);
    await products.updateOne({ _id: existing._id }, { $set: { status: 'archived', updatedAt: nowIso() } });
    res.status(204).end();
  });

  router.patch(
    '/:id/inventory',
    ...admin,
    validate({
      params: { id: z.string().min(1).max(64) },
      body: z
        .object({ stock: z.number().int().min(0).max(1_000_000).optional(), adjust: z.number().int().min(-1_000_000).max(1_000_000).optional() })
        .refine((b) => (b.stock === undefined) !== (b.adjust === undefined), 'Provide exactly one of stock or adjust'),
    }),
    async (req, res) => {
      const existing = await requireActive(req.valid.params.id, true);
      const { stock, adjust } = req.valid.body;
      const product =
        stock !== undefined
          ? await products.findOneAndUpdate({ _id: existing._id }, { $set: { stock, updatedAt: nowIso() } }, { returnDocument: 'after' })
          : await products.findOneAndUpdate(
              { _id: existing._id, stock: { $gte: -adjust } },
              { $inc: { stock: adjust }, $set: { updatedAt: nowIso() } },
              { returnDocument: 'after' },
            );
      if (!product) throw errors.unprocessable('Stock cannot go below zero', 'INVALID_STOCK');
      req.log.info({ productId: product._id, from: existing.stock, to: product.stock }, 'Inventory adjusted');
      res.json({ product: toPublic(product) });
    },
  );

  // ---- Internal (called by ecomm-orders-python) ----
  router.post('/internal/products/batch', internal, validate({ body: { ids: z.array(z.string().min(1).max(64)).max(100) } }), async (req, res) => {
    const docs = await products.find({ _id: { $in: req.valid.body.ids } }).toArray();
    res.json({ data: docs.map(toPublic) });
  });

  router.get('/internal/reservations/:id', internal, async (req, res) => {
    const reservation = await reservations.findOne({ _id: req.params.id });
    if (!reservation) throw errors.notFound('Reservation');
    res.json({ reservation: out(reservation) });
  });

  // Checks and decrements stock for every line; all-or-nothing. Idempotent per reservationId.
  router.post(
    '/internal/reservations',
    internal,
    validate({ body: { reservationId: z.string().min(1).max(64), items: reservationItems } }),
    async (req, res) => {
      const { reservationId, items } = req.valid.body;
      const existing = await reservations.findOne({ _id: reservationId });
      if (existing) return res.json({ reservation: out(existing) });

      const merged = new Map();
      for (const i of items) merged.set(i.productId, (merged.get(i.productId) ?? 0) + i.quantity);
      const catalog = new Map((await products.find({ _id: { $in: [...merged.keys()] } }).toArray()).map((p) => [p._id, p]));

      const problems = [];
      const lines = [];
      for (const [productId, quantity] of merged) {
        const p = catalog.get(productId);
        if (!p || p.status !== 'active') problems.push({ productId, reason: 'UNAVAILABLE', requested: quantity, available: 0 });
        else if (p.stock < quantity) problems.push({ productId, name: p.name, reason: 'INSUFFICIENT_STOCK', requested: quantity, available: p.stock });
        else lines.push({ productId, sku: p.sku, slug: p.slug, name: p.name, brand: p.brand, unitPrice: p.price, quantity });
      }
      if (problems.length) throw errors.conflict('Some items are out of stock or unavailable', 'INSUFFICIENT_STOCK', problems);

      // Conditional decrements: a line only succeeds if enough stock is still there right now.
      const taken = [];
      for (const line of lines) {
        const r = await products.updateOne(
          { _id: line.productId, status: 'active', stock: { $gte: line.quantity } },
          { $inc: { stock: -line.quantity }, $set: { updatedAt: nowIso() } },
        );
        if (r.modifiedCount === 1) {
          taken.push(line);
          continue;
        }
        await restock(taken);
        const now = await products.findOne({ _id: line.productId });
        throw errors.conflict('Some items are out of stock or unavailable', 'INSUFFICIENT_STOCK', [
          { productId: line.productId, name: line.name, reason: 'INSUFFICIENT_STOCK', requested: line.quantity, available: now?.stock ?? 0 },
        ]);
      }

      const reservation = { _id: reservationId, items: lines, status: 'reserved', createdAt: nowIso(), updatedAt: nowIso() };
      try {
        await reservations.insertOne(reservation);
      } catch (err) {
        await restock(taken);
        if (isDuplicateKey(err)) return res.json({ reservation: out(await reservations.findOne({ _id: reservationId })) });
        throw err;
      }
      req.log.info({ reservationId, lines: lines.length }, 'Stock reserved');
      res.status(201).json({ reservation: out(reservation) });
    },
  );

  router.post('/internal/reservations/:id/commit', internal, async (req, res) => {
    const reservation = await reservations.findOne({ _id: req.params.id });
    if (!reservation) throw errors.notFound('Reservation');
    if (reservation.status === 'released') throw errors.conflict('Reservation was already released', 'RESERVATION_RELEASED');
    const updated = await reservations.findOneAndUpdate({ _id: reservation._id }, { $set: { status: 'committed', updatedAt: nowIso() } }, { returnDocument: 'after' });
    res.json({ reservation: out(updated) });
  });

  // Returns reserved (or committed, e.g. on cancellation) stock to inventory. Idempotent.
  router.post('/internal/reservations/:id/release', internal, async (req, res) => {
    const reservation = await reservations.findOne({ _id: req.params.id });
    if (!reservation) throw errors.notFound('Reservation');
    // Flip the status first so concurrent releases cannot restock twice.
    const claimed = await reservations.findOneAndUpdate(
      { _id: reservation._id, status: { $ne: 'released' } },
      { $set: { status: 'released', updatedAt: nowIso() } },
      { returnDocument: 'after' },
    );
    if (!claimed) return res.json({ reservation: out(reservation) });
    await restock(claimed.items);
    logger.info({ reservationId: reservation._id }, 'Stock released');
    res.json({ reservation: out(claimed) });
  });

  // ---- Product detail & reviews (registered last so static paths win) ----
  router.get('/:idOrSlug', auth.optionalAuth, async (req, res) => {
    const product = await requireActive(req.params.idOrSlug, req.user?.role === 'admin');
    const category = await categories.findOne({ _id: product.category });
    res.json({ product: { ...toPublic(product), categoryName: category?.name ?? product.category } });
  });

  router.get(
    '/:idOrSlug/reviews',
    validate({ query: { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(10) } }),
    async (req, res) => {
      const product = await requireActive(req.params.idOrSlug);
      const list = (await reviews.find({ productId: product._id }).sort({ createdAt: -1 }).toArray()).map(out);
      res.json(paginate(list, req.valid.query.page, req.valid.query.limit));
    },
  );

  router.post(
    '/:idOrSlug/reviews',
    auth.authenticate,
    validate({
      body: {
        rating: z.number().int().min(1).max(5),
        title: z.string().trim().min(3).max(100),
        body: z.string().trim().min(10, 'Review must be at least 10 characters').max(2000),
      },
    }),
    async (req, res) => {
      const product = await requireActive(req.params.idOrSlug);
      const review = { _id: newId('rev'), productId: product._id, userId: req.user.id, userName: req.user.name, ...req.valid.body, createdAt: nowIso() };
      try {
        await reviews.insertOne(review);
      } catch (err) {
        if (isDuplicateKey(err)) throw errors.conflict('You have already reviewed this product', 'ALREADY_REVIEWED');
        throw err;
      }
      // Running average, computed atomically on the server.
      await products.updateOne({ _id: product._id }, [
        {
          $set: {
            rating: { $round: [{ $divide: [{ $add: [{ $multiply: ['$rating', '$reviewCount'] }, review.rating] }, { $add: ['$reviewCount', 1] }] }, 1] },
            reviewCount: { $add: ['$reviewCount', 1] },
          },
        },
      ]);
      res.status(201).json({ review: out(review) });
    },
  );
}
