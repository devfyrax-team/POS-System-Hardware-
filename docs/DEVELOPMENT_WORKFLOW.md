# Development Workflow — Function by Function

Companion to [ARCHITECTURE.md](ARCHITECTURE.md). It says **in what order each function is built, what it depends on, and when it is done.** No code here.

---

## 1. How every function is built (the loop)

For each function (a service method plus its endpoint and screen), always in this order:

1. **Contract** — write the request/response shape and error codes in `packages/contracts`. Add the permission key and feature key it needs.
2. **Schema** — migration for any new table/column, including `shop_id`, composite FKs, RLS policy, indexes, and "no UPDATE/DELETE" grants for ledger tables.
3. **Service** — implement the method inside `TenantTx`; call other modules only through their services; write `AuditService` and outbox events in the same transaction.
4. **Tests first for the risky ones** — unit tests (pure logic), integration tests (real Postgres), and for money/stock/tenant functions the extra suites in §4.
5. **Endpoint** — controller with guards in the fixed chain: Auth → Tenant → Subscription → Feature → Permission → Limit; OpenAPI annotations.
6. **Screen** — POS/back-office/admin UI using the contract types; hide by permission and feature.
7. **Review gate** — checklist in §3, then merge.

Rule: **a function is not done until its tests, audit rows, permission check and feature check exist.**

---

## 2. Team flow

- **Branching:** trunk-based. Short-lived branches `feat/<module>-<function>`; one function (or a tight group) per PR; merge to `main` only when CI is green.
- **CI on every PR:** lint (including "no float for money", "no session-level SET"), type-check, unit tests, integration tests against a real Postgres, RLS tests, migration check, OpenAPI diff.
- **Environments:** local (Docker Compose) → staging (copy of production setup, seeded demo shops) → production. Migrations run on staging first, every time.
- **Seed data:** two demo shops (one single-branch hardware, one multi-branch paint) so tenant isolation and branch modes are always testable.
- **Releases:** each roadmap phase ends with a tagged release to staging, a demo, and a go/no-go checklist.

---

## 3. Review gate (every PR)

- [ ] `shop_id` / `branch_id` come from the session, never from the request body
- [ ] Money and quantity use decimal helpers; no floats
- [ ] Stock/ledger/credit changes go through the owning service only
- [ ] Ledger tables are insert-only; corrections are new rows
- [ ] Audit row written for sensitive actions; permission and feature guard present
- [ ] Cost/profit fields stripped for roles without `cost.view` / `profit.view`
- [ ] Idempotency key handled on money/stock POSTs
- [ ] Tests cover the happy path, the permission-denied path, and the other-shop path

---

## 4. Special test suites (built once, reused by every phase)

| Suite | Proves | Built in |
|---|---|---|
| **Tenant isolation** | Wrong `app.shop_id` reads/writes nothing on every tenant table | Phase 1, extended each phase |
| **Feature/limit** | Disabled feature → `FEATURE_NOT_ENABLED`; limits stop at the boundary; override expiry | Phase 1 |
| **Ledger invariant** | `stock_balance == Σ stock_movement` after any flow | Phase 2, run after every later flow |
| **Concurrency** | (5, 5, 2) against 10 units never oversells; different products run parallel; credit never exceeds limit; no deadlock | Phase 3 |
| **Costing matrix** | FIFO/average × price rise, returns, transfers, method change | Phase 3 |
| **Idempotency** | Retried checkout returns the same invoice | Phase 3 |
| **Low-stock** | One alert per crossing, re-arm on restock, right recipients | Phase 2 |

---

## 5. Build order by phase (function-wise)

Each table lists functions **in build order**. "Needs" = must exist first.

### Phase 0 — Project setup (before any function)
Monorepo, NestJS + React + Prisma skeletons, Docker Compose (api, worker, postgres, nginx), CI pipeline, lint rules, `packages/money` (decimal, `roundMoney`, `convertQty`) with its full test suite, Sentry, base OpenAPI.
**Done when:** a "hello" request passes through all guards in CI and a rounding test suite is green.

### Phase 1 — Foundation (identity, tenancy, plans)

