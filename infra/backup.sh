#!/usr/bin/env bash
# Logical backup of the POS database (custom format, compressed) + checksum + optional off-server copy + retention.
# Point-in-time recovery is separate: see docs/RUNBOOK.md (WAL archiving).
#   PGDATABASE=pos BACKUP_DIR=/var/backups/pos OFFSITE_RSYNC=backup@host:/pos ./infra/backup.sh
# Override PG_DUMP to run inside a container, e.g. PG_DUMP="docker exec -i pos-pg pg_dump -U postgres"
set -euo pipefail
: "${BACKUP_DIR:=./backups}"
: "${PGDATABASE:=pos}"
: "${RETENTION_DAYS:=14}"
PG_DUMP="${PG_DUMP:-pg_dump}"

mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/${PGDATABASE}-$(date +%Y%m%d-%H%M%S).dump"
$PG_DUMP -Fc "$PGDATABASE" > "$file"
[ -s "$file" ] || { echo "backup is empty" >&2; rm -f "$file"; exit 1; }
sha256sum "$file" > "$file.sha256"
echo "backup written: $file ($(du -h "$file" | cut -f1))"

if [ -n "${OFFSITE_RSYNC:-}" ]; then
  rsync -a "$file" "$file.sha256" "$OFFSITE_RSYNC"
  echo "copied off-server to $OFFSITE_RSYNC"
fi
find "$BACKUP_DIR" -name "${PGDATABASE}-*.dump*" -mtime "+$RETENTION_DAYS" -delete
echo "$file"
