const grid = document.getElementById("app-grid");
const emptyState = document.getElementById("empty-state");
const scanline = document.getElementById("scanline");
const searchInput = document.getElementById("search");
const filterUpdates = document.getElementById("filter-updates");
const toast = document.getElementById("toast");

const modalBackdrop = document.getElementById("modal-backdrop");
const modalTitle = document.getElementById("modal-title");
const appForm = document.getElementById("app-form");
const formError = document.getElementById("form-error");
const submitBtn = document.getElementById("submit-btn");
const fName = document.getElementById("f-name");
const fRepo = document.getElementById("f-repo");
const fImage = document.getElementById("f-image");
const fVersion = document.getElementById("f-version");

let apps = [];
let editingAppId = null; // set when the modal is being used to add a repo to an auto-tracked app

function fmtDate(iso) {
  if (!iso) return "never checked";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add("hidden"), 2600);
}

function setScanning(active) {
  scanline.classList.toggle("active", active);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${res.status})`);
  }
  return res.json();
}

async function loadApps() {
  apps = await api("/api/apps");
  render();
}

async function loadStats() {
  const s = await api("/api/stats");
  document.getElementById("stat-total").textContent = s.total;
  document.getElementById("stat-updates").textContent = s.updates_available;
  document.getElementById("stat-errors").textContent = s.errors;
}

function render() {
  const q = searchInput.value.trim().toLowerCase();
  const onlyUpdates = filterUpdates.checked;

  const filtered = apps.filter((a) => {
    if (onlyUpdates && !a.update_available) return false;
    if (!q) return true;
    return (
      a.name.toLowerCase().includes(q) ||
      (a.repo && a.repo.toLowerCase().includes(q)) ||
      (a.image && a.image.toLowerCase().includes(q))
    );
  });

  grid.innerHTML = "";
  emptyState.classList.toggle("hidden", apps.length > 0);
  if (apps.length > 0 && filtered.length === 0) {
    grid.innerHTML = `<p style="color: var(--text-faint); font-family: var(--font-mono); font-size: 13px;">No apps match that filter.</p>`;
    return;
  }

  for (const a of filtered) {
    grid.appendChild(renderCard(a));
  }
}

function renderCard(a) {
  const card = document.createElement("div");
  card.className = "card";

  if (!a.repo) {
    // auto-detected from a running container, but we couldn't resolve a
    // GitHub repo from the image name — needs a human to fill it in
    card.classList.add("has-pending");
    card.innerHTML = `
      <div class="card-top">
        <div>
          <p class="card-name">${escapeHtml(a.name)}</p>
          <p class="card-repo">${escapeHtml(a.image || "auto-detected container")}</p>
        </div>
        <span class="dot pending" title="Needs a GitHub repo"></span>
      </div>
      <p class="card-meta">Auto-detected from a running container — add its GitHub repo to start tracking releases.</p>
      <div class="card-actions">
        <button class="btn btn-ghost btn-small" data-action="setrepo">Set GitHub repo</button>
        <button class="btn btn-ghost btn-small" data-action="delete">Remove</button>
      </div>
    `;
    card.querySelector('[data-action="setrepo"]').addEventListener("click", () => openModal({ mode: "setrepo", app: a }));
    card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteApp(a.id, a.name));
    return card;
  }

  if (a.update_available) card.classList.add("has-signal");
  if (a.last_error) card.classList.add("has-error");

  let dotClass = "clear";
  if (a.last_error) dotClass = "error";
  else if (a.update_available) dotClass = "signal";

  const currentV = a.current_version || "unknown";
  const latestV = a.latest_version || "—";

  card.innerHTML = `
    <div class="card-top">
      <div>
        <p class="card-name">${escapeHtml(a.name)} ${a.source === "container" ? '<span class="tag-auto">auto</span>' : ""}</p>
        <a class="card-repo" href="https://github.com/${a.repo}" target="_blank" rel="noopener">${escapeHtml(a.repo)}</a>
      </div>
      <span class="dot ${dotClass}" title="${a.update_available ? "Update available" : a.last_error ? "Check failed" : "Up to date"}"></span>
    </div>
    <div class="versions">
      <span class="v-current">${escapeHtml(currentV)}</span>
      <span class="v-arrow">→</span>
      <a class="v-latest ${a.update_available ? "is-update" : ""}" href="${a.latest_url || `https://github.com/${a.repo}/releases`}" target="_blank" rel="noopener">${escapeHtml(latestV)}</a>
    </div>
    ${a.last_error ? `<p class="card-error-msg">${escapeHtml(a.last_error)}</p>` : `<p class="card-meta">checked ${fmtDate(a.last_checked)}</p>`}
    <div class="card-actions">
      <button class="btn btn-ghost btn-small" data-action="check">Check now</button>
      ${a.update_available ? `<button class="btn btn-ghost btn-small" data-action="ack">Mark updated</button>` : ""}
      <button class="btn btn-ghost btn-small" data-action="delete">Remove</button>
    </div>
  `;

  card.querySelector('[data-action="check"]').addEventListener("click", () => checkApp(a.id));
  const ackBtn = card.querySelector('[data-action="ack"]');
  if (ackBtn) ackBtn.addEventListener("click", () => ackApp(a.id));
  card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteApp(a.id, a.name));

  return card;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

async function checkApp(id) {
  setScanning(true);
  try {
    await api(`/api/apps/${id}/check`, { method: "POST" });
    await Promise.all([loadApps(), loadStats()]);
  } catch (e) {
    showToast(e.message);
  } finally {
    setScanning(false);
  }
}

async function ackApp(id) {
  try {
    await api(`/api/apps/${id}/ack`, { method: "POST" });
    await Promise.all([loadApps(), loadStats()]);
    showToast("Marked as updated");
  } catch (e) {
    showToast(e.message);
  }
}

async function deleteApp(id, name) {
  if (!confirm(`Stop tracking ${name}?`)) return;
  try {
    await api(`/api/apps/${id}`, { method: "DELETE" });
    await Promise.all([loadApps(), loadStats()]);
  } catch (e) {
    showToast(e.message);
  }
}

async function checkAll() {
  setScanning(true);
  try {
    await api("/api/check-all", { method: "POST" });
    await Promise.all([loadApps(), loadStats()]);
    showToast("Check complete");
  } catch (e) {
    showToast(e.message);
  } finally {
    setScanning(false);
  }
}

async function rescanContainers() {
  setScanning(true);
  try {
    const res = await api("/api/sync-containers", { method: "POST" });
    await Promise.all([loadApps(), loadStats()]);
    showToast(res.added > 0 ? `Found ${res.added} new container(s)` : "No new containers found");
  } catch (e) {
    showToast(e.message);
  } finally {
    setScanning(false);
  }
}

// ---- modal ----
// mode "add" (default): create a brand new tracked app
// mode "setrepo": attach a GitHub repo to an existing auto-detected app

function openModal(opts) {
  const mode = (opts && opts.mode) || "add";
  appForm.reset();
  formError.classList.add("hidden");
  editingAppId = null;

  if (mode === "setrepo" && opts.app) {
    editingAppId = opts.app.id;
    modalTitle.textContent = `Set GitHub repo for ${opts.app.name}`;
    fName.value = opts.app.name;
    fName.disabled = true;
    fImage.value = opts.app.image || "";
    fImage.disabled = true;
    submitBtn.textContent = "Save repo";
  } else {
    modalTitle.textContent = "Track a new app";
    fName.disabled = false;
    fImage.disabled = false;
    submitBtn.textContent = "Start tracking";
  }

  modalBackdrop.classList.remove("hidden");
  (mode === "setrepo" ? fRepo : fName).focus();
}

function closeModal() {
  modalBackdrop.classList.add("hidden");
  fName.disabled = false;
  fImage.disabled = false;
  editingAppId = null;
}

appForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.classList.add("hidden");
  submitBtn.disabled = true;
  const originalLabel = submitBtn.textContent;
  submitBtn.textContent = "Checking…";

  try {
    if (editingAppId) {
      await api(`/api/apps/${editingAppId}`, {
        method: "PATCH",
        body: JSON.stringify({
          repo: fRepo.value.trim(),
          current_version: fVersion.value.trim() || null,
        }),
      });
      closeModal();
      await Promise.all([loadApps(), loadStats()]);
      showToast("Repo saved");
    } else {
      const payload = {
        name: fName.value.trim(),
        repo: fRepo.value.trim(),
        image: fImage.value.trim() || null,
        current_version: fVersion.value.trim() || null,
      };
      await api("/api/apps", { method: "POST", body: JSON.stringify(payload) });
      closeModal();
      await Promise.all([loadApps(), loadStats()]);
      showToast(`Now tracking ${payload.name}`);
    }
  } catch (e) {
    formError.textContent = e.message;
    formError.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
});

document.getElementById("add-app-btn").addEventListener("click", () => openModal());
document.getElementById("empty-add-btn").addEventListener("click", () => openModal());
document.getElementById("cancel-btn").addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

document.getElementById("check-all-btn").addEventListener("click", checkAll);
document.getElementById("rescan-btn").addEventListener("click", rescanContainers);
searchInput.addEventListener("input", render);
filterUpdates.addEventListener("change", render);

// initial load + light polling so the dashboard reflects background checks
loadApps();
loadStats();
setInterval(loadStats, 30000);
setInterval(loadApps, 60000);
