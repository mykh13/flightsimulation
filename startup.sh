#!/usr/bin/env bash
#
# Wind Valley + Snow Run — local launcher.
#
# Both games are plain static files (ES modules + WebGL), so all this does
# is serve the directory over HTTP. Opening index.html with file:// will NOT
# work: ES module imports and getUserMedia both require an http(s) origin.
#
#   ./startup.sh              serve on port 5178 and open a browser
#   ./startup.sh 8080         serve on port 8080
#   PORT=8080 ./startup.sh    same thing
#   ./startup.sh --no-open    don't launch a browser
#
set -euo pipefail

PORT="${PORT:-5178}"
OPEN_BROWSER=1

usage() {
  cat <<'USAGE'
Wind Valley + Snow Run — local launcher.

Serves this directory over HTTP. Opening index.html with file:// will NOT
work: ES modules and getUserMedia both require an http(s) origin.

  ./startup.sh              serve on port 5178 and open a browser
  ./startup.sh 8080         serve on port 8080
  PORT=8080 ./startup.sh    same thing
  ./startup.sh --no-open    don't launch a browser

The games are also published to GitHub Pages, which needs no server at all.
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --no-open) OPEN_BROWSER=0 ;;
    -h|--help) usage; exit 0 ;;
    ''|*[!0-9]*) echo "Unknown argument: $arg" >&2; exit 1 ;;
    *) PORT="$arg" ;;
  esac
done

cd "$(dirname "$0")"

# ── pick an interpreter ──
if command -v python3 >/dev/null 2>&1; then
  SERVER=(python3 -m http.server "$PORT")
elif command -v python >/dev/null 2>&1; then
  SERVER=(python -m SimpleHTTPServer "$PORT")
elif command -v npx >/dev/null 2>&1; then
  SERVER=(npx --yes serve -l "$PORT" .)
else
  echo "Need python3, python or npx to serve these files." >&2
  exit 1
fi

# ── refuse to start on an occupied port rather than failing cryptically ──
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use."
  echo "Either stop what's on it, or pick another:  ./startup.sh 8080"
  exit 1
fi

URL="http://localhost:$PORT"

cat <<BANNER

  ╭───────────────────────────────────────────────╮
  │  風  Wind Valley   $URL/
  │  雪  Snow Run      $URL/snow/
  ╰───────────────────────────────────────────────╯

  Both games track your body through the webcam. Allow the camera
  prompt, or use the keyboard fallback on each start screen.

  First load pulls Three.js and the MediaPipe pose model from a CDN,
  so it needs a network connection once; after that it is cached.

  Ctrl-C to stop.

BANNER

# ── open a browser once the server is actually accepting connections ──
if [ "$OPEN_BROWSER" -eq 1 ]; then
  (
    for _ in $(seq 1 40); do
      if command -v curl >/dev/null 2>&1 && curl -fsS -o /dev/null "$URL/" 2>/dev/null; then break; fi
      sleep 0.25
    done
    if command -v open >/dev/null 2>&1; then open "$URL/"
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL/"
    fi
  ) &
fi

exec "${SERVER[@]}"
