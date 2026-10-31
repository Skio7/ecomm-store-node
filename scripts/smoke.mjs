#!/usr/bin/env node
/**
 * End-to-end smoke test for DeployKar Shop (store-service + orders-service + MongoDB).
 * No dependencies; Node >= 22.
 *
 *   # one origin that routes /api/* to both services (e.g. the deployed frontend):
 *   SMOKE_BASE_URL=https://shop.example.com node scripts/smoke.mjs
 *   # or each service directly:
 *   SMOKE_STORE_URL=http://localhost:4001 SMOKE_ORDERS_URL=http://localhost:4002 node scripts/smoke.mjs
 *
 * Covers: health of all 7 API prefixes and their dependencies, catalog + search, register,
 * login, refresh rotation + reuse detection, profile, addresses, cart + coupons, checkout
 * (idempotent replay), declined card, processor error, card payment, order confirmation,
 * stock decrement, cart cleared, notifications, UPI payment, cancel with refund + restock,
 * logout. Exits 1 on any failure.
 */

const base = process.env.SMOKE_BASE_URL?.replace(/\/+$/, '');
const storeUrl = (process.env.SMOKE_STORE_URL ?? base ?? 'http://localhost:4001').replace(/\/+$/, '');
const ordersUrl = (process.env.SMOKE_ORDERS_URL ?? base ?? 'http://localhost:4002').replace(/\/+$/, '');
const ORDERS_PREFIXES = new Set(['orders', 'payments', 'notifications']);
const urlFor = (svc) => `${ORDERS_PREFIXES.has(svc) ? ordersUrl : storeUrl}/api/${svc}`;

let passed = 0;
const failures = [];
const runId = Date.now().toString(36);

async function call(svc, path = '', { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(`${urlFor(svc)}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'x-request-id': `smoke-${runId}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: res.status, data, headers: res.headers };
}

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function expect(cond, message, res) {
  if (!cond) throw new Error(`${message}${res ? ` — got HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}` : ''}`);
}
const expectStatus = (res, status, what) => expect(res.status === status, `${what}: expected HTTP ${status}`, res);

const card = (number) => ({ method: 'card', card: { number, expMonth: 12, expYear: new Date().getFullYear() + 3, cvc: '123', name: 'Smoke Test' } });

console.log(`DeployKar Shop smoke test\n  store-service:  ${storeUrl}\n  orders-service: ${ordersUrl}\n`);

console.log('Health & routing');
for (const svc of ['auth', 'users', 'products', 'cart', 'orders', 'payments', 'notifications']) {
  await step(`${svc}: /health/dependencies all up`, async () => {
    const r = await call(svc, '/health/dependencies');
    expectStatus(r, 200, 'dependencies');
    const deps = Object.entries(r.data.dependencies);
    expect(deps.length >= 2 && deps.every(([, d]) => d.status === 'up'), `dependency down: ${JSON.stringify(r.data.dependencies)}`);
  });
}
await step('unknown route returns JSON 404 ROUTE_NOT_FOUND', async () => {
  const r = await call('products', '/does/not/exist/at/all');
  expect(r.status === 404 && r.data?.error?.code === 'ROUTE_NOT_FOUND', 'expected ROUTE_NOT_FOUND', r);
});
await step('internal routes reject requests without the internal key', async () => {
  const r = await call('cart', '/internal/carts/usr_x');
  expect(r.status === 401 && r.data?.error?.code === 'INTERNAL_AUTH_REQUIRED', 'expected 401', r);
});

console.log('\nCatalog');
let product;
let upiProduct;
await step('categories and featured products', async () => {
  const c = await call('products', '/categories');
  expect(c.status === 200 && c.data.data.length >= 6, 'categories', c);
  const f = await call('products', '', {});
  expect(f.status === 200 && f.data.data.length > 0, 'product list', f);
});
await step('search "headphones" finds the ANC headphones', async () => {
  const r = await call('products', '?q=headphones');
  expect(r.status === 200 && r.data.data.some((p) => p.slug === 'aurora-anc-wireless-headphones'), 'search', r);
});
await step('product detail by slug', async () => {
  const list = await call('products', '?sort=price_desc&inStock=true&limit=48');
  [product, upiProduct] = list.data.data.filter((p) => p.stock >= 5);
  const r = await call('products', `/${product.slug}`);
  expect(r.status === 200 && r.data.product.id === product.id && r.data.product.categoryName, 'detail', r);
});

