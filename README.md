# Hardware & Paint POS

A multi-shop, online point-of-sale system for Sri Lankan hardware and paint shops: billing, stock, purchasing,
customer credit, cheques, batches and expiry, paint tinting, branches and a platform admin that controls which
features each shop gets.

* Architecture and decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
* Build order and workflow: [docs/DEVELOPMENT_WORKFLOW.md](docs/DEVELOPMENT_WORKFLOW.md)
* Operations (backup, restore, deploy, monitoring): [docs/RUNBOOK.md](docs/RUNBOOK.md)
* Security model and checklist: [docs/SECURITY.md](docs/SECURITY.md)

## Status

The backend (NestJS + PostgreSQL) is built and tested for all eight roadmap phases, and the React web app (till, back office
and platform admin screens, `apps/web`) is built on top of it. The API is documented at `/docs` (Swagger).

| Phase | What | State |
|---|---|---|
| 0 | Monorepo, money library, contracts, CI, compose | done |
| 1 | Tenancy with RLS, auth, guards, plans/features/limits, provisioning, roles, jobs | done |
| 2 | Master catalog, products, units, prices, barcodes, stock ledger, costing, low-stock alerts, adjustments, stocktake, import | done |
| 3 | POS checkout, per-terminal invoices, payments, approvals, void, returns, receipts, quotations | done |
| 4 | Suppliers, purchasing, credit, cheques, profit reports, dashboard | done |
| 5 | Batches and expiry | done |
| 6 | Paint tinting, damaged tins | done |
| 7 | Branches, transfers, subscriptions, platform billing, export, analytics | done |
| 8 | Security headers, rate limits, integrity checks, backup/restore rehearsal, load test, OpenAPI, metrics | done |
| Web | React app: sign-in, till (POS), back office, platform admin | done (see "Web app") |

## Run it

Needs Node 22+ and Docker (for PostgreSQL).

```bash
npm install
docker compose up -d postgres            # PostgreSQL on localhost:5433
npm run migrate -w apps/api              # schema + feature catalog + plans + starter master catalog
PLATFORM_ADMIN_EMAIL=you@example.lk PLATFORM_ADMIN_PASSWORD='a-long-password' npm run migrate -w apps/api   # also creates the Super Admin
npm run start -w apps/api                # API on :3000, docs on /docs
npm run dev -w apps/web                  # web app on http://127.0.0.1:5400 (proxies /v1 to the API)
npm run seed:demo -w apps/api            # demo shop with owner, manager, cashier, products and stock
npm run worker -w apps/api               # background jobs (alerts, expiry scan, lifecycle, imports)
```

Create a shop as Super Admin (`POST /v1/admin/auth/login`, then `POST /v1/admin/shops`), give it features with
`PUT /v1/admin/shops/:id/features`, and sign in as its owner with `POST /v1/auth/login`.

## Test it

```bash
npm test                                  # money unit tests + 260+ API tests against a real PostgreSQL
npm run lint:money                        # fails on float arithmetic for money
TILLS=40 SALES=25 npm run load -w apps/api   # many tills selling at once, then checks every invariant
npm run integrity -w apps/api             # database invariants (run after every restore)
```

Tests create a fresh `pos_test` database on the PostgreSQL at `localhost:5433` (override with `TEST_PG_BASE`).

## Layout

```
apps/api        NestJS API + worker (src/<module>, src/db/migrations, test, scripts)
packages/money  decimal helpers, rounding, unit conversion
packages/contracts  permission keys, feature keys, roles, error codes
infra           Dockerfile, nginx, backup and restore-rehearsal scripts
docs            architecture, workflow, runbook, security
```

## Web app (`apps/web`)

React + TypeScript + Vite + Tailwind, TanStack Query for server data, Zustand for the till's cart. It talks to the API through
a dev proxy (`/v1`), so cookies stay same-origin. There is no offline mode: the till needs the network.

* **Sign in** (`/login`) then **Start selling** (choose which registered till this device is) or **Back office**.
* **Till** (`/pos`): scan or type to find items (barcode, SKU, short code, name, Sinhala name), favourites, unit selection, per-line
  discount, customer, split payments (cash, card, transfer, cheque, credit), change, 80 mm receipt preview and print, hold and recall
  bills, quick-add of unlisted items, supervisor approval by email + PIN, clear messages when stock is short. A retry never creates
  a second bill (the cart keeps its idempotency key until it changes).
* **Back office** (`/app`): dashboard and alerts, products and prices, stock (low, adjustments, opening stock), purchasing, customers
  and credit, sales with void and return, profit, expiry, tinting, branch transfers, team and roles, settings and data export.
  Menus appear only for what the signed-in user may do and what the shop's plan includes.
* **Platform admin** (`/admin`): shops, per-shop feature and limit grants (with optional expiry), plans, billing, analytics, system health.

Money on screen is a preview computed from decimal strings (no floats); the server recomputes every total.

Ports: the dev server uses 5400 because Windows reserves 5141-5240 and 5173 for other services on many machines.
