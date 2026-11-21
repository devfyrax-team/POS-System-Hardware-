# Hardware & Paint POS — Full Architecture (with Functions)

Status: working draft **v2**. Derived from "Hardware & Paint POS — Full System Architecture" (Fyrax Dev Team, 20 Nov 2026), then revised with these product decisions:

| # | Decision |
|---|---|
| D1 | **Online only. No offline mode** (no local queue, no sync engine, no offline invoice blocks). |
| D2 | **Negative stock is never allowed.** A sale that exceeds available stock is rejected; low-stock notifications go to storekeeper / manager / owner. |
| D3 | **Invoice numbering is per terminal.** |
| D4 | **Shop features are granted per shop by the Platform Super Admin only.** Shops cannot change their own plan or features. |
| D5 | **Roles and user assignment are managed per shop by that shop's own admin (Owner).** |
| D6 | Every shop always has ≥ 1 branch. Single-branch shops and multi-branch shops run the same code. |
| D7 | Many cashiers sell at the same time; stock stays exact. |
| D8 | **No cash-drawer / shift management.** The system only prints bills. No drawer sessions, float, handover, blind close or branch-day close. |
| D9 | **Deferred, not designed now:** tax (VAT/levies) rules, invoice-number gap rules, SMS/WhatsApp provider and pricing. See §12. |

---

## 1. Principles (non-negotiable)

1. PostgreSQL is the single source of truth. The till holds only the current cart.
2. Money and stock change only inside database transactions, only via the owning module's service.
3. History is immutable: `stock_movement`, `sale`, `sale_line`, `payment`, `credit_entry`, `audit_log` are insert-only. Corrections are new reversing rows.
4. `shop_id` and `branch_id` come from the session, never from client input.
5. Price and batch never block a sale. **Stock does:** a sale cannot take stock below zero.
6. Cost and profit are visible to roles holding `cost.view` / `profit.view` only. Cost fields are stripped in the API serializer, not only hidden in the UI.
7. Modules call each other's services, never each other's tables.
8. Platform control (plans, features, limits) and shop control (users, roles, settings) are separate worlds with separate permissions and separate screens.

---

## 2. System context

```
 ┌───────────────────────── Clients (one React PWA, 3 shells) ─────────────────────────┐
 │  POS shell (till)          Back-office shell (shop admin/manager/storekeeper)  Admin shell │
 │  cart in memory only       TanStack Query, Zustand                          (super admin)  │
 └──────────────┬──────────────────────────────┬────────────────────────────────┬───────────┘
                │ HTTPS REST /v1 (cookies)     │                                │
        ┌───────▼──────────────────────────────▼────────────────────────────────▼────────┐
        │  Nginx (TLS; subdomains: app. api. admin. www.)                                 │
        │  NestJS API (stateless modular monolith) ── Swagger/OpenAPI                     │
        │  Guard chain: Auth → Tenant → Subscription → Feature → Permission → Limit       │
        └───────┬─────────────────────────────┬───────────────────────────────────────────┘
                │ Prisma + raw SQL (tx)       │ enqueue
        ┌───────▼─────────┐           ┌───────▼────────┐        ┌───────────────────────┐
        │ PostgreSQL (RLS)│◄──────────│ Worker process │───────►│ SMS / WhatsApp / email│
        │ + job queue     │           │ (same image)   │        └───────────────────────┘
        └─────────────────┘
        Backups: WAL archiving (PITR) → off-server storage. Sentry + metrics.
```

Deployables (Docker Compose on one VPS): `nginx`, `api`, `worker`, `postgres` (+ optional `pgbouncer`).

### Repo layout (pnpm monorepo)
```
apps/api/        NestJS: src/modules/*, src/common/*, prisma/
apps/worker/     boots job handlers only
apps/web/        React PWA: src/pos, src/backoffice, src/admin, src/shared
packages/contracts/  shared DTO schemas, enums, permission keys, feature keys
packages/money/      decimal helpers, rounding, unit conversion (pure, heavily tested)
infra/ docs/
```

---

## 3. How one system serves many shops

### 3.1 Two levels of control