console.log('\nAuth & account');
const email = `smoke-${runId}@shop.test`;
const password = 'Smoke@12345';
let token;
let refreshToken;
await step('register a new customer', async () => {
  const r = await call('auth', '/register', { method: 'POST', body: { name: 'Smoke Tester', email, password } });
  expectStatus(r, 201, 'register');
  ({ accessToken: token, refreshToken } = r.data);
});
await step('duplicate email rejected (409 EMAIL_TAKEN)', async () => {
  const r = await call('auth', '/register', { method: 'POST', body: { name: 'Smoke Tester', email, password } });
  expect(r.status === 409 && r.data.error.code === 'EMAIL_TAKEN', 'EMAIL_TAKEN', r);
});
await step('validation errors list fields', async () => {
  const r = await call('auth', '/register', { method: 'POST', body: { name: 'x', email: 'nope', password: 'short' } });
  expect(r.status === 400 && r.data.error.code === 'VALIDATION_ERROR' && r.data.error.details.some((d) => d.field === 'email'), 'VALIDATION_ERROR', r);
});
await step('login', async () => {
  const r = await call('auth', '/login', { method: 'POST', body: { email, password } });
  expectStatus(r, 200, 'login');
  ({ accessToken: token, refreshToken } = r.data);
});
await step('wrong password rejected', async () => {
  const r = await call('auth', '/login', { method: 'POST', body: { email, password: 'Wrong@12345' } });
  expect(r.status === 401 && r.data.error.code === 'INVALID_CREDENTIALS', 'INVALID_CREDENTIALS', r);
});
await step('refresh rotates tokens; reusing the old one is detected', async () => {
  const r = await call('auth', '/refresh', { method: 'POST', body: { refreshToken } });
  expectStatus(r, 200, 'refresh');
  const reused = await call('auth', '/refresh', { method: 'POST', body: { refreshToken } });
  expect(reused.status === 401 && reused.data.error.code === 'REFRESH_TOKEN_REUSED', 'reuse detection', reused);
  const again = await call('auth', '/login', { method: 'POST', body: { email, password } });
  ({ accessToken: token, refreshToken } = again.data);
});
await step('token from store-service is accepted by orders-service', async () => {
  const r = await call('orders', '', { token });
  expect(r.status === 200 && Array.isArray(r.data.data), 'orders list', r);
});
await step('profile + preferences', async () => {
  const r = await call('users', '/me', { method: 'PATCH', token, body: { phone: '+91 98765 43210', preferences: { marketingEmails: true } } });
  expect(r.status === 200 && r.data.profile.phone === '+91 98765 43210' && r.data.profile.preferences.marketingEmails === true, 'profile', r);
});
let addressId;
await step('add a shipping address (becomes default)', async () => {
  const r = await call('users', '/me/addresses', {
    method: 'POST',
    token,
    body: { label: 'home', fullName: 'Smoke Tester', phone: '+91 98765 43210', line1: '1 Test Street', city: 'Pune', state: 'Maharashtra', postalCode: '411001' },
  });
  expect(r.status === 201 && r.data.address.isDefault, 'address', r);
  addressId = r.data.address.id;
});

