#!/usr/bin/env bash
# Seeds Release Radar with your current app list.
# Usage: ./seed-apps.sh [http://host:port]   (defaults to http://localhost:8752)

BASE_URL="${1:-http://localhost:8752}"

add() {
  local name="$1"
  local repo="$2"
  echo "Adding: $name ($repo)"
  curl -s -o /dev/null -w "  -> %{http_code}\n" \
    -X POST "$BASE_URL/api/apps" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$name\", \"repo\": \"$repo\"}"
}

# name                       github repo
add "Wiki|Docs"              "Zavy86/WikiDocs"
add "Web-Check"              "Lissy93/web-check"
add "Wallos"                 "ellite/Wallos"
add "Uptime Kuma"            "louislam/uptime-kuma"
add "Umami"                  "umami-software/umami"
add "Speedtest Tracker"      "alexjustesen/speedtest-tracker"
add "Networking Toolbox"     "Lissy93/networking-toolbox"
add "MeTube"                 "alexta69/metube"
add "Linkwarden"             "linkwarden/linkwarden"
add "Linkding"               "sissbruecker/linkding"
add "IT Tools"               "CorentinTh/it-tools"
add "Glance"                 "glanceapp/glance"
add "Excalidraw"             "excalidraw/excalidraw"
add "Docmost"                "docmost/docmost"
add "Blinko"                 "blinko-space/blinko"
add "Beszel"                 "henrygd/beszel"
add "Nginx Proxy Manager"    "NginxProxyManager/nginx-proxy-manager"
add "Audiobookshelf"         "advplyr/audiobookshelf"
add "File Browser"           "filebrowser/filebrowser"
add "Erugo"                  "ErugoOSS/Erugo"
add "Peppermint"             "Peppermint-Lab/peppermint"
add "Homebridge"             "homebridge/homebridge"
add "AdGuardian"              "Lissy93/AdGuardian-Term"
add "AdGuardHome-Sync"        "bakito/adguardhome-sync"
add "Foldergram"              "foldergram/foldergram"

echo "Done. Open $BASE_URL to see them (each add triggers an immediate GitHub check)."
