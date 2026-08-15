import os
import re
import sqlite3
import asyncio
import logging
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from typing import Optional

import httpx
import docker as docker_sdk
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("docker-tracker")

DB_PATH = os.environ.get("DB_PATH", "/data/docker-tracker.db")
CHECK_INTERVAL_HOURS = float(os.environ.get("CHECK_INTERVAL_HOURS", "6"))
CONTAINER_SYNC_INTERVAL_MINUTES = float(os.environ.get("CONTAINER_SYNC_INTERVAL_MINUTES", "10"))
DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "").strip()
REQUEST_SPACING_SECONDS = float(os.environ.get("REQUEST_SPACING_SECONDS", "3"))

REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")

# registry hostnames to strip off the front of an image reference when
# guessing a GitHub repo from it (anything with a dot or a port is assumed
# to be a registry host, this list just covers the common explicit ones)
KNOWN_REGISTRIES = {"docker.io", "ghcr.io", "lscr.io", "quay.io", "registry-1.docker.io", "gcr.io"}


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS apps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            repo TEXT,
            image TEXT,
            container_name TEXT,
            source TEXT DEFAULT 'manual',
            current_version TEXT,
            latest_version TEXT,
            latest_url TEXT,
            latest_published_at TEXT,
            last_checked TEXT,
            update_available INTEGER DEFAULT 0,
            last_error TEXT,
            last_updated TEXT,
            created_at TEXT NOT NULL
        )
        """
    )
    # repo is unique only when set, so multiple auto-detected apps can sit
    # without a repo at once while they wait to be matched up
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_repo ON apps(repo) WHERE repo IS NOT NULL"
    )
    conn.commit()
    conn.close()


def titleize(name: str) -> str:
    words = re.split(r"[-_]+", name.strip())
    return " ".join(w[:1].upper() + w[1:] for w in words if w)


def guess_repo_from_image(image: str) -> Optional[str]:
    """Best-effort guess of an 'owner/repo' GitHub slug from a Docker image
    reference. Returns None when there isn't enough to go on (e.g. official
    single-word images like 'nginx' or 'redis')."""
    if not image:
        return None
    ref = image.split("@")[0]  # drop digest
    # drop a trailing :tag, but not if it's actually a registry port
    last_colon = ref.rfind(":")
    last_slash = ref.rfind("/")
    if last_colon > last_slash:
        ref = ref[:last_colon]

    parts = [p for p in ref.split("/") if p]
    if parts and ("." in parts[0] or ":" in parts[0]) and parts[0] not in ("localhost",):
        parts = parts[1:]  # drop registry host
    elif parts and parts[0] in KNOWN_REGISTRIES:
        parts = parts[1:]

    if len(parts) < 2:
        return None
    owner, repo = parts[-2], parts[-1]
    if not REPO_RE.match(f"{owner}/{repo}"):
        return None
    return f"{owner}/{repo}"


# ---------- models ----------

class AppCreate(BaseModel):
    name: str
    repo: str
    image: Optional[str] = None
    current_version: Optional[str] = None

    @field_validator("repo")
    @classmethod
    def validate_repo(cls, v):
        v = v.strip()
        if v.startswith("https://github.com/"):
            v = v[len("https://github.com/"):]
        v = v.strip("/")
        if not REPO_RE.match(v):
            raise ValueError("repo must look like 'owner/repo'")
        return v


class AppEdit(BaseModel):
    name: Optional[str] = None
    repo: Optional[str] = None
    image: Optional[str] = None
    current_version: Optional[str] = None

    @field_validator("repo")
    @classmethod
    def validate_repo(cls, v):
        if v is None:
            return v
        v = v.strip()
        if v.startswith("https://github.com/"):
            v = v[len("https://github.com/"):]
        v = v.strip("/")
        if not REPO_RE.match(v):
            raise ValueError("repo must look like 'owner/repo'")
        return v


# ---------- github ----------

async def repo_exists(client: httpx.AsyncClient, repo: str) -> bool:
    headers = {"Accept": "application/vnd.github+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    try:
        r = await client.get(f"https://api.github.com/repos/{repo}", headers=headers, timeout=10)
        return r.status_code == 200
    except Exception:
        return False


async def fetch_latest_release(client: httpx.AsyncClient, repo: str) -> dict:
    """Returns dict with version, url, published_at. Raises on failure."""
    headers = {"Accept": "application/vnd.github+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"

    r = await client.get(f"https://api.github.com/repos/{repo}/releases/latest", headers=headers)
    if r.status_code == 200:
        data = r.json()
        return {
            "version": data.get("tag_name") or data.get("name"),
            "url": data.get("html_url"),
            "published_at": data.get("published_at"),
        }
    if r.status_code == 404:
        # no formal releases, fall back to tags
        r2 = await client.get(f"https://api.github.com/repos/{repo}/tags", headers=headers)
        if r2.status_code == 200:
            tags = r2.json()
            if tags:
                tag = tags[0]
                return {
                    "version": tag.get("name"),
                    "url": f"https://github.com/{repo}/releases/tag/{tag.get('name')}",
                    "published_at": None,
                }
        raise RuntimeError("no releases or tags found")
    if r.status_code == 403:
        raise RuntimeError("GitHub API rate limit exceeded")
    if r.status_code == 401:
        raise RuntimeError("GitHub token invalid")
    raise RuntimeError(f"GitHub API error {r.status_code}")


async def notify_discord(client: httpx.AsyncClient, app_row: sqlite3.Row, new_version: str):
    if not DISCORD_WEBHOOK_URL:
        return
    content = (
        f"**{app_row['name']}** has a new release: `{new_version}`\n"
        f"Previously tracked: `{app_row['current_version'] or 'none'}`\n"
        f"{app_row['latest_url'] or ''}"
    )
    try:
        await client.post(DISCORD_WEBHOOK_URL, json={"content": content}, timeout=10)
    except Exception as e:
        log.warning(f"Discord notify failed for {app_row['name']}: {e}")


async def check_one_app(client: httpx.AsyncClient, app_id: int):
    conn = get_db()
    row = conn.execute("SELECT * FROM apps WHERE id = ?", (app_id,)).fetchone()
    if not row:
        conn.close()
        return
    if not row["repo"]:
        # auto-detected app still waiting on a GitHub repo — nothing to check yet
        conn.close()
        return
    now = datetime.now(timezone.utc).isoformat()
    try:
        result = await fetch_latest_release(client, row["repo"])
        new_version = result["version"]
        was_baseline = row["current_version"] is None
        update_available = bool(row["current_version"]) and new_version != row["current_version"]

        # notify only when latest_version actually changes from what we last saw
        # (avoids re-notifying every poll once flagged)
        should_notify = (
            not was_baseline
            and new_version != row["latest_version"]
            and new_version != row["current_version"]
        )

        conn.execute(
            """
            UPDATE apps SET
                latest_version = ?, latest_url = ?, latest_published_at = ?,
                last_checked = ?, update_available = ?, last_error = NULL,
                current_version = COALESCE(current_version, ?)
            WHERE id = ?
            """,
            (
                new_version,
                result["url"],
                result["published_at"],
                now,
                1 if update_available else 0,
                new_version,  # only used if current_version was NULL (baseline)
                app_id,
            ),
        )
        conn.commit()

        if should_notify:
            await notify_discord(client, row, new_version)
            log.info(f"Update found for {row['name']}: {new_version}")
    except Exception as e:
        conn.execute(
            "UPDATE apps SET last_checked = ?, last_error = ? WHERE id = ?",
            (now, str(e), app_id),
        )
        conn.commit()
        log.warning(f"Check failed for {row['name']} ({row['repo']}): {e}")
    finally:
        conn.close()


async def check_all_apps():
    conn = get_db()
    ids = [r["id"] for r in conn.execute("SELECT id FROM apps").fetchall()]
    conn.close()
    async with httpx.AsyncClient() as client:
        for app_id in ids:
            await check_one_app(client, app_id)
            await asyncio.sleep(REQUEST_SPACING_SECONDS)


async def poll_loop():
    # small initial delay so the app finishes booting first
    await asyncio.sleep(5)
    while True:
        try:
            log.info("Running scheduled check of all apps")
            await check_all_apps()
        except Exception as e:
            log.error(f"poll_loop error: {e}")
        await asyncio.sleep(CHECK_INTERVAL_HOURS * 3600)


# ---------- auto-tracking running containers ----------

def _list_running_containers():
    """Returns (available, containers[]). Never raises."""
    try:
        client = docker_sdk.from_env()
        containers = client.containers.list()
        result = []
        for c in containers:
            tags = c.image.tags
            image = tags[0] if tags else c.image.short_id
            result.append({"name": c.name, "image": image})
        client.close()
        return True, result
    except Exception as e:
        log.info(f"Docker socket not available for auto-tracking: {e}")
        return False, []


async def sync_containers() -> int:
    """Adds any running container that isn't already tracked as a new app.
    Tries to resolve a GitHub repo from the image name; if it can't, the app
    is still added (so it shows up in the dashboard) with no repo set, and
    the person can fill that in from the card. Returns count newly added."""
    available, containers = _list_running_containers()
    if not available or not containers:
        return 0

    conn = get_db()
    existing = conn.execute("SELECT container_name, image FROM apps").fetchall()
    conn.close()
    known_names = {r["container_name"] for r in existing if r["container_name"]}
    known_images = {r["image"] for r in existing if r["image"]}

    added = 0
    async with httpx.AsyncClient() as client:
        for c in containers:
            if c["name"] in known_names or c["image"] in known_images:
                continue

            guess = guess_repo_from_image(c["image"])
            repo_value = None
            if guess and await repo_exists(client, guess):
                repo_value = guess

            now = datetime.now(timezone.utc).isoformat()
            conn = get_db()
            try:
                cur = conn.execute(
                    """
                    INSERT INTO apps (name, repo, image, container_name, source, created_at)
                    VALUES (?, ?, ?, ?, 'container', ?)
                    """,
                    (titleize(c["name"]), repo_value, c["image"], c["name"], now),
                )
                app_id = cur.lastrowid
                conn.commit()
            except sqlite3.IntegrityError:
                # repo already tracked under a different entry — skip
                conn.close()
                continue
            conn.close()

            added += 1
            log.info(
                f"Auto-tracked container '{c['name']}' ({c['image']}) "
                f"-> repo={repo_value or 'unresolved, needs manual repo'}"
            )
            if repo_value:
                await check_one_app(client, app_id)
                await asyncio.sleep(REQUEST_SPACING_SECONDS)

    return added


async def container_sync_loop():
    await asyncio.sleep(8)  # let the app finish booting first
    while True:
        try:
            added = await sync_containers()
            if added:
                log.info(f"Container sync added {added} new app(s)")
        except Exception as e:
            log.error(f"container_sync_loop error: {e}")
        await asyncio.sleep(CONTAINER_SYNC_INTERVAL_MINUTES * 60)


# ---------- fully-automatic container updates ----------
#
# This is the riskiest part of the app: it pulls a new image and then stops,
# removes, and recreates the container in place using its existing config
# (env vars, volumes, ports, restart policy, networks). The sequence below
# is ordered to fail safe where it can — the new container is built and
# confirmed *before* the old one is touched — but recreating a running
# container is inherently not zero-risk. See the README before relying on
# this for anything you can't afford to lose.

MUTABLE_TAGS = {"latest", "stable", "main", "master", "edge", "release", "rolling"}


def _guess_update_target(image_ref: str, latest_version: Optional[str]):
    """Given the image reference a container was created from (e.g.
    'louislam/uptime-kuma:latest') and the latest GitHub release tag, work
    out which image:tag candidates are worth trying to pull. Returns
    (repo_ref, [candidate_tags_in_order])."""
    ref = image_ref.split("@")[0]
    last_colon = ref.rfind(":")
    last_slash = ref.rfind("/")
    if last_colon > last_slash:
        repo_ref, current_tag = ref[:last_colon], ref[last_colon + 1:]
    else:
        repo_ref, current_tag = ref, "latest"

    if current_tag in MUTABLE_TAGS or not latest_version:
        # mutable tag: "updating" means re-pulling the same tag to pick up
        # whatever digest it currently points at
        return repo_ref, [current_tag]

    stripped = latest_version.lstrip("vV")
    candidates = []
    for c in (latest_version, stripped, f"v{stripped}"):
        if c not in candidates:
            candidates.append(c)
    if current_tag not in candidates:
        candidates.append(current_tag)  # last resort
    return repo_ref, candidates


def _update_container_sync(app_id: int) -> dict:
    """Blocking implementation — call via asyncio.to_thread so it doesn't
    stall the event loop while pulling/recreating."""
    conn = get_db()
    row = conn.execute("SELECT * FROM apps WHERE id = ?", (app_id,)).fetchone()
    conn.close()
    if not row:
        return {"ok": False, "error": "App not found"}
    if not row["container_name"]:
        return {
            "ok": False,
            "error": (
                "This app isn't linked to a running container (it was added manually), "
                "so it can't be auto-updated. Update it yourself, then use 'Mark updated'."
            ),
        }

    try:
        client = docker_sdk.from_env()
        container = client.containers.get(row["container_name"])
    except Exception as e:
        return {"ok": False, "error": f"Container '{row['container_name']}' not found on this host: {e}"}

    attrs = container.attrs
    image_ref = attrs["Config"]["Image"]
    repo_ref, candidates = _guess_update_target(image_ref, row["latest_version"])

    pulled_tag, pull_error = None, None
    for tag in candidates:
        try:
            client.images.pull(repo_ref, tag=tag)
            pulled_tag = tag
            break
        except Exception as e:
            pull_error = str(e)

    if not pulled_tag:
        client.close()
        return {
            "ok": False,
            "error": f"Couldn't pull an image for {repo_ref} (tried {candidates}): {pull_error}",
        }

    new_image_ref = f"{repo_ref}:{pulled_tag}"
    old_name = container.name
    temp_name = f"{old_name}_dockertracker_new"
    config = attrs["Config"]
    host_config = attrs["HostConfig"]
    networks = (attrs.get("NetworkSettings") or {}).get("Networks") or {}
    api = client.api

    # Stage 1: build the replacement without touching the running container.
    try:
        # clear out a stale temp container from a previous failed attempt, if any
        try:
            api.remove_container(temp_name, force=True)
        except Exception:
            pass
        new_container = api.create_container(
            image=new_image_ref,
            name=temp_name,
            command=config.get("Cmd"),
            entrypoint=config.get("Entrypoint"),
            environment=config.get("Env"),
            labels=config.get("Labels"),
            working_dir=config.get("WorkingDir") or None,
            user=config.get("User") or None,
            host_config=host_config,
            ports=[p.split("/")[0] for p in (config.get("ExposedPorts") or {}).keys()],
        )
    except Exception as e:
        client.close()
        return {
            "ok": False,
            "error": f"Pulled {new_image_ref} but failed to build the replacement container: {e}. "
                     f"The running container was left untouched.",
        }

    new_id = new_container["Id"]

    # Stage 2: swap it in.
    try:
        for net_name, net_conf in networks.items():
            try:
                network = client.networks.get(net_name)
                network.connect(new_id, aliases=(net_conf.get("Aliases") or None))
            except Exception:
                pass  # the primary network from host_config usually covers it anyway

        container.stop(timeout=15)
        container.remove()
        api.rename(new_id, old_name)
        api.start(new_id)
    except Exception as e:
        client.close()
        return {
            "ok": False,
            "error": f"Pulled {new_image_ref} and built the replacement, but hit an error while "
                     f"swapping it in: {e}. Check `docker ps -a` on the host — you may need to "
                     f"finish this by hand (the new container may be sitting as '{temp_name}').",
        }

    client.close()

    now = datetime.now(timezone.utc).isoformat()
    conn = get_db()
    conn.execute(
        """UPDATE apps SET current_version = latest_version, update_available = 0,
                            last_error = NULL, last_updated = ? WHERE id = ?""",
        (now, app_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "image": new_image_ref}


async def update_container(app_id: int) -> dict:
    return await asyncio.to_thread(_update_container_sync, app_id)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    poll_task = asyncio.create_task(poll_loop())
    sync_task = asyncio.create_task(container_sync_loop())
    yield
    poll_task.cancel()
    sync_task.cancel()


app = FastAPI(title="Docker Tracker", lifespan=lifespan)


def row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["update_available"] = bool(d["update_available"])
    return d


@app.get("/api/apps")
def list_apps():
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM apps ORDER BY update_available DESC, (repo IS NULL) DESC, name COLLATE NOCASE ASC"
    ).fetchall()
    conn.close()
    return [row_to_dict(r) for r in rows]


@app.get("/api/stats")
def stats():
    conn = get_db()
    total = conn.execute("SELECT COUNT(*) c FROM apps").fetchone()["c"]
    updates = conn.execute("SELECT COUNT(*) c FROM apps WHERE update_available = 1").fetchone()["c"]
    errors = conn.execute("SELECT COUNT(*) c FROM apps WHERE last_error IS NOT NULL").fetchone()["c"]
    needs_repo = conn.execute("SELECT COUNT(*) c FROM apps WHERE repo IS NULL").fetchone()["c"]
    conn.close()
    return {
        "total": total,
        "updates_available": updates,
        "errors": errors,
        "needs_repo": needs_repo,
        "check_interval_hours": CHECK_INTERVAL_HOURS,
    }


@app.post("/api/apps")
async def add_app(payload: AppCreate):
    conn = get_db()
    existing = conn.execute("SELECT id FROM apps WHERE repo = ?", (payload.repo,)).fetchone()
    if existing:
        conn.close()
        raise HTTPException(status_code=409, detail="That repo is already tracked")
    now = datetime.now(timezone.utc).isoformat()
    cur = conn.execute(
        """
        INSERT INTO apps (name, repo, image, source, current_version, created_at)
        VALUES (?, ?, ?, 'manual', ?, ?)
        """,
        (payload.name, payload.repo, payload.image, payload.current_version, now),
    )
    app_id = cur.lastrowid
    conn.commit()
    conn.close()

    async with httpx.AsyncClient() as client:
        await check_one_app(client, app_id)

    conn = get_db()
    row = conn.execute("SELECT * FROM apps WHERE id = ?", (app_id,)).fetchone()
    conn.close()
    return row_to_dict(row)


@app.patch("/api/apps/{app_id}")
async def edit_app(app_id: int, payload: AppEdit):
    conn = get_db()
    row = conn.execute("SELECT * FROM apps WHERE id = ?", (app_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="App not found")

    fields = payload.model_dump(exclude_unset=True)
    newly_set_repo = bool(fields.get("repo")) and not row["repo"]

    if fields.get("repo"):
        dup = conn.execute(
            "SELECT id FROM apps WHERE repo = ? AND id != ?", (fields["repo"], app_id)
        ).fetchone()
        if dup:
            conn.close()
            raise HTTPException(status_code=409, detail="That repo is already tracked")

    if fields:
        sets = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(f"UPDATE apps SET {sets} WHERE id = ?", (*fields.values(), app_id))
        conn.commit()
    conn.close()

    if newly_set_repo:
        async with httpx.AsyncClient() as client:
            await check_one_app(client, app_id)

    conn = get_db()
    row = conn.execute("SELECT * FROM apps WHERE id = ?", (app_id,)).fetchone()
    conn.close()
    return row_to_dict(row)


@app.delete("/api/apps/{app_id}")
def delete_app(app_id: int):
    conn = get_db()
    conn.execute("DELETE FROM apps WHERE id = ?", (app_id,))
    conn.commit()
    conn.close()
    return {"deleted": True}


@app.post("/api/apps/{app_id}/check")
async def check_now(app_id: int):
    conn = get_db()
    row = conn.execute("SELECT id FROM apps WHERE id = ?", (app_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="App not found")
    async with httpx.AsyncClient() as client:
        await check_one_app(client, app_id)
    conn = get_db()
    row = conn.execute("SELECT * FROM apps WHERE id = ?", (app_id,)).fetchone()
    conn.close()
    return row_to_dict(row)


@app.post("/api/apps/{app_id}/ack")
def acknowledge(app_id: int):
    """Mark the currently-seen latest version as the tracked baseline (dismiss the update badge)."""
    conn = get_db()
    row = conn.execute("SELECT * FROM apps WHERE id = ?", (app_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="App not found")
    conn.execute(
        "UPDATE apps SET current_version = latest_version, update_available = 0 WHERE id = ?",
        (app_id,),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM apps WHERE id = ?", (app_id,)).fetchone()
    conn.close()
    return row_to_dict(row)


@app.post("/api/check-all")
async def check_all_now():
    await check_all_apps()
    return {"ok": True}


@app.post("/api/sync-containers")
async def sync_containers_now():
    added = await sync_containers()
    return {"added": added}


class BulkUpdateRequest(BaseModel):
    ids: list[int]


@app.post("/api/apps/{app_id}/update")
async def update_now(app_id: int):
    result = await update_container(app_id)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])
    conn = get_db()
    row = conn.execute("SELECT * FROM apps WHERE id = ?", (app_id,)).fetchone()
    conn.close()
    return row_to_dict(row)


@app.post("/api/apps/bulk-update")
async def bulk_update(payload: BulkUpdateRequest):
    results = {}
    for app_id in payload.ids:
        results[str(app_id)] = await update_container(app_id)
    return results


# ---------- static frontend ----------

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
app.mount("/assets", StaticFiles(directory=STATIC_DIR), name="assets")


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))
