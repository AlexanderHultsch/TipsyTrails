#!/bin/sh
# Container entrypoint (SPEC.md Section 4.3). The Pi platform's compose creates
# the bind mount ~/pi-server/data/tipsy-trails as root, so a container running
# as `node` cannot so much as mkdir /data/db - startup.ts's mkdirSync fails
# with EACCES, the process exits 1, and the container restart-loops behind a
# 502. This runs as root, creates the directories the app needs, hands the
# whole volume to `node`, and only then drops privileges for the server itself.
# The platform's other sites solve the same problem the same way with su-exec
# on Alpine; this image is Debian (node:22-bookworm-slim), so it is gosu here.
set -e

# Mirrors packages/api/src/env.ts: DATABASE_PATH wins over DB_PATH and has no
# default - if neither is set, create nothing and let the app fail with its own
# clear error - while TILES_DIR defaults to /data/tiles.
db_path="${DATABASE_PATH:-${DB_PATH:-}}"
if [ -n "$db_path" ]; then
  mkdir -p "$(dirname "$db_path")"
fi
mkdir -p "${TILES_DIR:-/data/tiles}"

# Everything already in the volume - a .pmtiles extract copied in by hand as
# another user included - has to be readable and writable by the runtime user.
# Tolerate failure rather than aborting the boot: the app should still get its
# chance to start and produce its own error.
chown -R node:node /data || true

exec gosu node "$@"
