#!/bin/sh
# Switches the container between the built preview server (default, fast,
# no Provider Settings wizard) and the Vite dev server (slower, but exposes
# the browser key-setup wizard at /api/setup/*). Set GEV_RUN_MODE=dev to
# switch; the image is built either way so switching never needs a rebuild.
set -e

if [ "$GEV_RUN_MODE" = "dev" ]; then
  exec npm run dev -- --host "${HOST:-0.0.0.0}" --port "${PORT:-4173}"
fi

exec npm run preview
