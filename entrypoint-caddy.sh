#!/bin/sh
cat <<EOF > /usr/share/caddy/web/runtime-config.local.js
window.NNAPER_CONFIG = Object.assign(window.NNAPER_CONFIG || {}, {
  API_BASE_URL: '${API_PUBLIC_URL:-http://localhost:8000}',
  TILES_BASE_URL: '${TILES_PUBLIC_URL:-http://localhost:8080}',
  OSRM_URL: '${OSRM_PUBLIC_URL:-http://localhost:5000}',
  PHOTON_URL: '${PHOTON_URL:-http://localhost:8000/api/geocode}',
  PHOTON_BBOX: '${PHOTON_BBOX:-14.1,53.9,19.9,55.9}',
  PHOTON_SEARCH_LIMIT: ${PHOTON_SEARCH_LIMIT:-50},
  PMTILES_FILE: '${PMTILES_FILE:-pomorskie.pmtiles}'
});
EOF

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile

