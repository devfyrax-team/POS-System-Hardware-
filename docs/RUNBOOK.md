# Runbook

## Deploy (single Linux VPS, Docker Compose)

```bash
cp .env.example .env            # set JWT_SECRET, POSTGRES_PASSWORD, APP_DB_PASSWORD, CORS_ORIGINS
docker compose --profile full up -d --build
```
`api` runs the migrations on start (`npm run migrate`), `worker` runs background jobs, `nginx` terminates HTTPS
(certificates in `infra/certs`). Readiness: `GET /health/ready`. Metrics (platform only): `GET /v1/admin/metrics`.

Migrations are forward-only SQL files in `apps/api/src/db/migrations`. Run them on staging first, every time.
The application connects as `pos_app` (not a superuser, no `BYPASSRLS`): the database refuses cross-shop access
even if the application code has a bug. The ledger tables (`stock_movement`, `sale`, `sale_line`, `payment`,
`credit_entry`, `audit_log`, ...) have no UPDATE/DELETE rights for that role.

## Backups

* **Logical backup, nightly:** `infra/backup.sh` (custom-format `pg_dump`, checksum, 14-day retention, optional
  `OFFSITE_RSYNC` copy to another server). Cron: `15 2 * * * cd /srv/pos && PGDATABASE=pos BACKUP_DIR=/var/backups/pos OFFSITE_RSYNC=backup@host:/pos ./infra/backup.sh`
* **Point-in-time recovery:** enable WAL archiving on PostgreSQL and ship segments off the server, e.g. with pgBackRest or WAL-G:
  ```
  archive_mode = on
  archive_command = 'pgbackrest --stanza=pos archive-push %p'
  wal_level = replica
  ```
  Take a base backup weekly; keep at least 7 days of WAL. Test PITR to a timestamp before relying on it.
* **Encrypt** the off-server copies (e.g. `age`/`gpg`) and keep the key separate from the server.

## Restore rehearsal (do this monthly, and after every change to the backup setup)

A backup is only real once it has been restored.
```bash
./infra/restore-rehearsal.sh /var/backups/pos/pos-YYYYMMDD-HHMMSS.dump
```
It verifies the checksum, restores into a scratch database, compares row counts with the source, runs the database
integrity invariants on the restored copy (`INTEGRITY_CMD`), and drops the scratch database. It exits non-zero on any
difference. For a container database set `PSQL`, `PG_RESTORE` (see the header of the script).

Rehearsed on 2026-11-21 against a database holding 1,500 sales, 2,541 stock movements and 41 products:
checksum OK, all row counts equal, "Integrity OK: all invariants hold".

## Real restore (disaster)

1. Stop `api` and `worker`.
2. Restore the latest dump (or PITR to just before the incident) into a new database; run `npm run integrity -w apps/api` against it.
3. Point `DATABASE_URL`/`ADMIN_DATABASE_URL` at it, start `api` then `worker`.
4. Tell shops which time the data was restored to. Tills show a clear "no connection" state meanwhile (there is no offline mode by design).

## Routine checks

| What | How | Alert when |
|---|---|---|
| Database invariants | `npm run integrity -w apps/api` nightly | exit code is not 0 |
| Stock vs ledger | worker job `stock.reconcile` (nightly) | owners get an in-app notification; also `GET /v1/stock/discrepancies` |
| Job queue | `GET /v1/admin/system-health` | `deadJobs` not empty, `oldestQueuedSeconds` > 300, `outboxBacklog` growing |
| Errors/latency | `GET /v1/admin/metrics` (5xx counter, slow requests > 1 s are logged) | any 5xx burst |
| Subscriptions | worker job `subscription.lifecycle` (daily) | none: it notifies shop owners itself |
| Disk / WAL | host monitoring | > 80% |

Error tracking: set up Sentry (or any collector) by wiring it into `AllExceptionsFilter` (`apps/api/src/common/exception.filter.ts`);
the filter already logs every unexpected error with a stack and returns a generic 500 to the client.

## Capacity notes

Measured on a laptop with PostgreSQL in Docker, single Node process, development mode (`npm run load`):
40 tills billing at once: 1,000 sales with no errors, ~110-130 sales/s, p95 about 440 ms (spread across items);
40 tills fighting over one item with 500 units: exactly 500 sold, 500 refused with `STOCK_SHORT`, no invariant broken.
Scale-up path: add PgBouncer (transaction mode is safe: tenant context is transaction-local), run more `api` replicas
(the API is stateless), then a managed PostgreSQL.

## Common operations

| Task | How |
|---|---|
| Create a shop | `POST /v1/admin/shops` (Super Admin) |
| Give a shop a feature for 3 months | `PUT /v1/admin/shops/:id/features {key, enabled:true, expiresAt}` |
| Raise one shop's limit | `PUT /v1/admin/shops/:id/limits {key, value}` |
| Suspend / reactivate | `PATCH /v1/admin/shops/:id/status` |
| Invoice a shop | `POST /v1/admin/shops/:id/invoices`, then `POST /v1/admin/invoices/:id/payments` |
| Run subscription lifecycle now | `POST /v1/admin/subscriptions/run-lifecycle` |
| Customer wants all their data | the shop owner calls `GET /v1/export` (works even when read-only or cancelled) |
