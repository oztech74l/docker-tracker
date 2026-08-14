# Docker Tracker

Release Updates Tracker for Installed Docker in your Homelab — a self-hosted
dashboard that flags which of your containers have a new release, so you
stop tab-hopping between a dozen GitHub Releases pages.

## What it does

- **Auto-tracking**: if the Docker socket is mounted, every running
  container is picked up automatically and added to the dashboard — no tab
  to switch to, they just show up. The app tries to work out each
  container's GitHub repo from its image name (e.g. `louislam/uptime-kuma`
  → `louislam/uptime-kuma` on GitHub). When that guess can't be confirmed,
  the app is still added so you can see it, just with a "Set GitHub repo"
  button on its card instead of version info until you point it at the
  right repo.
- **Manual tracking**: "Track an app" still works exactly as before — add a
  display name and GitHub repo (`owner/repo` or a full GitHub URL) by hand,
  for anything not running as a container, or if you'd rather not mount the
  socket at all.
- Every `CHECK_INTERVAL_HOURS` (default 6h) it polls GitHub's releases API
  for every app that has a repo set, spaced a few seconds apart to stay
  under the unauthenticated rate limit (60 requests/hour).
- Every `CONTAINER_SYNC_INTERVAL_MINUTES` (default 10m) it re-scans the
  Docker socket for any newly-started containers.
- If a repo has no formal GitHub Releases, it falls back to the latest tag.
- When a new version shows up, the card lights up on the dashboard, and — if
  you've set `DISCORD_WEBHOOK_URL` — you get pinged in Discord.
- "Mark updated" clears the badge once you've actually pulled the new image.
- "Check for updates" forces an immediate GitHub check for everything at
  once; "Rescan containers" forces an immediate re-scan of the Docker socket.

Data lives in a single SQLite file at `/data/docker-tracker.db` inside the
container, mapped to `./data` on the host by the compose file, so it survives
rebuilds.

## Running it

```bash
git clone <wherever you put this> docker-tracker
cd docker-tracker
docker compose up -d --build
```

Then open `http://<your-host>:8752`. If the Docker socket is mounted, your
running containers should start appearing within a few seconds.

If you'd rather add things yourself instead of (or in addition to)
auto-tracking, `./seed-apps.sh` bulk-adds a starter list — see the script.

## Configuration

All configuration is via environment variables in `docker-compose.yml`:

| Variable | Default | Purpose |
|---|---|---|
| `CHECK_INTERVAL_HOURS` | `6` | How often to poll GitHub for all tracked apps |
| `CONTAINER_SYNC_INTERVAL_MINUTES` | `10` | How often to re-scan the Docker socket for new containers |
| `REQUEST_SPACING_SECONDS` | `3` | Delay between each app's GitHub call during a check |
| `DISCORD_WEBHOOK_URL` | *(empty)* | If set, posts a message here when a new release is detected |
| `GITHUB_TOKEN` | *(empty)* | Optional PAT (no scopes needed for public repos) — raises the rate limit from 60/hr to 5000/hr |

### About the Docker socket

`docker-compose.yml` mounts `/var/run/docker.sock` so the app can list
containers and auto-track them. It only ever calls the Docker API to *list*
containers — it never starts, stops, or modifies anything.

That said, be aware that **any process with access to the Docker socket can
in principle control the whole Docker daemon** — the `:ro` flag on the mount
only stops the socket file itself from being replaced, it doesn't restrict
what the Docker API will do once connected. If you'd rather not share the
socket, comment out that volume line in `docker-compose.yml`; everything
else (tracking, checking, notifications) works exactly the same, you'll just
add apps by hand with "Track an app" instead of them appearing automatically.

### Getting a Discord webhook URL

Server Settings → Integrations → Webhooks → New Webhook → copy the URL, paste
it into `DISCORD_WEBHOOK_URL` in `docker-compose.yml`, then
`docker compose up -d` to apply.

### Getting a GitHub token (optional)

Only needed if you end up tracking enough apps that 60 checks/hour becomes
tight. GitHub → Settings → Developer settings → Personal access tokens →
generate a classic token with no scopes selected (public repo read access
doesn't need any). Paste it into `GITHUB_TOKEN`.

## API

The frontend talks to a small REST API if you ever want to script against it:

- `GET /api/apps` — list all tracked apps (auto-detected apps with no repo
  yet appear too, sorted to the top)
- `POST /api/apps` — `{ name, repo, image?, current_version? }`
- `PATCH /api/apps/{id}` — edit name/repo/image/current_version (setting a
  repo on an auto-detected app triggers an immediate check)
- `DELETE /api/apps/{id}`
- `POST /api/apps/{id}/check` — check one app immediately
- `POST /api/apps/{id}/ack` — clear the update badge (baseline = latest)
- `POST /api/check-all` — check every app immediately
- `POST /api/sync-containers` — re-scan the Docker socket right now
- `GET /api/stats` — counts for the header

## Notes / limitations

- Version comparison is a straight string match against the GitHub tag, not
  semver-aware — this mirrors what the tag itself says, which is usually all
  you need to know "did this repo cut a new release."
- The image-to-repo guess is a heuristic (it checks that `owner/repo` parsed
  out of the image actually exists on GitHub before accepting it) — it works
  well for projects that publish images under their own GitHub org/repo name,
  but plenty of images won't match (official images like `nginx`, images
  repackaged by linuxserver.io, etc). Those just need the repo set by hand
  once, from the card.
