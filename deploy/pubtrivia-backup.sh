#!/bin/bash
# Dumps the game database. Run by pubtrivia-backup.timer every 5 minutes, so a
# crash mid-game costs at most a few grades. Keeps a week of dumps.
#
# To restore one:
#   sudo systemctl stop pubtrivia-dev
#   pg_restore -h 127.0.0.1 -U pubtrivia -d pubtrivia_dev --clean --if-exists <file>
#   sudo systemctl start pubtrivia-dev
set -euo pipefail

dir="$HOME/backups-pubtrivia"
mkdir -p "$dir"
target="$dir/${PGDATABASE}-$(date +%F-%H%M).dump"

# Written to the side first, so a failed dump never looks like a good one.
pg_dump -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -Fc -f "$target.tmp"
mv "$target.tmp" "$target"

find "$dir" -name '*.dump' -mtime +7 -delete
