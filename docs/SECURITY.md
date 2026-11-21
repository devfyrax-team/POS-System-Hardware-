# Security model

## Tenant isolation (the most important property)

| Layer | What it does | Where it is tested |
|---|---|---|
| Session | `shop_id`, `branch_id`, `user_id` come only from the signed session, never from a request body or URL | `security.spec.ts` ("a shop id in the request body is ignored") |
| Application | every query is scoped by `shop_id` | all suites |
| PostgreSQL Row-Level Security | every tenant table has `shop_id = app_shop()` as policy (also forced for table owners); the app role is not a superuser and has no `BYPASSRLS` | `tenant-isolation.spec.ts` |
| Composite foreign keys `(shop_id, id)` | a row in one shop cannot point at another shop's row | `tenant-isolation.spec.ts` |
| Transaction-local setting | tenant context is set with `set_config(..., true)` inside each transaction, so connection pooling cannot leak it | `tenant-isolation.spec.ts` ("do not leak between transactions") |
| Branch scope | a branch manager reads and writes only their own branch; owners can see `all` | `multibranch.spec.ts` |

## Authentication and sessions
* Argon2id password and PIN hashes. Generic "invalid email or password" for unknown users and wrong passwords.
* HTTP-only, SameSite=Lax cookies (Secure in production); a bearer token mode exists for tills/API clients.
* Access tokens are HMAC-signed and short-lived (15 min); refresh tokens are random, stored hashed, **rotated on every use**, and
  replaying an old one revokes the whole family. Deactivating a user kills their existing tokens (checked on every request).
* Rate limits: login (10 / 15 min per IP+email), PIN switch and supervisor override (5 / 5 min), and a global per-IP limit.
* Supervisor override tokens are bound to action, entity, terminal and cashier, expire in 2 minutes, and log both people.

## Authorization
* Permissions come from roles per branch, minus any permission whose feature the shop does not have.
* Cost and profit are returned only with `cost.view` / `profit.view`; sale, receipt and stock responses never contain cost.
* Super Admin routes (`/v1/admin/*`) accept only platform tokens; shop tokens are refused and vice versa.
* A shop cannot change its own plan, features or limits (the database policy only lets the platform write them).

## Data integrity
* Money and quantities are `numeric`, handled with a decimal library; a lint step fails the build on float arithmetic.
* Stock, sales, payments, credit and audit tables are insert-only for the application role; corrections are new rows.
* Stock changes use one atomic guarded `UPDATE`; a `CHECK (quantity >= 0)` is the backstop. Checkout runs in one transaction and
  is idempotent (Idempotency-Key). Lock order is customer, then stock rows by product id, then the terminal's invoice counter.
* `npm run integrity` verifies 11 invariants (ledger vs balance, customer balances, sale totals vs lines/payments, cost of goods,
  invoice-number gaps, batches, layers, returns). It runs in tests, after load tests and after every restore.

## HTTP hardening
Security headers (nosniff, frame deny, CSP `default-src 'none'`, no-referrer, HSTS in production), `Cache-Control: no-store`
on the API, CORS allow-list with credentials only for configured origins, 1 MB body limit (15 MB for import uploads, 413 beyond),
request ids, and generic error bodies (database and stack details are never returned). Malformed ids and bodies are 4xx.

## Known gaps and decisions to revisit
* **No frontend yet**, so CSRF has not been exercised end to end. Cookies are SameSite=Lax and mutating calls need JSON bodies; add a
  CSRF token or `Origin` check when the PWA is built.
* In-app notifications only. SMS/WhatsApp (provider and pricing undecided) and email are not implemented.
* Tax (VAT/levies) is not implemented: receipts and totals are tax-free until the rules are decided.
* Super Admin has a single password login. Add 2FA before production.
* Support access to a shop (time-boxed, consented, audited) is described in the architecture but not built.
* The in-memory rate limiter is per process; use a shared store when running several API replicas.
* Secrets come from environment variables. Rotate `JWT_SECRET` and database passwords on a schedule; the app refuses to start in
  production-like compose without `JWT_SECRET`.
