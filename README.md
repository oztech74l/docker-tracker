# Docker Tracker

Release Updates Tracker for Installed Docker in your Homelab — a self-hosted
dashboard that flags which of your containers have a new release, and can
update them for you with one click.

## What it does

- **Auto-tracking**: if the Docker socket is mounted, every running
  container is picked up automatically and added to the dashboard. The app
  tries to work out each container's GitHub repo from its image name (e.g.
  `louislam/uptime-kuma` → `louislam/uptime-kuma` on GitHub). When that
  guess can't be confirmed, the app still shows up with a "Set GitHub repo"
  button instead of version info, until you point it at the right repo.
- **Manual tracking**: "Track an app" still works for anything not running
  as a container, or if you'd rather not mount the socket at all.
- **One-click updates**: when a tracked app has a linked container and a new
  release, its card gets a highlighted **Update** button. Clicking it pulls
  the new image and recreates the container in place, keeping its existing
  config (env vars, volumes, ports, restart policy, networks). You can also
  tick the checkbox on any number of update-ready cards and hit **Update
  selected** in the bar that appears, to do several at once. See
  [Automatic updates: how it works](#automatic-updates-how-it-works) below
  before relying on this.
- **Dark / Light / System theme**, top right — remembered per browser.
- Every `CHECK_INTERVAL_HOURS` (default 6h) it polls GitHub's releases API
  for every app that has a repo set. Every `CONTAINER_SYNC_INTERVAL_MINUTES`
  (default 10m) it re-scans the Docker socket for newly-started containers.
- If a repo has no formal GitHub Releases, it falls back to the latest tag.
- When a new version shows up, the card lights up, and — if you've set
  `DISCORD_WEBHOOK_URL` — you get pinged in Discord.
- "Mark updated" clears the badge without touching the container, for apps
  you've updated yourself or that aren't linked to a running container.
- "Check for updates" forces an immediate GitHub check for everything;
  "Rescan containers" forces an immediate re-scan of the Docker socket.

Data lives in a single SQLite file at `/data/docker-tracker.db`, mapped to
`./data` on the host, so it survives rebuilds.

## Automatic updates: how it works

Clicking Update (single or bulk) does the following, per container:

1. Works out which image tag to pull — if the container was created from a
   mutable tag (`latest`, `main`, `stable`, etc.) it re-pulls that same tag;
   otherwise it tries the new GitHub release version as a tag (with and
   without a `v` prefix), falling back to the container's current tag if
   none of those exist.
2. **Builds the replacement container first**, under a temporary name,
   using the old container's exact config (env, volumes, ports, restart
   policy, networks) — the running container is not touched yet.
3. Only once that succeeds does it stop and remove the old container,
   rename the new one into its place, and start it.

If step 1 or 2 fails, the original container is left completely untouched
and the card shows the error. If something goes wrong during step 3 (rare,
but possible — e.g. the daemon drops the connection mid-swap), the app will
tell you to check `docker ps -a` on the host, since that's the one window
where manual cleanup might be needed.

**This is real infrastructure automation, not a simulation** — treat it the
way you'd treat Watchtower or any other tool that recreates containers for
you. It works well for straightforward single-container apps. It's more
likely to trip up on: containers with complex multi-container dependencies
(databases that need a coordinated restart, etc.), containers not actually
managed by Docker Compose drift-checking (recreating outside of Compose can
cause your next `docker compose up -d` to "correct" things back), or images
whose release-tag naming doesn't match their Docker tag naming at all. If
you're not sure, use "Check for updates" to just get notified, and update
those ones by hand.

## Running it

**Using the pre-built image (no local build needed):**

```bash
git clone <your-repo-url> docker-tracker
cd docker-tracker
# edit docker-compose.yml: set image: ghcr.io/<you>/<repo>:latest,
# and any environment variables you want (Discord webhook, etc.)
docker compose up -d
```

The included `.github/workflows/docker-publish.yml` builds and pushes the
image to GHCR automatically on every push to `main` (and on version tags),
so once you push this repo to GitHub, `ghcr.io/<your-username>/<your-repo>:latest`
will exist and `docker compose up -d` will just pull it. If your GitHub repo
is private, the resulting package is private too by default — you'll need
`docker login ghcr.io` on the host once, or make the package public from its
GitHub Package settings.

**Building locally instead** (e.g. you're actively editing the code):

```bash
# in docker-compose.yml: comment out `image:`, uncomment `build: .`
docker compose up -d --build
```

Then open `http://<your-host>:8752`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CHECK_INTERVAL_HOURS` | `6` | How often to poll GitHub for all tracked apps |
| `CONTAINER_SYNC_INTERVAL_MINUTES` | `10` | How often to re-scan the Docker socket for new containers |
| `REQUEST_SPACING_SECONDS` | `3` | Delay between each app's GitHub call during a check |
| `DISCORD_WEBHOOK_URL` | *(empty)* | If set, posts a message here when a new release is detected |
| `GITHUB_TOKEN` | *(empty)* | Optional PAT (no scopes needed for public repos) — raises the rate limit from 60/hr to 5000/hr |

### About the Docker socket

`docker-compose.yml` mounts `/var/run/docker.sock` **read-write**. This is a
bigger permission grant than earlier versions of this app, because one-click
updates need to pull images and stop/remove/recreate containers, not just
list them. Be aware that **any process with socket access can, in
principle, control the whole Docker daemon** — there's no way to scope it
down to "just Docker Tracker's own containers."

If you'd rather not grant that: comment out the socket volume line
entirely. Everything else (manual tracking, checking, notifications) keeps
working exactly the same — you'll just add apps by hand with "Track an app"
and update them yourself, same as before this feature existed.

### Getting a Discord webhook URL

Server Settings → Integrations → Webhooks → New Webhook → copy the URL, paste
it into `DISCORD_WEBHOOK_URL`, then `docker compose up -d` to apply.

### Getting a GitHub token (optional)

Only needed if you track enough apps that 60 checks/hour gets tight. GitHub
→ Settings → Developer settings → Personal access tokens → generate a
classic token with no scopes selected. Paste it into `GITHUB_TOKEN`.

## API

- `GET /api/apps` — list all tracked apps
- `POST /api/apps` — `{ name, repo, image?, current_version? }`
- `PATCH /api/apps/{id}` — edit name/repo/image/current_version
- `DELETE /api/apps/{id}`
- `POST /api/apps/{id}/check` — check one app immediately
- `POST /api/apps/{id}/ack` — clear the update badge without touching the container
- `POST /api/apps/{id}/update` — pull + recreate that app's container now
- `POST /api/apps/bulk-update` — `{ ids: [1, 2, 3] }`, updates each in turn
- `POST /api/check-all` — check every app immediately
- `POST /api/sync-containers` — re-scan the Docker socket right now
- `GET /api/stats` — counts for the header

## Notes / limitations

- Version comparison is a straight string match against the GitHub tag, not
  semver-aware.
- The image-to-repo guess is a heuristic — works well for projects that
  publish images under their own GitHub org/repo name, less well for
  official images or third-party repackages (linuxserver.io, etc.). Those
  just need the repo set by hand once, from the card.
- The Update button only appears for apps linked to a real running
  container. Manually-tracked apps always use "Mark updated" instead.
