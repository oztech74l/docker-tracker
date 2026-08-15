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

const updateModalBackdrop = document.getElementById("update-modal-backdrop");
const updateModalBody = document.getElementById("update-modal-body");
const updateCancelBtn = document.getElementById("update-cancel-btn");
const updateConfirmBtn = document.getElementById("update-confirm-btn");

const bulkBar = document.getElementById("bulk-bar");
const bulkCount = document.getElementById("bulk-count");

let apps = [];
let editingAppId = null; // set when the modal is being used to add a repo to an auto-tracked app
let selected = new Set();
let pendingUpdate = null; // { ids: [...] } awaiting confirmation in the update modal

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
  showToast._t = setTimeout(() => toast.classList.add("hidden"), 3200);
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
  // drop selections for apps that no longer exist or no longer have an update
  const stillValid = new Set(apps.filter((a) => a.update_available && a.container_name).map((a) => a.id));
  for (const id of [...selected]) {
    if (!stillValid.has(id)) selected.delete(id);
  }
  render();
  renderBulkBar();
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

function renderBulkBar() {
  const count = selected.size;
  bulkBar.classList.toggle("hidden", count === 0);
  bulkCount.textContent = `${count} selected`;
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
  const canAutoUpdate = a.update_available && a.container_name;

  card.innerHTML = `
    <div class="card-top">
      <div class="card-select">
        ${canAutoUpdate ? `<input type="checkbox" data-select="${a.id}" ${selected.has(a.id) ? "checked" : ""} title="Select for bulk update" />` : ""}
        <div>
          <p class="card-name">${escapeHtml(a.name)} ${a.source === "container" ? '<span class="tag-auto">auto</span>' : ""}</p>
          <a class="card-repo" href="https://github.com/${a.repo}" target="_blank" rel="noopener">${escapeHtml(a.repo)}</a>
        </div>
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
      ${canAutoUpdate ? `<button class="btn btn-update btn-small" data-action="update">Update</button>` : ""}
      <button class="btn btn-ghost btn-small" data-action="check">Check now</button>
      ${a.update_available ? `<button class="btn btn-ghost btn-small" data-action="ack">Mark updated</button>` : ""}
      <button class="btn btn-ghost btn-small" data-action="delete">Remove</button>
    </div>
  `;

  const selectBox = card.querySelector("[data-select]");
  if (selectBox) {
    selectBox.addEventListener("change", () => {
      if (selectBox.checked) selected.add(a.id);
      else selected.delete(a.id);
      renderBulkBar();
    });
  }
  const updateBtn = card.querySelector('[data-action="update"]');
  if (updateBtn) updateBtn.addEventListener("click", () => confirmUpdate([a.id], a.name));
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
    selected.delete(id);
    await Promise.all([loadApps(), loadStats()]);
    renderBulkBar();
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

// ---- update / bulk update (real pull + recreate) ----

function confirmUpdate(ids, label) {
  pendingUpdate = { ids };
  updateModalBody.textContent =
    ids.length === 1
      ? `This will pull the new image for ${label} and recreate its container.`
      : `This will pull new images and recreate ${ids.length} containers, one at a time.`;
  updateModalBackdrop.classList.remove("hidden");
}

updateCancelBtn.addEventListener("click", () => {
  pendingUpdate = null;
  updateModalBackdrop.classList.add("hidden");
});
updateModalBackdrop.addEventListener("click", (e) => {
  if (e.target === updateModalBackdrop) {
    pendingUpdate = null;
    updateModalBackdrop.classList.add("hidden");
  }
});

updateConfirmBtn.addEventListener("click", async () => {
  if (!pendingUpdate) return;
  const { ids } = pendingUpdate;
  updateModalBackdrop.classList.add("hidden");
  pendingUpdate = null;
  setScanning(true);
  updateConfirmBtn.disabled = true;

  try {
    if (ids.length === 1) {
      await api(`/api/apps/${ids[0]}/update`, { method: "POST" });
      showToast("Updated");
    } else {
      const results = await api("/api/apps/bulk-update", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      const outcomes = Object.values(results);
      const okCount = outcomes.filter((r) => r.ok).length;
      const failCount = outcomes.length - okCount;
      showToast(
        failCount === 0
          ? `Updated ${okCount} app(s)`
          : `Updated ${okCount}, ${failCount} failed — check each card for details`
      );
    }
  } catch (e) {
    showToast(e.message);
  } finally {
    for (const id of ids) selected.delete(id);
    updateConfirmBtn.disabled = false;
    setScanning(false);
    await Promise.all([loadApps(), loadStats()]);
  }
});

document.getElementById("bulk-update-btn").addEventListener("click", () => {
  if (selected.size === 0) return;
  confirmUpdate([...selected], null);
});
document.getElementById("bulk-clear-btn").addEventListener("click", () => {
  selected.clear();
  render();
  renderBulkBar();
});

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
  if (e.key === "Escape") {
    closeModal();
    updateModalBackdrop.classList.add("hidden");
    pendingUpdate = null;
  }
});

document.getElementById("check-all-btn").addEventListener("click", checkAll);
document.getElementById("rescan-btn").addEventListener("click", rescanContainers);
searchInput.addEventListener("input", render);
filterUpdates.addEventListener("change", render);

// ---- theme ----

const THEME_KEY = "dt-theme";
const themeButtons = document.querySelectorAll(".theme-btn");

function applyTheme(pref) {
  const effective =
    pref === "system"
      ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : pref;
  document.documentElement.setAttribute("data-theme", effective);
  themeButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.themeChoice === pref));
}

function setThemePreference(pref) {
  localStorage.setItem(THEME_KEY, pref);
  applyTheme(pref);
}

themeButtons.forEach((btn) => {
  btn.addEventListener("click", () => setThemePreference(btn.dataset.themeChoice));
});

window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if ((localStorage.getItem(THEME_KEY) || "system") === "system") applyTheme("system");
});

applyTheme(localStorage.getItem(THEME_KEY) || "system");

// initial load + light polling so the dashboard reflects background checks
loadApps();
loadStats();
setInterval(loadStats, 30000);
setInterval(loadApps, 60000);
