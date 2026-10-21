#!/bin/sh
# Nightly MongoDB dump. Grades are the only thing here worth losing sleep over, and a
# free-tier instance can be reclaimed out from under you.
#
#   crontab -e
#   17 4 * * * /opt/graderoom/deploy/backup-mongo.sh
set -eu

BACKUP_DIR=${BACKUP_DIR:-/var/backups/graderoom}
KEEP_DAYS=${KEEP_DAYS:-14}
DB_URL=${DB_URL:-mongodb://127.0.0.1:27017}
STABLE_DB=${STABLE_DB:-stable}

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/graderoom-$STAMP"

mongodump --uri="$DB_URL" --db="$STABLE_DB" --out="$OUT" --gzip
tar -czf "$OUT.tar.gz" -C "$BACKUP_DIR" "$(basename "$OUT")"
rm -rf "$OUT"

find "$BACKUP_DIR" -name 'graderoom-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
echo "backed up to $OUT.tar.gz"