console.log('\nCart');
await step('add to cart, update quantity, coupon estimate', async () => {
  let r = await call('cart', '/items', { method: 'POST', token, body: { productId: product.id, quantity: 1 } });
  expectStatus(r, 201, 'add');
  r = await call('cart', `/items/${product.id}`, { method: 'PATCH', token, body: { quantity: 2 } });
  expect(r.status === 200 && r.data.cart.itemCount === 2, 'update', r);
  r = await call('cart', '?couponCode=WELCOME10', { token });
  expect(r.status === 200 && r.data.cart.totals.discount > 0 && r.data.cart.totals.couponCode === 'WELCOME10', 'coupon', r);
});
await step('invalid coupon rejected', async () => {
  const r = await call('cart', '?couponCode=NOPE', { token });
  expect(r.status === 422 && r.data.error.code === 'INVALID_COUPON', 'INVALID_COUPON', r);
});
await step('guest cart merge', async () => {
  const r = await call('cart', '/merge', { method: 'POST', token, body: { items: [{ productId: product.id, quantity: 1 }, { productId: 'prd_missing', quantity: 1 }] } });
  expect(r.status === 200 && r.data.cart.itemCount === 3 && r.data.skipped.length === 1, 'merge', r);
  await call('cart', `/items/${product.id}`, { method: 'PATCH', token, body: { quantity: 2 } });
});

console.log('\nCheckout & payment (orders-service → store-service)');
let order;
const stockBefore = (await call('products', `/${product.id}`)).data.product.stock;
await step('checkout reserves stock and creates a pending order', async () => {
  const r = await call('orders', '', { method: 'POST', token, body: { addressId, couponCode: 'WELCOME10' }, headers: { 'idempotency-key': `smoke-${runId}-1` } });
  expectStatus(r, 201, 'checkout');
  order = r.data.order;
  expect(order.status === 'pending_payment' && order.items[0].quantity === 2 && order.pricing.discount > 0, 'order shape', r);
  const p = await call('products', `/${product.id}`);
  expect(p.data.product.stock === stockBefore - 2, `stock should drop by 2 (was ${stockBefore}, now ${p.data.product.stock})`);
});
await step('same Idempotency-Key replays the same order', async () => {
  const r = await call('orders', '', { method: 'POST', token, body: { addressId, couponCode: 'WELCOME10' }, headers: { 'idempotency-key': `smoke-${runId}-1` } });
  expect(r.status === 200 && r.data.order.id === order.id && r.headers.get('idempotent-replayed') === 'true', 'replay', r);
});
let intent;
await step('create payment intent', async () => {
  const r = await call('payments', '/intents', { method: 'POST', token, body: { orderId: order.id } });
  expect(r.status === 201 && r.data.intent.amount === order.pricing.total, 'intent', r);
  intent = r.data.intent;
});
await step('declined card → 402 PAYMENT_DECLINED, order marked failed', async () => {
  const r = await call('payments', `/intents/${intent.id}/confirm`, { method: 'POST', token, body: card('4000000000000002') });
  expect(r.status === 402 && r.data.error.code === 'PAYMENT_DECLINED', 'decline', r);
  const o = await call('orders', `/${order.id}`, { token });
  expect(o.data.order.paymentStatus === 'failed' && o.data.order.status === 'pending_payment', 'order after decline', o);
});
await step('processor outage card → 502 PROCESSOR_ERROR', async () => {
  const r = await call('payments', `/intents/${intent.id}/confirm`, { method: 'POST', token, body: card('4000000000000119') });
  expect(r.status === 502 && r.data.error.code === 'PROCESSOR_ERROR', 'processor error', r);
});
await step('invalid card number rejected with a field error', async () => {
  const r = await call('payments', `/intents/${intent.id}/confirm`, { method: 'POST', token, body: card('4242424242424241') });
  expect(r.status === 400 && r.data.error.details.some((d) => d.field === 'card.number'), 'card.number field error', r);
});
await step('successful card payment confirms the order', async () => {
  const r = await call('payments', `/intents/${intent.id}/confirm`, { method: 'POST', token, body: card('4242 4242 4242 4242') });
  expect(r.status === 200 && r.data.intent.status === 'succeeded' && r.data.orderUpdated === true, 'payment', r);
  const o = await call('orders', `/${order.id}`, { token });
  expect(o.data.order.status === 'confirmed' && o.data.order.paymentStatus === 'paid', 'order confirmed', o);
});
await step('paying twice is rejected', async () => {
  const r = await call('payments', '/intents', { method: 'POST', token, body: { orderId: order.id } });
  expect(r.status === 409 && r.data.error.code === 'ALREADY_PAID', 'ALREADY_PAID', r);
});
await step('cart is cleared after payment', async () => {
  const r = await call('cart', '', { token });
  expect(r.status === 200 && r.data.cart.itemCount === 0, 'empty cart', r);
});
await step('empty cart cannot be checked out', async () => {
  const r = await call('orders', '', { method: 'POST', token, body: { addressId } });
  expect(r.status === 422 && r.data.error.code === 'CART_EMPTY', 'CART_EMPTY', r);
});

