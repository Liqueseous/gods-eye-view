#!/bin/sh
set -eu

# The image's FastCGI user needs to traverse the mounted database volume.
chmod 755 /db 2>/dev/null || true

/docker-entrypoint.sh /app/docker-entrypoint.sh &
child=$!
while kill -0 "$child" 2>/dev/null; do
  chmod 755 /db 2>/dev/null || true
  chmod 755 /db/db 2>/dev/null || true
  sleep 5
done
wait "$child"
