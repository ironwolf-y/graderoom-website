#!/bin/sh
# Nightly MongoDB dump. Grades are the only thing here worth losing sleep over, and a
# free-tier instance can be reclaimed out from under you.
#
#   crontab -e
#   17 4 * * * /opt/graderoom/deploy/backup-mongo.sh
#
# It reads the same /etc/graderoom.env the server reads, so the backup always points
# at the database the server is using. The archives hold real grades, so they are
# only readable by the owner.
set -eu

umask 077

ENV_FILE=${ENV_FILE:-/etc/graderoom.env}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/graderoom}
KEEP_DAYS=${KEEP_DAYS:-14}
STABLE_DB=${STABLE_DB:-stable}

# The server's own configuration, so DB_URL matches the running instance
if [ -r "$ENV_FILE" ]; then
    DB_URL=$(sed -n 's/^DB_URL=//p' "$ENV_FILE" | head -n 1)
fi
DB_URL=${DB_URL:-mongodb://127.0.0.1:27017}

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/graderoom-$STAMP"

mongodump --uri="$DB_URL" --db="$STABLE_DB" --out="$OUT" --gzip
tar -czf "$OUT.tar.gz" -C "$BACKUP_DIR" "$(basename "$OUT")"
rm -rf "$OUT"

# A dump that produced nothing is not a backup
SIZE=$(wc -c < "$OUT.tar.gz")
if [ "$SIZE" -lt 1024 ]; then
    echo "the dump is only $SIZE bytes, treating it as a failure" >&2
    exit 1
fi
chmod 600 "$OUT.tar.gz"

find "$BACKUP_DIR" -name 'graderoom-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
echo "backed up to $OUT.tar.gz"