console.log('\nUPI payment, cancellation & refund');
let order2;
const upiStockBefore = (await call('products', `/${upiProduct.id}`)).data.product.stock;
await step('UPI payment succeeds', async () => {
  await call('cart', '/items', { method: 'POST', token, body: { productId: upiProduct.id, quantity: 1 } });
  const c = await call('orders', '', { method: 'POST', token, body: { addressId } });
  expectStatus(c, 201, 'checkout');
  order2 = c.data.order;
  const i = await call('payments', '/intents', { method: 'POST', token, body: { orderId: order2.id } });
  const r = await call('payments', `/intents/${i.data.intent.id}/confirm`, { method: 'POST', token, body: { method: 'upi', upi: { vpa: 'success@upi' } } });
  expect(r.status === 200 && r.data.intent.paymentDetails.vpa === 'success@upi', 'upi', r);
});
await step('cancelling a paid order refunds it and restocks', async () => {
  const r = await call('orders', `/${order2.id}/cancel`, { method: 'POST', token, body: { reason: 'Smoke test' } });
  expect(r.status === 200 && r.data.order.status === 'cancelled' && r.data.order.paymentStatus === 'refunded', 'cancel', r);
  const p = await call('products', `/${upiProduct.id}`);
  expect(p.data.product.stock === upiStockBefore, `stock should be restored to ${upiStockBefore}, is ${p.data.product.stock}`);
  const intents = await call('payments', `/intents?orderId=${order2.id}`, { token });
  expect(intents.data.data[0].status === 'refunded', 'intent refunded', intents);
});
await step('cancelled order cannot be cancelled again', async () => {
  const r = await call('orders', `/${order2.id}/cancel`, { method: 'POST', token, body: {} });
  expect(r.status === 409 && r.data.error.code === 'ORDER_NOT_CANCELLABLE', 'ORDER_NOT_CANCELLABLE', r);
});
await step('order history lists both orders', async () => {
  const r = await call('orders', '', { token });
  expect(r.status === 200 && r.data.pagination.total === 2, 'history', r);
});

console.log('\nNotifications (store-service → orders-service and in-process)');
await step('inbox has welcome, payment failed, confirmed and cancelled', async () => {
  const r = await call('notifications', '?limit=50', { token });
  expectStatus(r, 200, 'notifications');
  const types = new Set(r.data.data.map((n) => n.type));
  for (const t of ['welcome', 'payment_failed', 'order_confirmed', 'order_cancelled']) expect(types.has(t), `missing ${t} notification (have: ${[...types]})`);
  expect(r.data.unreadCount >= 4, 'unread count', r);
});
await step('mark one read, then read-all', async () => {
  const list = await call('notifications', '', { token });
  const r = await call('notifications', `/${list.data.data[0].id}/read`, { method: 'PATCH', token });
  expect(r.status === 200 && r.data.notification.read === true, 'mark read', r);
  await call('notifications', '/read-all', { method: 'POST', token });
  const c = await call('notifications', '/unread-count', { token });
  expect(c.data.unreadCount === 0, 'unread after read-all', c);
});
await step('logout revokes the refresh token', async () => {
  const r = await call('auth', '/logout', { method: 'POST', body: { refreshToken } });
  expectStatus(r, 204, 'logout');
  const again = await call('auth', '/refresh', { method: 'POST', body: { refreshToken } });
  expectStatus(again, 401, 'refresh after logout');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`Failed: ${failures.join('; ')}`);
  process.exit(1);
}
