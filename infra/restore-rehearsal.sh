#!/usr/bin/env bash
# A backup is only real once it has been restored. This restores a dump into a scratch database, checks the
# row counts against the source, runs the application's integrity invariants on the restored copy, then drops it.
#   ./infra/restore-rehearsal.sh backups/pos-20261121-120000.dump
# Overrides for containers: PSQL, PG_RESTORE, CREATEDB_CMD (see docs/RUNBOOK.md)
set -euo pipefail
dump="${1:?usage: restore-rehearsal.sh <dump file>}"
: "${PGDATABASE:=pos}"
scratch="${PGDATABASE}_rehearsal"
PSQL="${PSQL:-psql}"
PG_RESTORE="${PG_RESTORE:-pg_restore}"
sha="$dump.sha256"
[ -f "$sha" ] && sha256sum -c "$sha" >/dev/null && echo "checksum OK"

$PSQL -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $scratch" -c "CREATE DATABASE $scratch" >/dev/null
$PG_RESTORE -d "$scratch" --no-owner < "$dump"

count() { $PSQL -d "$1" -At -c "SELECT count(*) FROM $2"; }
status=0
for t in shop users product stock_movement sale sale_line payment customer credit_entry supplier_ledger; do
  a=$(count "$PGDATABASE" "$t"); b=$(count "$scratch" "$t")
  if [ "$a" = "$b" ]; then echo "  $t: $b rows"; else echo "  MISMATCH $t: source=$a restored=$b" >&2; status=1; fi
done
if [ -n "${INTEGRITY_CMD:-}" ]; then eval "$INTEGRITY_CMD" || status=1; fi
$PSQL -d postgres -c "DROP DATABASE $scratch" >/dev/null
[ $status -eq 0 ] && echo "RESTORE REHEARSAL PASSED" || { echo "RESTORE REHEARSAL FAILED" >&2; exit 1; }
