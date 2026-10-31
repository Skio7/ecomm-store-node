# store-service (Node.js)

One of the two backend services for **DeployKar Shop**. Node 22 + Express 5 + MongoDB.

| Prefix | Module | Owns (MongoDB collections) |
|---|---|---|
| `/api/auth` | sign-up, login, JWT + refresh-token rotation, admin user management | `users`, `refresh_tokens` |
| `/api/users` | profile, address book | `profiles`, `addresses` |
| `/api/products` | catalog, search, facets, reviews, inventory, stock reservations | `products`, `categories`, `reviews`, `reservations` |
| `/api/cart` | cart, coupons, guest-cart merge | `carts` |

The other service, [orders-service](../orders-service) (Python), serves `/api/orders`, `/api/payments` and `/api/notifications`. The two talk over HTTP in both directions:

```
orders-service ──► store-service   GET  /api/cart/internal/carts/:userId           (checkout)
                                   GET  /api/users/internal/users/:id/addresses/:a
                                   POST /api/products/internal/reservations         (reserve stock)
                                   POST /api/products/internal/reservations/:id/commit|release
                                   DELETE /api/cart/internal/carts/:userId          (after payment)
store-service  ──► orders-service  POST /api/notifications/internal/notifications   (welcome, password changed)
```

`/internal/*` routes require the `x-internal-key` header (`INTERNAL_API_KEY`).

## Run locally

Needs Node ≥ 22 and a MongoDB on `localhost:27017`.

```bash
cp .env.example .env
npm install
npm run dev            # http://localhost:4001
```

Demo accounts: `jane@shop.test` / `Customer@123`, `rahul@shop.test` / `Customer@123`, and `admin@shop.test` / `Admin@12345` (local only).

## Deploy (DeployKar)

| Setting | Value |
|---|---|
| Build | `Dockerfile` at the repo root (or buildpack: `npm ci`, start `npm start`) |
| Port | `PORT` (default 4001) |
| Health check | `GET /healthz` (readiness: `GET /readyz`) |

| Env var | Required in production | Notes |
|---|---|---|
| `MONGODB_URI` | yes | set by `connect_database`; `DATABASE_URL` also accepted |
| `JWT_SECRET` | yes, ≥32 chars | **same value** as orders-service |
| `INTERNAL_API_KEY` | yes, ≥32 chars | **same value** as orders-service |
| `ORDERS_SERVICE_URL` | yes | orders-service origin, e.g. `https://orders-xyz.deploykar.app` |
| `SEED_ADMIN_PASSWORD` | no | creates `admin@shop.test` |
| `CORS_ORIGINS` | no | only if the browser calls this service on another origin |
| `MONGODB_DB` | no | database name (default: from the URI, else `deploykar_shop`) |

Missing or invalid production config makes the service exit at startup and list every problem.

## Smoke test

`scripts/smoke.mjs` runs 41 end-to-end checks across both services: routing and health on all 7 prefixes, auth, refresh-token reuse detection, addresses, cart and coupons, idempotent checkout, declined, failing and successful card payments, UPI, cancellation with refund and restock, and notifications.

```bash
SMOKE_BASE_URL=https://<frontend-url> node scripts/smoke.mjs      # through the frontend's /api routing
SMOKE_STORE_URL=http://localhost:4001 SMOKE_ORDERS_URL=http://localhost:4002 node scripts/smoke.mjs
```

Every prefix also has `/health`, `/health/live`, `/health/ready`, `/health/dependencies` (MongoDB + the other service, with latency), `/info` and, when `ENABLE_DEBUG_ENDPOINTS=true`, `/debug/echo`.
