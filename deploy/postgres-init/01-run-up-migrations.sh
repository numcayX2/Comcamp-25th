#!/bin/sh
set -eu

echo "[cc25-init] Starting ordered UP migrations from /migrations..."

if [ ! -d "/migrations" ]; then
    echo "[cc25-init] ERROR: /migrations directory does not exist." >&2
    exit 1
fi

UP_FILES=$(find /migrations -maxdepth 1 -type f -name '[0-9]*_*.up.sql' | sort)

if [ -z "$UP_FILES" ]; then
    echo "[cc25-init] ERROR: No *.up.sql files found in /migrations." >&2
    exit 1
fi

for sql_file in $UP_FILES; do
    echo "[cc25-init] Applying migration: $(basename "$sql_file")"
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$sql_file"
done

echo "[cc25-init] Verifying settings row (id = 1)..."
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c \
    "SELECT id, camp_name, registration_open_at AT TIME ZONE 'Asia/Bangkok' AS open_at_bkk FROM settings WHERE id = 1;"

echo "[cc25-init] All UP migrations completed successfully."