| # | Function(s) | Needs | Key tests | Done when |
|---|---|---|---|---|
| 1.1 | `TenantTx.run` + RLS policy template + app DB role | Phase 0 | RLS test on a sample table; pooler-safe `set_config` | Wrong shop sees 0 rows |
| 1.2 | `AuditService.record/query`, `IdempotencyService.claim` | 1.1 | Insert-only grants; duplicate key returns stored response | Audit row appears in same tx |
| 1.3 | `AuthService.login/refresh/logout`, password hashing, cookies, rate limits | 1.1 | Refresh reuse revokes family | Login works for 2 shops |
| 1.4 | Guard chain: Auth, Tenant, Subscription, Feature, Permission, Limit | 1.3 | Each guard denies correctly | Chain wired on a test route |
| 1.5 | `FeatureService.resolve/has`, `LimitService.check`, plan/feature/limit tables, override resolution + cache invalidation | 1.4 | Plan vs override vs expiry; shop_type gating | Resolved set returned by `GET /me` |
| 1.6 | `PlanService.define`, `SubscriptionService.start/change`, `AdminFeatureService.setOverride`, `setLimitOverride` (Super Admin) | 1.5 | Downgrade validated vs usage | Admin changes a shop's features live |
| 1.7 | `ShopProvisioningService.create` (shop, "Main" branch, system roles, owner, subscription) | 1.5, 1.6 | Provisioning is one atomic tx | New shop usable in one call |
| 1.8 | `BranchService`, `TerminalService.register` (+ per-terminal `invoice_sequence` row), limits | 1.7 | Branch/terminal limits enforced | Single-branch mode auto-binds |
| 1.9 | `RoleService`, `UserAdminService`, `assignBranchRole`, `setPin`, `switchUserByPin`, `ApprovalService.requestOverride` | 1.7, 1.8 | Cannot grant out-of-feature permission; last Owner protected; Manager scope | Shop Admin runs own users/roles |
| 1.10 | `ShopService.getSettings/updateSettings`; `JobQueue` + worker skeleton; `outbox.dispatch` | 1.7 | Retry/backoff, SKIP LOCKED | Worker processes a test job |
| 1.11 | UI shells: login, branch/terminal pick, back-office menu by permission/feature, Super Admin shell (shops, plans, feature grants) | 1.5–1.9 | Playwright smoke | Super Admin grants a feature, menu appears |

**Phase exit:** tenant-isolation and feature suites green; two demo shops provisioned.

### Phase 2 — Catalog & inventory

| # | Function(s) | Needs | Key tests | Done when |
|---|---|---|---|---|
| 2.1 | Master catalog read: `search`, `getVariants`, `suggestMatch`; seed loader | 1.x | Sinhala/alt-name search | Search returns seeded items |
| 2.2 | `UnitService.defineUnits/convert`, `ProductService.createFromMaster/createCustom/quickAdd/update(version)`; auto-create `stock_balance` per branch | 2.1 | Version conflict; factor snapshot | Product has units and balances |
| 2.3 | `PricingService.setPrice/bulkSetPrices` + `price_history`; price tiers (`price_tiers`) | 2.2 | History row per change; never blocks | Price grid saves |
| 2.4 | `BarcodeService.add/lookup`, `generateSku/ShortCode`, `ProductSearchService.search` | 2.2 | Multi-barcode per item; fuzzy search speed | Scan or type finds the item |
| 2.5 | **`StockService.apply` + `decrementAtomic`** (guarded UPDATE, `CHECK qty>=0`), ledger, `getBalance` | 2.2 | Ledger invariant; `STOCK_SHORT` | Opening-stock posting works |
| 2.6 | `CostingService.createLayer/consume/costReturn/allocateLanded` (FIFO + average) | 2.5 | Costing matrix v1 | Layer created on opening stock |
| 2.7 | `LowStockService` (min level per branch, threshold-crossing outbox event, recipients, de-dup, daily `lowstock.check`) + `NotificationService` (in-app) | 2.5, 1.10 | Low-stock suite | Storekeeper sees alert |
| 2.8 | `AdjustmentService` (request → approve → post), damaged status | 2.5 | Approval roles; reason required | Adjustment posts ledger row |
| 2.9 | `StocktakeService` (open, count, review, post) | 2.5, 2.8 | Sales during count netted | Variance posts adjustments |
| 2.10 | `ReconciliationService.run` + nightly job | 2.5 | Detects planted difference | Alert raised |
| 2.11 | `ImportService` (stage, validate, match, preview, confirm, undo) as jobs | 2.2–2.5 | Bad rows, resume, undo whole batch | Import 5k rows with progress |
| 2.12 | `LabelService.render` (feature-gated); **real-printer spike** (browser vs helper vs wrapper) | 2.4 | Prints on actual 80 mm printer | Printing approach decided |
| 2.13 | UI: catalog, price grid, stock list, low-stock inbox, adjustments, stocktake, import wizard | 2.x | Playwright | New shop can load products and stock |

**Phase exit:** ledger invariant green after every flow; shop onboarding checklist works end to end.

### Phase 3 — POS & sales

