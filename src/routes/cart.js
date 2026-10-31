import { z } from 'zod';
import { requireInternal } from '../lib/auth.js';
import { errors } from '../lib/errors.js';
import { calculateTotals } from '../lib/pricing.js';
import { nowIso, validate } from '../lib/util.js';

export const MAX_QTY_PER_ITEM = 10;
export const MAX_LINES = 50;

const productId = z.string().trim().min(1).max(64);
const quantity = z.number().int().min(1).max(MAX_QTY_PER_ITEM, `Maximum ${MAX_QTY_PER_ITEM} per item`);

export function registerCartRoutes(router, { config, db, auth, catalog }) {
  const carts = db.collection('carts');

  const getItems = async (userId) => (await carts.findOne({ _id: userId }))?.items ?? [];
  const saveItems = (userId, items) => carts.updateOne({ _id: userId }, { $set: { items, updatedAt: nowIso() } }, { upsert: true });

  async function requireAvailable(id, wantedQty) {
    const p = (await catalog.getMany([id])).get(id);
    if (!p || p.status !== 'active') throw errors.notFound('Product');
    if (p.stock < wantedQty) {
      throw errors.conflict(
        p.stock === 0 ? `${p.name} is out of stock` : `Only ${p.stock} of ${p.name} available`,
        'INSUFFICIENT_STOCK',
        [{ productId: id, requested: wantedQty, available: p.stock }],
      );
    }
    return p;
  }

  /** Joins stored lines with live product data so prices and availability are always current. */
  async function view(userId, couponCode) {
    const cart = await carts.findOne({ _id: userId });
    const items = cart?.items ?? [];
    const products = await catalog.getMany(items.map((i) => i.productId));
    const lines = items.map((i) => {
      const p = products.get(i.productId);
      let issue = null;
      if (!p || p.status !== 'active') issue = 'UNAVAILABLE';
      else if (p.stock < i.quantity) issue = 'INSUFFICIENT_STOCK';
      return {
        productId: i.productId,
        quantity: i.quantity,
        addedAt: i.addedAt,
        product: p
          ? { id: p.id, slug: p.slug, name: p.name, brand: p.brand, category: p.category, price: p.price, compareAtPrice: p.compareAtPrice, stock: p.stock, status: p.status }
          : null,
        available: !issue,
        issue,
        lineTotal: p ? p.price * i.quantity : 0,
      };
    });
    const subtotal = lines.filter((l) => l.available).reduce((sum, l) => sum + l.lineTotal, 0);
    return {
      userId,
      items: lines,
      itemCount: lines.reduce((n, l) => n + l.quantity, 0),
      hasIssues: lines.some((l) => !l.available),
      totals: calculateTotals(subtotal, couponCode),
      updatedAt: cart?.updatedAt ?? null,
    };
  }

  router.get('/', auth.authenticate, validate({ query: { couponCode: z.string().trim().max(30).optional() } }), async (req, res) => {
    res.json({ cart: await view(req.user.id, req.valid.query.couponCode) });
  });

  router.post('/items', auth.authenticate, validate({ body: { productId, quantity: quantity.default(1) } }), async (req, res) => {
    const { productId: id, quantity: qty } = req.valid.body;
    const items = await getItems(req.user.id);
    const existing = items.find((i) => i.productId === id);
    const nextQty = (existing?.quantity ?? 0) + qty;
    if (nextQty > MAX_QTY_PER_ITEM) throw errors.unprocessable(`You can add at most ${MAX_QTY_PER_ITEM} of an item`, 'QUANTITY_LIMIT');
    if (!existing && items.length >= MAX_LINES) throw errors.unprocessable(`Your cart can hold at most ${MAX_LINES} different items`, 'CART_FULL');
    await requireAvailable(id, nextQty);
    await saveItems(
      req.user.id,
      existing ? items.map((i) => (i.productId === id ? { ...i, quantity: nextQty } : i)) : [...items, { productId: id, quantity: qty, addedAt: nowIso() }],
    );
    res.status(existing ? 200 : 201).json({ cart: await view(req.user.id) });
  });

  router.patch('/items/:productId', auth.authenticate, validate({ params: { productId }, body: { quantity } }), async (req, res) => {
    const { productId: id } = req.valid.params;
    const items = await getItems(req.user.id);
    if (!items.some((i) => i.productId === id)) throw errors.notFound('Cart item');
    await requireAvailable(id, req.valid.body.quantity);
    await saveItems(req.user.id, items.map((i) => (i.productId === id ? { ...i, quantity: req.valid.body.quantity } : i)));
    res.json({ cart: await view(req.user.id) });
  });

  router.delete('/items/:productId', auth.authenticate, validate({ params: { productId } }), async (req, res) => {
    const items = await getItems(req.user.id);
    if (!items.some((i) => i.productId === req.valid.params.productId)) throw errors.notFound('Cart item');
    await saveItems(req.user.id, items.filter((i) => i.productId !== req.valid.params.productId));
    res.json({ cart: await view(req.user.id) });
  });

  router.delete('/', auth.authenticate, async (req, res) => {
    await saveItems(req.user.id, []);
    res.json({ cart: await view(req.user.id) });
  });

  // Merges a guest (browser-stored) cart after sign-in; quantities are clamped to stock and limits.
  router.post(
    '/merge',
    auth.authenticate,
    validate({ body: { items: z.array(z.object({ productId, quantity: z.number().int().min(1).max(100) })).max(MAX_LINES) } }),
    async (req, res) => {
      const items = await getItems(req.user.id);
      const incoming = req.valid.body.items;
      const products = await catalog.getMany([...new Set(incoming.map((i) => i.productId))]);
      const skipped = [];
      for (const { productId: id, quantity: qty } of incoming) {
        const p = products.get(id);
        const existing = items.find((i) => i.productId === id);
        if (!p || p.status !== 'active' || p.stock === 0) {
          skipped.push({ productId: id, reason: 'UNAVAILABLE' });
          continue;
        }
        if (!existing && items.length >= MAX_LINES) {
          skipped.push({ productId: id, reason: 'CART_FULL' });
          continue;
        }
        const merged = Math.min((existing?.quantity ?? 0) + qty, MAX_QTY_PER_ITEM, p.stock);
        if (existing) existing.quantity = merged;
        else items.push({ productId: id, quantity: merged, addedAt: nowIso() });
      }
      await saveItems(req.user.id, items);
      res.json({ cart: await view(req.user.id), skipped });
    },
  );

  // ---- Internal (called by ecomm-orders-python at checkout / after payment) ----
  const internal = requireInternal(config.INTERNAL_API_KEY);
  router.get('/internal/carts/:userId', internal, async (req, res) => {
    res.json({ userId: req.params.userId, items: await getItems(req.params.userId) });
  });
  router.delete('/internal/carts/:userId', internal, async (req, res) => {
    await saveItems(req.params.userId, []);
    res.status(204).end();
  });
}