| Level | Who | Controls | Cannot touch |
|---|---|---|---|
| **Platform** | Super Admin (platform staff) | Shops, plans, **feature grants**, limits, billing, subscription state, master catalog | A shop's daily sales detail, a shop's cost/profit |
| **Shop** | Shop Admin (the shop's Owner) | That shop's branches, users, **roles**, settings, products, prices | Its own plan, features, limits |

### 3.2 Tenant data isolation
- One database, one schema. Every tenant row has `shop_id`; branch-level rows (stock, sales) also `branch_id`.
- **Enforced twice:** (a) the API takes `shop_id` from the session and scopes every query; (b) PostgreSQL **Row-Level Security** blocks any row whose `shop_id` ≠ the transaction's shop.
- Composite foreign keys `(shop_id, id)` stop a record in one shop pointing at another shop's record.
- **[DECISION]** Every tenant request runs in one transaction opened by `TenantTx.run(ctx, fn)`:
  ```
  BEGIN;
  select set_config('app.shop_id', $1, true);   -- true = transaction-local (pooler-safe)
  select set_config('app.user_id', $2, true);
  ... business code ...
  COMMIT;
  ```
  The app DB role is non-owner and not BYPASSRLS. Session-level `SET` is forbidden (lint + test). Prisma has no native RLS, so all tenant DB access goes through `TenantTx`; hot paths use raw SQL.
- Platform tables (`plan`, `feature`, `subscription`, `master_*`) are non-tenant or guarded by `app.is_platform_admin`.

### 3.3 Provisioning a new shop (Super Admin)
`ShopProvisioningService.create({name, shop_type, plan, ownerEmail, trial?})`, one transaction:
1. create `shop` (status `trial|active`), settings seeded from `shop_type` (Hardware / Paint / Both);
2. create default branch **"Main"** (so branchless shops still have exactly one branch);
3. seed the shop's **system roles** from role templates (Owner, Manager, Cashier, Storekeeper);
4. create the Owner user (invite link, force password set) and assign Owner @ Main;
5. create `subscription` from the plan; resolve feature set and limits;
6. register default tax and receipt settings; write audit rows;
7. enqueue welcome / onboarding-checklist notification.

### 3.4 Shop-wise features (controlled only by Super Admin)
Three layers, resolved on every request:

```
effective_feature(shop, key) =
    shop_feature_override(shop, key)        if present and not expired   (Super Admin)
    else plan_feature(plan, key)
  AND  feature allowed for shop_type        (e.g. tinting only Paint/Both)
```

Feature keys (examples): `multi_branch`, `branch_transfers`, `batch_expiry`, `colour_tinting`, `credit_sales`, `cheques`, `quotations`, `delivery_notes`, `price_tiers`, `bulk_import`, `label_printing`, `advanced_profit`, `sms_alerts`, `whatsapp_alerts`, `api_access`, `custom_roles`.

Limits (same pattern, plan default + per-shop override): `max_users`, `max_branches`, `max_terminals_per_branch`, `max_products`, `sms_monthly_allowance`.

Tables: `feature`(key, description, module) · `plan_feature` · `plan_limit` · `shop_feature_override`(shop_id, feature_key, enabled, expires_at, reason, granted_by) · `shop_limit_override`.

Functions:
- `FeatureService.resolve(shopId) → {features:Set, limits:Map}` — cached (short TTL) and invalidated on any change; included in the session bootstrap `GET /me`.
- `FeatureService.has(shopId, key)` · `LimitService.check(shopId, resource, delta)` → throws `PLAN_LIMIT(resource, limit)`.
- Guards: `@RequireFeature('batch_expiry')` (API returns `403 FEATURE_NOT_ENABLED`), `@EnforceLimit('branches')` on create endpoints.
- Super Admin: `AdminFeatureService.setOverride(shopId, key, enabled, expiresAt, reason)` · `clearOverride` · `setLimitOverride` · `changePlan` · `bulkApply(planId | shopIds[])`. Every change is audited (who, old, new).
- UI: the web shell reads the resolved set and hides menus/screens for disabled features; **the server is the real gate.**
- Downgrade/removal behaviour: disabling a feature never deletes data. It hides new use (e.g. disabling `batch_expiry` freezes batch screens but ledger stays intact); downgrade validated against usage (`DowngradeCheck`: users, branches, terminals over the new limit must be resolved first).

### 3.5 Shops with or without branches
- Every shop has ≥ 1 branch; stock, sales, terminals are always branch-scoped. A shop with one branch is simply "one-branch mode".
- **UI mode** is derived: if the shop has exactly one branch and `multi_branch` is off, branch pickers, transfers, branch reports and branch filters are hidden; the session is auto-bound to that branch.
- Turning `multi_branch` on (Super Admin) lets the Shop Admin add branches up to `max_branches`. **No data migration**, because per-branch stock existed from day one.
- Users are assigned **per branch** (`user_branch_role`): a user may hold different roles in different branches; an Owner role is shop-wide.
- Branch-level setting overrides exist only where meaningful (expiry windows, low-stock recipients, receipt header).

### 3.6 Shop-wise roles (controlled by the Shop Admin)
- Roles belong to a shop: `role(shop_id, name, is_system, permissions[])`. The four system roles are seeded per shop; **with the `custom_roles` feature** the Shop Admin can create new roles (e.g. "Senior Cashier", "Paint Specialist") by ticking permissions.
- A shop's role can only include permissions whose feature is enabled for that shop, and never platform permissions.
- Shop Admin functions: `UserAdminService.invite/deactivate/resetPin/resetPassword` · `RoleService.create/update/clone/delete(role)` · `assignBranchRole(userId, branchId, roleId)` · `setApprovalLimits(roleId, {maxDiscountPct, maxRefund})`.
- Guard-rails: a shop always keeps ≥ 1 active Owner; Owner role cannot be deleted; a Manager can manage users **only in their own branch and only with roles ≤ their own**; every role/user change is audited.
- Default permission matrix (editable per shop for non-Owner roles):

| Permission | Cashier | Storekeeper | Manager | Owner |
|---|---|---|---|---|
| sale.create / payment.take | ✔ | – | ✔ | ✔ |
| price.change (catalog) | – | – | ✔ | ✔ |
| price.override_on_sale | shop flag | – | ✔ | ✔ |
| cost.view / profit.view | – | – | ✔ | ✔ |
| sale.void / refund / discount.large | needs approval | – | ✔ | ✔ |
| stock.receive / stock.count | – | ✔ | ✔ | ✔ |
| stock.adjust | – | request | ✔ | ✔ |
| lowstock.receive_alerts | – | ✔ | ✔ | ✔ |
| user.manage / role.manage | – | – | own branch (limited) | ✔ |
| branch.manage / shop.settings | – | – | – | ✔ |

---

## 4. Cross-cutting design

### 4.1 Authentication
Argon2id; HTTP-only Secure cookie access token (short-lived) + rotating refresh token (hashed, reuse detection revokes the family). Login → pick branch → pick registered terminal. **Cashier PIN** gives fast user switch on a registered terminal bound to its branch. Rate limits on login, PIN, supervisor override, uploads. Session is invalid if the shop is suspended or the terminal is deactivated.

### 4.2 Supervisor override
`ApprovalService.requestOverride(action, entity, approverPin)` validates an approver holding the permission, logs **both** cashier and approver, and returns a short-lived one-shot token bound to (action, entity, terminal).

### 4.3 Audit
`AuditService.record({action, entity, entityId, old, new, terminalId, approverId?})`, insert-only, in the same transaction. Covers login, price change, void, refund, adjustment, import, role/user change, feature/plan change (platform), support access.

### 4.4 Idempotency (retained, still needed online)
`Idempotency-Key` header (UUID created when the cart is opened) on money/stock POSTs. `idempotency_key(shop_id, key UNIQUE, request_hash, response)`. A retry after a dropped response returns the stored result instead of a duplicate sale; same key + different body → 409.

### 4.5 Numbers
`numeric(18,4)` for money and quantity, never float. `packages/money`: `roundMoney` (half-up, **per line then summed**), `convertQty(qty, factor)`. Conversion factor is snapshotted onto every transaction line. Single currency per shop (LKR default).

### 4.6 API conventions
REST `/v1`, RFC 7807 errors with stable codes: `STOCK_SHORT`, `CREDIT_LIMIT`, `VERSION_CONFLICT`, `FEATURE_NOT_ENABLED`, `PLAN_LIMIT`, `SUBSCRIPTION_RESTRICTED`, `APPROVAL_REQUIRED`. Optimistic concurrency via `version` + `If-Match`. Cursor pagination.

### 4.7 Jobs and events
Postgres queue (`job` table, `FOR UPDATE SKIP LOCKED`, retry/backoff, dead-letter) behind a `JobQueue` interface (BullMQ swappable). Services write `outbox_event` rows in the same transaction; the worker dispatches them (alerts, notifications). Checkout never calls an external service.

### 4.8 Connectivity behaviour (no offline mode)
The till needs the network to sell. If the API is unreachable the POS shows a clear "No connection – cannot bill" state and keeps the open cart in memory; when the connection returns the cashier presses pay again (same idempotency key, so no duplicate). Receipts print after the server confirms.

---

## 5. Modules and functions

Notation: `Service.method(args) → result`. Endpoints listed per module.

### M1. Identity & Shop Administration (`identity`)
- `AuthService.login / refresh / logout / switchUserByPin(terminalId, pin) / changePassword / resetPassword`
- `ShopService.getSettings / updateSettings` — shop_type (read-only for shop), costing_method (+effective date), expiry windows & policy, receipt format, tax config, below-cost warning, low-stock recipients/channels, price-override flag.
- `BranchService.create / update / deactivate / list` — `@EnforceLimit('branches')`, `@RequireFeature('multi_branch')` beyond the first.
- `UserAdminService` / `RoleService` / `assignBranchRole` (see 3.6) · `setPin`.
- `TerminalService.register(branchId, name, prefix) / deactivate / list` — `@EnforceLimit('terminals')`; prefix unique per shop.
- `ApprovalService`, `AuditService.query`.
- Endpoints: `POST /auth/*`, `GET /me` (user, branch, resolved features/limits, permissions), `CRUD /users`, `CRUD /roles`, `PUT /users/:id/branch-roles`, `CRUD /branches`, `CRUD /terminals`, `GET|PATCH /shop/settings`, `GET /audit-log`.

### M2. Catalog (`catalog`)
- Master (platform-owned, read-only to shops): `MasterCatalogService.search / getVariants / suggestMatch(name|barcode)` · `MasterReviewService.listSubmissions / approve / merge / reject` (platform admin) · `VariantGenerator.generate(template, axes[])`.
- Shop products: `ProductService.createFromMaster / createCustom / quickAdd(name, unit, price) [flag needs_review] / update(version) / deactivate / bulkSelectFromMaster`.
  Creating a product also creates its `stock_balance` row (qty 0) for every active branch (and for each new branch later), so checkout never creates rows lazily.
- `PricingService.setPrice(productId, unitId, tier, price)` — writes `price_history` in the same tx; never blocks; `bulkSetPrices(rows)` (price grid).
- `UnitService.defineUnits(productId, baseUnit, conversions[]) / convert()`.
- `BarcodeService.add / lookup(code) → {product, unit} / generateSku / generateShortCode`.
- `LabelService.render(productIds|receiptId, template)` (`@RequireFeature('label_printing')`).
- `ProductSearchService.search(q, branchId)` — name, size, SKU, short code, barcode, favourites; returns price + branch stock.
- Endpoints: `GET /master/products`, `POST /products`, `PATCH /products/:id`, `PUT /products/:id/prices`, `GET /products/search`, `GET /products/lookup`, `POST /products/quick-add`, `POST /labels/render`, `POST /master/submissions`.

### M3. Inventory (`inventory`) — exact stock
Only this module writes `stock_balance`, `stock_movement`, `stock_batch`, `cost_layer`.

- `StockService.apply(movement)` — **the only way stock changes.** Inserts the `stock_movement`, runs the guarded balance update, consumes/creates cost layers and batch quantities, writes an outbox event when the balance crosses a threshold. Returns `{movementId, cogs, layersConsumed[]}`.
- `StockService.decrementAtomic(shop, branch, product, qty)`:
  ```
  UPDATE stock_balance SET quantity = quantity - :qty
  WHERE shop_id=:s AND branch_id=:b AND product_id=:p AND quantity >= :qty
  RETURNING quantity;       -- 0 rows → STOCK_SHORT(available)
  ```
  A single atomic statement (never read-then-write). The row lock serialises two tills selling the same product; the second re-checks against the new quantity. A `CHECK (quantity >= 0)` constraint is a second safety net.
- Queries: `getBalance / getBatches / listLow / listOut / listSlowFast / listNearExpiry`.
- `BatchService` (`batch_expiry`): `createOnReceipt`, `allocate(branch, product, qty, preferredBatchId?)` (earliest expiry first; explicit pick honoured; expiry = mfg + shelf life when missing).
- `CostingService`: `createLayer(receiptLine)`, `consume(branch, product, qty, method) → {cogs, parts}`, `costReturn(origSaleLine, qty)` (back at original cost), `moveLayers(transferLine)`, `allocateLanded(receipt)`. Layers are linked to batches (`cost_layer.batch_id`), so a non-FIFO batch choice costs that batch's own layer. **Without negative stock there are no negative layers and no re-costing corrections.**
- `LowStockService` — see 5.9 below.
- `AdjustmentService.request` (storekeeper) → `approve/reject` (manager/owner) → `post(reason)`; damaged stock gets status `damaged`.
- `TransferService` (`branch_transfers`): `request → approve → dispatch (in-transit) → receive (partial, discrepancies) → close`; cost layers travel with the stock.
- `StocktakeService.open(scope) → snapshot` · `recordCount` · `review` · `post(approver)` — sales made during a count are netted so nothing is counted twice.
- `ReconciliationService.run(branch)` — Σ ledger vs balance; difference raises an alert.
- Endpoints: `GET /stock`, `GET /stock/:productId/batches`, `POST /adjustments`, `POST /adjustments/:id/approve`, `POST /transfers…`, `POST /stocktakes…`, `GET /reports/inventory/*`.

### M4. POS & Sales (`sales`)
- `CheckoutService.checkout(cmd, ctx)` — flow in §6.1. Idempotent.
- `CartValidator.validate(cart)` — recomputes prices, unit, tier, tax, discounts; checks role limits.
- `InvoiceNumberService.next(terminalId)` — **per-terminal**: `UPDATE invoice_sequence SET next = next+1 WHERE terminal_id=:t RETURNING next` inside the sale transaction, so a failed attempt leaves no gap and tills never contend. Format `<TERMINALPREFIX>-<000123>` (e.g. `MAIN-T2-000123`).
- `PaymentService.record(saleId, payments[])` — cash, card, bank transfer, cheque, credit, split; each stores method, amount, reference (card slip / transfer / cheque no.), cashier, terminal and branch. No cash-drawer reconciliation.
- `DiscountService.check(role, bill/line)` → ok | `APPROVAL_REQUIRED`.
- `VoidService.void(saleId, reason, approval)` · `ReturnService.create(origSaleId, lines, reason, disposition)` — quantities validated against the original sale net of earlier returns; tinted paint non-returnable; refund or account credit; stock back to sellable/damaged at original cost.
- `QuotationService` (`quotations`): create / convertToSale / expire · `DeliveryNoteService` (`delivery_notes`): partial deliveries.
- `HeldBillService.hold / recall / list` — server-side `held_bill` per terminal (survives a till refresh), no stock reservation.
- `SalesSummaryService.byCashier(branch, dateRange)` / `byTerminal(...)` / `byPaymentMethod(...)` — end-of-day totals per cashier or terminal, read from sales and payments (a report, not a shift/drawer workflow).
- `ReceiptService.render(saleId, lang, 80mm)` — Sinhala/Tamil/English; non-Latin text rendered as image for thermal printers.
- `StockCheckService.quickCheck(branch, productIds)` — live stock hint for the till (no reservation; the server decides at pay).
- Endpoints: `POST /sales`, `GET /sales/:id`, `GET /sales/:id/receipt`, `POST /sales/:id/void`, `POST /returns`, `POST /quotations[/:id/convert]`, `POST|GET /held-bills`, `GET /sales/summary`, `GET /stock/check`.

### M5. Purchasing & Suppliers (`purchasing`)
`SupplierService.create/update/statement/balance` · `PurchaseOrderService.create/approve/cancel` · `ReceiptService.receive(poId?, lines, batchData, landedCosts)` (one tx: batch + cost layer + `StockService.apply(purchase)` + payable; returns **cost-change notices**, optional repricing, never blocking) · `PurchaseReturnService` · `SupplierPaymentService.pay` · purchase price history (insert-only).

### M6. Customers, Credit & Cheques (`customers`)
`CustomerService` (type retail/contractor/wholesale → price tier `price_tiers`) · `CreditService.checkAndReserve(customerId, amount)` — **`SELECT … FOR UPDATE` on the customer row**, verify `balance + amount ≤ limit`; `recordPayment` · `ChequeService.record / deposit / clear / bounce(fee?)` (`cheques`; same states for supplier cheques) · statements and ageing · overdue reminders (enqueue). `@RequireFeature('credit_sales')`.

### M7. Import (`import`) — `bulk_import`
`ImportService.upload / stage / validate / match(barcode → SKU → fuzzy incl. Sinhala & alt names) / preview / downloadErrors / confirm → job / undo(batch)`. Chunks of 500–1000 rows, `row_hash` + `batch_id` idempotency, resumable, progress events. Opening stock posts separately through `StockService.apply(opening)`.

### M8. Paint (`paint`) — `colour_tinting`, `batch_expiry`
`TintService.mix(baseProduct, colourCode, formula, qty, customerId?)` (consume base batch + colorant ml, create tinted unit, cost = Σ consumed, non-returnable, save formula) · `reorder(customer, colourCode)` · `DamagedTinService` · `SupplierReturnService.proposeForNearExpiry`.

### M9. Reporting & Notifications (`reporting`, `notifications`)
- Reports (live indexed SQL): sales, inventory, profit (est. gross profit; by item/category/branch/cashier; price-change gain; replacement-cost margin; below-cost & missing-cost flags — `profit.view` only), credit & payables, exceptions (adjustments, voids, large discounts, price changes, stock reconciliation differences).
- `DashboardService.owner(branchIds)` — today's sales/COGS/GP, sales by payment method, low stock, near-expiry, overdue credit, cheques due.
- `NotificationService.send(type, recipients, channel)` — in-app always; SMS/WhatsApp only if the shop has the feature and allowance; retry with backoff; delivery status; per-shop recipients per alert type.

### M10. Platform Administration (`platform`) — Super Admin only
- `PlanService.define(limits, features)` · `SubscriptionService.start(trial) / change(plan) / markPastDue / restrict / cancel` (trial → active → past_due(grace) → restricted(read-only) → cancelled(export window)).
- `AdminShopService.list / view / create (provisioning §3.3) / suspend / reactivate / supportAccess(consent token, time-boxed, audited)`.
- `AdminFeatureService` and `LimitService` (§3.4) · `FeatureFlagService` (platform-wide rollout flags).
- `PlatformBillingService` — platform invoices/payments in **separate tables and screens** from shop sales.
- `ExportService.exportShopData(shopId)` — products, sales, customers, suppliers, stock history.
- `PlatformAnalytics` (signups, active shops/terminals, plan mix, churn) · `SystemHealth` (queues, errors, backups).
- Endpoints (admin subdomain only): `CRUD /admin/shops`, `PUT /admin/shops/:id/features`, `PUT /admin/shops/:id/limits`, `PUT /admin/shops/:id/plan`, `CRUD /admin/plans`, `GET /admin/analytics`, master catalog review.

### 5.9 Low-stock notification (replaces negative-stock handling)
- Each product has a `min_level` per branch (default from product, overridable per branch).
- **Event-driven:** when `StockService.apply` moves a balance from above `min_level` to at/below it (or to zero), it writes an `outbox_event(LOW_STOCK | OUT_OF_STOCK)` in the same transaction. The worker sends the notification to everyone in that branch holding `lowstock.receive_alerts` (Storekeeper, Manager, Owner by default; configurable) and the Owner for shop-wide items, via in-app plus SMS/WhatsApp where enabled. De-duplicated: one alert per crossing, re-armed when stock is restocked above the level.
- **Scheduled safety net:** `lowstock.check` job daily per branch lists everything at or below min level, and feeds the dashboard and the low/out-of-stock report.
- **At the till:** when a line cannot be filled, the cashier sees "Only 3 available" and may reduce the quantity or remove the line. The sale is not accepted below zero. The till may also show a live "low stock" hint on item add.

---

## 6. Critical flows

### 6.1 Checkout (many cashiers at once)
```
POST /sales {idempotencyKey, terminalId, customerId?, lines[], payments[]}
 1. Guards: auth → tenant → subscription active → permission(sale.create) → terminal active → idempotency lookup
 2. TenantTx.run:
    a. set_config app.shop_id / app.user_id
    b. IdempotencyService.claim(key)  (existing key → return stored result)
    c. CartValidator: reload products / prices / tier / tax; recompute every total; check discount & override approvals
    d. If credit payment: lock customer row  (lock #1)
    e. InvoiceNumberService.next(terminal)    (per-terminal row)
    f. Sort lines by product_id; for each line:
         BatchService.allocate() → StockService.apply(sale) → decrementAtomic()  (lock #2, per product, FIFO order)
         CostingService.consume() → cogs stored on the line
       Any STOCK_SHORT → whole tx rolls back; response lists each short line + available qty
    g. CreditService.checkAndReserve (credit sales) → credit_entry
    h. insert sale, sale_lines (price charged, qty sold unit + base unit, factor, cogs, batch, movement), payments, audit, outbox
 3. COMMIT → {invoiceNo, status}
 4. Till prints receipt after commit (no printer/network inside the tx)
 5. Worker: low-stock alerts, summaries
```
**Lock order (deadlock-free):** customer → stock rows ordered by `product_id` → terminal invoice row. Stock update is placed late to keep the lock short.

### 6.2 Concurrency behaviour (big shop)
| Situation | Result |
|---|---|
| 3 cashiers, 3 different products | Fully parallel |
| Same product, enough stock (20; requests 5, 5, 2) | All succeed; each waits only a few ms on the row |
| Same product, short (10; requests 5, 5, 2) | 5 and 5 succeed (stock 0), then 2 → "Only 0 available"; never oversold |
| Same credit customer at two tills | Customer row locked; second sale is checked against the true running balance |
| Two staff edit the same price/customer | `version` check rejects the second save with a reload prompt |
| Several cashiers on one terminal (PIN switch) | Allowed; every sale records its cashier and terminal |
Independent per till: cart, held bills, invoice sequence. Shared: stock rows, customer balances, product/price records. Scale limits: DB connection pool (add a pooler as tills multiply) and the plan's terminal limit per branch.

### 6.3 Receive goods
`POST /receipts` → tx: validate → for each line `BatchService.createOnReceipt` (if tracked) → `CostingService.createLayer` → `StockService.apply(purchase)` → allocate landed cost → raise supplier payable → return cost-change notices → low-stock alert re-armed.

### 6.4 Return
Validate vs original sale net of prior returns → disposition sellable | damaged → `StockService.apply(sales_return)` at original layer cost → refund (recorded as a refund payment entry) or `credit_entry` → original sale preserved.

### 6.5 Branch transfer
Request → approve → dispatch: stock leaves source (in transit), layers detach → receive: stock enters destination, cost inherited; partial receipt and discrepancy become an approved adjustment.

### 6.6 Stocktake
Open: snapshot system qty. Count: scans accumulate. Close: expected = snapshot + movements since snapshot; variance = counted − expected; manager approves → `stocktake_correction` movements.

### 6.7 Bounced cheque
Status `bounced` → reverse payment → restore customer balance via `credit_entry` → optional fee entry → notify → credit report.

### 6.8 Subscription restriction
Daily job moves `past_due` → `restricted`; `SubscriptionGuard` makes the shop read-only except export and payment. Tills show a banner.

### 6.9 Feature grant by Super Admin
`PUT /admin/shops/:id/features {key, enabled, expiresAt, reason}` → audit → cache invalidation → next `GET /me` or any guarded request reflects it; an expiry job (daily) removes lapsed overrides and notifies the shop owner.

---

## 7. Data model (~45 tables)

| Area | Tables (key columns) |
|---|---|
| Platform | `plan` · `feature` · `plan_feature` · `plan_limit` · `shop_feature_override` · `shop_limit_override` · `subscription` · `platform_invoice` · `platform_payment` · `feature_flag` |
| Tenancy/access | `shop`(shop_type, status, settings jsonb) · `branch` · `user` · `role`(shop_id, is_system, permissions) · `user_branch_role` · `terminal`(branch, prefix, status) · `refresh_token` · `audit_log` · `idempotency_key` · `outbox_event` |
| Master catalog | `master_category` · `master_product` · `master_variant` · `master_submission` |
| Shop products | `product`(sku, short_code, base_unit, track_batches, shelf_life_days, master_id, version) · `product_unit`(factor) · `product_barcode`(unit) · `price_tier` · `product_price` · `price_history` · `tax_rate` · `branch_product`(min_level, availability) |
| Inventory | `stock_balance`(UNIQUE branch+product, CHECK qty ≥ 0) · `stock_movement` · `stock_batch` · `cost_layer`(batch_id?, qty_in, qty_remaining, unit_cost) · `stock_adjustment` · `stocktake` · `stocktake_line` · `stock_discrepancy` · `low_stock_alert_state` |
| Sales | `sale`(invoice_no, idempotency_key UNIQUE, status, terminal, branch, cashier) · `sale_line` · `payment` · `invoice_sequence`(per terminal) · `held_bill` · `quotation`(+lines) · `delivery_note`(+lines) |
| Purchasing | `supplier` · `purchase_order`(+lines) · `purchase` · `purchase_line` · `supplier_payment` · `purchase_price_history` |
| Customers/credit | `customer`(type, credit_limit, balance, version) · `credit_entry`(insert-only) · `customer_payment` · `cheque` |
| Returns/transfers | `sales_return`(+lines) · `purchase_return` · `branch_transfer` · `branch_transfer_line` |
| Paint | `tint_formula` · `tint_job` |
| Import/jobs | `import_batch` · `import_row` · `notification` · `notification_pref` · `job` |

Key rules: composite FKs with `shop_id`; `stock_movement`, `credit_entry`, `audit_log` have **no UPDATE/DELETE grants** for the app role (trigger backstop); UNIQUE `(shop_id, idempotency_key)`; UNIQUE `(shop_id, terminal prefix)`.
Indexes up front: `sale(shop, branch, created_at)`, `sale_line(product, created_at)`, `stock_movement(branch, product, created_at)`, `stock_batch(branch, product, expiry)`, trigram on product names, `product_barcode(code)`.

---

## 8. Client architecture (React PWA, online only)

- **Shells:** `/pos`, `/app` (back office), `/admin` (super admin, `admin.` subdomain). Menus come from resolved permissions + features + shop mode (single / multi-branch).
- **State:** TanStack Query (server data), Zustand (open cart, selected branch/terminal, UI). **No IndexedDB queue.** A small Dexie/localStorage cache of the product list is optional purely for search speed, never for selling.
- **POS screens:** sign-in / PIN switch → branch & terminal (auto-skipped for single-branch) → sale screen (scan, search, short code, favourites, unit & batch picker, customer, payments, hold/recall) → receipt → returns → quotations.
- **Back office:** dashboard · catalog & price grid · receive goods · stock / batches / expiry · low-stock inbox · adjustments / transfers / stocktake · purchasing · customers / credit / cheques · import wizard · reports · **users & roles (Shop Admin)** · branches / terminals / settings · onboarding checklist.
- **Super Admin:** shops · plans · **feature & limit grants per shop** · subscriptions & billing · master catalog review · analytics · health.
- **Device layer:** `PrintAdapter` (`printReceipt`, `printLabel`; no cash-drawer control) with browser implementation, local print helper, or Electron/Tauri wrapper; scanners as keyboard input.

---

## 9. Jobs

| Job | Trigger | Does |
|---|---|---|
| `outbox.dispatch` | continuous | domain events → handlers (low-stock, notifications) |
| `lowstock.check` | daily per branch | safety-net list at/below min level |
| `expiry.scan` | daily per branch | near-expiry batches → alerts (`batch_expiry`) |
| `stock.reconcile` | nightly | ledger vs balance → discrepancy alert |
| `import.process` | on confirm | chunked, resumable |
| `summary.daily` | scheduled | owner summary |
| `notification.send` | event | retry/backoff, delivery status, allowance counting |
| `credit.reminders`, `cheque.due` | daily | overdue and cheques due |
| `subscription.*` | daily | renewal, trial end, grace → restricted |
| `feature.expire_overrides` | daily | remove lapsed feature grants |
| `backup.verify` | weekly | restore rehearsal check |

---

## 10. Quality gates

- **Tenant isolation:** connect as the app role, set the wrong `app.shop_id`, prove zero reads/writes; test every tenant table.
- **Feature/limit enforcement:** disabled feature → 403 on every guarded endpoint; limits at boundary; override expiry; downgrade checks.
- **Role control:** a Shop Admin cannot grant permissions outside enabled features; Manager cannot escalate; last Owner cannot be removed.
- **Concurrency:** (5, 5, 2) vs 10 units; same credit customer on 2 tills; different products in parallel; lock-order deadlock test; invariant `balance ≥ 0` always.
- **Ledger invariant** after every flow: `balance == Σ movements`.
- **Costing matrix:** FIFO vs average × price rise, returns, transfers, method change.
- **Rounding / unit conversion** snapshot tests.
- **Idempotency:** retried checkout returns the same invoice, never two.
- **Low stock:** one alert per crossing, re-arm on restock, correct recipients.
- Real thermal-printer checklist before pilot.

---

## 11. Roadmap

1. **Foundation** — monorepo, `TenantTx` + RLS, auth/PIN, shop provisioning, branches, users, **roles**, terminals, audit, idempotency, job queue, **plan/feature/limit engine + super-admin shell**, CI, Docker Compose, backups.
2. **Catalog & inventory** — master catalog + seed, products / units / barcodes / prices, labels, import, `StockService`, balances & ledger, low-stock alerts, opening stock, stocktake, **real-printer spike**.
3. **POS & sales** — terminals, checkout, payments, per-terminal invoices, receipts, held bills, returns, quotations, cost layers & COGS.
4. **Purchasing & customers** — suppliers, receipts, payables, credit, cheques, statements, daily profit report → **pilot** with a single-branch shop.
5. **Batches & expiry** — batch tracking, expiry alerts, near-expiry report, SMS/WhatsApp.
6. **Paint module** — tinting, variant generator, damaged tins, supplier returns.
7. **Multi-branch & subscriptions** — branches in UI, transfers, branch reports, subscription lifecycle, platform billing, price tiers.
8. **Launch hardening** — load & security tests, restore rehearsal, monitoring, wider pilot.

---

## 12. Decisions status

| Topic | Status |
|---|---|
| Online only, no offline | **Decided (D1)** |
| No negative stock; low-stock alerts to storekeeper / manager / owner | **Decided (D2)** |
| Per-terminal invoice numbers | **Decided (D3)** |
| Features/limits granted per shop by Super Admin only | **Decided (D4)** |
| Roles & user assignment per shop by Shop Admin | **Decided (D5)** |
| Every shop has ≥ 1 branch; one code path | **Decided (D6)** |
| RLS via transaction-local `set_config`; Prisma + raw SQL through `TenantTx` | **Decided** |
| Lock order customer → stock(product_id) → terminal invoice row | **Decided** |
| Batch↔cost-layer link | **Decided** |
| Costing default FIFO, average optional, effective-dated | **Decided** |
| Jobs on a Postgres queue behind an interface | **Decided** |
| Hosting: single VPS first | **Decided** |
| Cash drawers, shifts, float, handover, day close | **Out of scope (D8)**: bills are only printed |
| Tax (VAT & levies) rules and tax-invoice layout | **Deferred (D9).** Keep price and total fields simple; add a tax layer later without changing stock or ledger |
| Invoice-number gap rules | **Deferred (D9).** Per-terminal sequence stays as designed |
| SMS/WhatsApp provider and per-message pricing | **Deferred (D9).** In-app alerts first; channel interface (`NotificationChannel`) lets providers plug in later |
| Printing approach (browser vs wrapper) | Decided by phase-2 printer spike |