| # | Function(s) | Needs | Key tests | Done when |
|---|---|---|---|---|
| 3.1 | `InvoiceNumberService.next` (per-terminal, in-tx) | 1.8 | No gap on rollback; no cross-terminal lock | Two terminals number independently |
| 3.2 | `CartValidator` (re-price, tier, unit, discount limits) and `DiscountService.check` | 2.3 | Totals recomputed server-side | Tampered cart rejected |
| 3.3 | **`CheckoutService.checkout`** (idempotent; lines sorted by product id; allocate batch → `StockService.apply` → cost; insert sale/lines/payments/audit/outbox) | 3.1, 3.2, 2.5, 2.6 | Concurrency suite; idempotency suite; ledger invariant | (5,5,2) vs 10 passes |
| 3.4 | `PaymentService.record` (cash/card/transfer/cheque/split, references) | 3.3 | Split payments sum to total | Payments stored with cashier/terminal |
| 3.5 | `ReceiptService.render` + `PrintAdapter.printReceipt` (after commit) | 3.3, 2.12 | Sinhala/Tamil/English render | Receipt prints on real printer |
| 3.6 | `StockCheckService.quickCheck`, `HeldBillService` | 2.5 | No reservation made | Cashier holds/recalls a bill |
| 3.7 | `VoidService`, `ReturnService` (original-cost return, tinted non-returnable), supervisor override flow | 3.3, 1.9 | Return qty cap; both users audited | Void/return reverses stock and money |
| 3.8 | `QuotationService` (convert to sale), `DeliveryNoteService` (feature-gated) | 3.3 | Conversion revalidates stock | Quote becomes a sale |
| 3.9 | `SalesSummaryService` (by cashier/terminal/payment method) + first reports | 3.3 | Totals match sales | Daily totals page |
| 3.10 | UI: POS sale screen (scan/search/short code/favourites/unit & batch pick, payments, hold/recall, receipt), returns | 3.x | Playwright 3-till parallel | Multiple cashiers bill at once |

**Phase exit:** concurrency, costing and idempotency suites green on staging with 5+ simulated tills.

### Phase 4 — Purchasing & customers → pilot

| # | Function(s) | Needs | Key tests |
|---|---|---|---|
| 4.1 | `SupplierService`, `PurchaseOrderService` | 1.x | Statement and balance |
| 4.2 | `ReceiptService.receive` (layers, batches, landed cost, payable, cost-change notice) | 4.1, 2.6 | Cost-change notice never blocks; re-arms low stock |
| 4.3 | `PurchaseReturnService`, `SupplierPaymentService` | 4.2 | Payable and stock both reduce |
| 4.4 | `CustomerService` (types → tiers), `CreditService.checkAndReserve` (row lock), `recordPayment` | 3.3 | Two tills, one credit customer |
| 4.5 | `ChequeService` states incl. `bounce` | 4.4 | Bounce restores balance |
| 4.6 | Statements, ageing, reminders (in-app) | 4.4 | Ageing buckets |
| 4.7 | `ProfitReport`, `DashboardService.owner`, flags (below cost, missing cost); cost stripped for non-`cost.view` | 3.9, 2.6 | Role-based field stripping |
| 4.8 | UI: receive goods, suppliers, customers/credit, reports, dashboard | 4.x | Playwright |

**Pilot** with one single-branch shop after this phase (paper bills in parallel for the first week).

### Phase 5 — Batches, expiry, alerts

`BatchService.createOnReceipt/allocate` → expiry calculation from shelf life → `expiry.scan` job and near-expiry report (value at cost, supplier terms) → expired-stock policy at till → channel interface for SMS/WhatsApp once a provider is chosen. Tests: earliest-expiry allocation, explicit batch pick, batch↔layer cost consistency.

### Phase 6 — Paint

`VariantGenerator` → `TintService.mix` (consume base + colorant, cost sum, non-returnable, formula saved) → `reorder` → `DamagedTinService` → `SupplierReturnService`. Tests: tint cost, concurrency on colorant stock.

### Phase 7 — Multi-branch & subscriptions

`TransferService` (request → approve → dispatch → receive, layers move) → branch reports → `multi_branch` UI mode switch → subscription lifecycle jobs (renewal, trial end, grace → restricted) → `PlatformBillingService` → `ExportService` → `feature.expire_overrides` job → platform analytics and health.

### Phase 8 — Hardening

Load tests (many tills, big catalogs, big imports), security review, restore rehearsal, migration tests, monitoring alerts, wider pilot.

---

## 6. Dependency spine (what blocks what)

```
TenantTx/RLS → Auth → Guards → Feature/Limit → Provisioning → Branch/Terminal → Roles/Users
                                                                   │
Products/Units → Prices ─┐                                         │
                         ├→ StockService.apply → Costing → CheckoutService → Receipts
Barcodes/Search ─────────┘        │                  │            │
                           LowStock/Adjust/Stocktake  Returns/Void  Credit/Cheques → Profit reports
```
The critical path is **TenantTx → StockService.apply → CheckoutService.** Everything else can be built in parallel once those three are stable.

---

## 7. Suggested team split (if more than one developer)

- **Dev A (core):** TenantTx, guards, feature engine, `StockService`, `CheckoutService`, costing.
- **Dev B (back office):** catalog, import, purchasing, customers, reports, back-office UI.
- **Dev C (POS & platform):** POS UI, printing, Super Admin shell, subscriptions.
Core functions (A) are reviewed by two people; they carry the money and tenant-isolation risk.

---

## 8. Definition of done per phase

All functions in the phase merged; its test suites green in CI; demo on staging with both seeded shops; migrations rehearsed; docs updated (ARCHITECTURE.md decisions and OpenAPI); known issues listed; go/no-go signed off by the product owner.
