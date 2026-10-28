#!/bin/sh
set -e
# A mounted volume arrives owned by root, so fix it before dropping privileges.
DATA_DIR="$(dirname "${DB_PATH:-/app/data/opencam.db}")"
mkdir -p "$DATA_DIR"
chown -R app:app "$DATA_DIR" 2>/dev/null || true
exec su-exec app "$@"
