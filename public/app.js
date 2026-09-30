const state = {
  user: null,
  users: [],
  leads: [],
  settings: {},
  rotation: { activeUserIds: [], nextUserId: null },
  view: "leads",
  filter: "all"
};

const statusLabels = {
  new: "Neu",
  contacted: "Kontaktiert",
  won: "Gewonnen",
  lost: "Verloren"
};

const app = document.querySelector("#app");

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Aktion fehlgeschlagen");
  return data;
}

function icon(name, size = 18) {
  return `<i data-lucide="${name}" style="width:${size}px;height:${size}px"></i>`;
}

function renderIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function toast(message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

function userName(id) {
  return state.users.find((user) => user.id === id)?.name || "Nicht zugewiesen";
}

function formatDate(value) {
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

async function loadDashboard() {
  const data = await api("/api/dashboard");
  Object.assign(state, data);
  render();
}

async function trySession() {
  try {
    await loadDashboard();
  } catch {
    renderLogin();
  }
}

function renderLogin() {
  app.innerHTML = `
    <section class="login-shell">
      <div class="login-hero">
        <h1>Facebook Lead Center</h1>
        <p>Lead-Anfragen annehmen, sauber verteilen und vom ersten Kontakt bis zum Abschluss verfolgen.</p>
      </div>
      <form class="login-panel" id="loginForm">
        <h2>Einloggen</h2>
        <p class="muted">Admin: admin@example.com / admin123</p>
        <label class="field">
          <span>E-Mail</span>
          <input name="email" type="email" value="admin@example.com" autocomplete="email" required />
        </label>
        <label class="field">
          <span>Passwort</span>
          <input name="password" type="password" value="admin123" autocomplete="current-password" required />
        </label>
        <button class="btn full" type="submit">${icon("log-in")} Einloggen</button>
      </form>
    </section>
  `;
  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/login", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(form))
      });
      await loadDashboard();
    } catch (error) {
      toast(error.message);
    }
  });
  renderIcons();
}

function render() {
  app.innerHTML = `
    <section class="app-shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">${icon("facebook")}</span><span>Lead Center</span></div>
        <nav class="nav">
          ${navButton("leads", "inbox", "Leads")}
          ${state.user.role === "admin" ? navButton("team", "users", "Team") : ""}
          ${state.user.role === "admin" ? navButton("settings", "settings", "Webhook") : ""}
        </nav>
        <div class="account">
          <strong>${state.user.name}</strong>
          <small>${state.user.role === "admin" ? "Admin" : "Vertrieb"}</small>
          <button class="btn ghost full" id="logoutBtn" type="button">${icon("log-out")} Abmelden</button>
        </div>
      </aside>
      <section class="content">
        <header class="topbar">
          <div>
            <h1>${pageTitle()}</h1>
            <p class="muted">${state.user.role === "admin" ? "Alle eingehenden Anfragen und Zuständigkeiten." : "Deine zugewiesenen Anfragen."}</p>
          </div>
          ${state.user.role === "admin" ? `<button class="btn" id="quickLeadBtn" type="button">${icon("plus")} Test-Lead</button>` : ""}
        </header>
        ${state.view === "leads" ? renderLeadsView() : ""}
        ${state.view === "team" ? renderTeamView() : ""}
        ${state.view === "settings" ? renderSettingsView() : ""}
      </section>
    </section>
  `;
  bindEvents();
  renderIcons();
}

function navButton(view, iconName, label) {
  return `<button class="btn ${state.view === view ? "active" : ""}" data-view="${view}" type="button">${icon(iconName)} ${label}</button>`;
}

function pageTitle() {
  if (state.view === "team") return "Team & Rotation";
  if (state.view === "settings") return "Lead-Eingang";
  return "Dashboard";
}

function metrics() {
  const leads = filteredByOwner();
  return {
    total: leads.length,
    new: leads.filter((lead) => lead.status === "new").length,
    contacted: leads.filter((lead) => lead.status === "contacted").length,
    won: leads.filter((lead) => lead.status === "won").length
  };
}

function filteredByOwner() {
  return state.leads;
}

function visibleLeads() {
  return filteredByOwner().filter((lead) => state.filter === "all" || lead.status === state.filter);
}

function renderLeadsView() {
  const counts = metrics();
  return `
    <div class="stats">
      <div class="stat"><span>Gesamt</span><strong>${counts.total}</strong></div>
      <div class="stat"><span>Neu</span><strong>${counts.new}</strong></div>
      <div class="stat"><span>Kontaktiert</span><strong>${counts.contacted}</strong></div>
      <div class="stat"><span>Gewonnen</span><strong>${counts.won}</strong></div>
    </div>
    <div class="grid">
      <section class="panel">
        <div class="panel-head">
          <h2>Lead-Pipeline</h2>
          <select id="filterSelect" aria-label="Status filtern">
            <option value="all">Alle Status</option>
            ${Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${state.filter === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </div>
        <div class="lead-list">
          ${visibleLeads().length ? visibleLeads().map(renderLeadCard).join("") : `<div class="empty">Noch keine Leads in dieser Ansicht.</div>`}
        </div>
      </section>
      <section class="panel">
        <h2>Schnellerfassung</h2>
        <p class="muted">Zum Testen oder für manuelle Nachträge.</p>
        ${leadForm()}
      </section>
    </div>
  `;
}

function renderLeadCard(lead) {
  return `
    <article class="lead-card">
      <div class="lead-main">
        <div>
          <h3>${escapeHtml(lead.name)}</h3>
          <div class="meta">
            ${lead.email ? `<span>${icon("mail", 14)} ${escapeHtml(lead.email)}</span>` : ""}
            ${lead.phone ? `<span>${icon("phone", 14)} ${escapeHtml(lead.phone)}</span>` : ""}
            <span>${icon("calendar", 14)} ${formatDate(lead.createdAt)}</span>
          </div>
        </div>
        <span class="pill ${lead.status}">${statusLabels[lead.status] || lead.status}</span>
      </div>
      <div class="meta">
        <span>${icon("megaphone", 14)} ${escapeHtml(lead.source)}</span>
        <span>${icon("user-check", 14)} ${escapeHtml(userName(lead.assignedTo))}</span>
      </div>
      ${lead.message ? `<p class="muted">${escapeHtml(lead.message)}</p>` : ""}
      <div class="lead-actions">
        <select data-lead-status="${lead.id}" aria-label="Lead-Status">
          ${Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${lead.status === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
        ${
          state.user.role === "admin"
            ? `<select data-lead-owner="${lead.id}" aria-label="Zuständigkeit">
                <option value="">Nicht zugewiesen</option>
                ${state.users
                  .filter((user) => user.role === "sales")
                  .map((user) => `<option value="${user.id}" ${lead.assignedTo === user.id ? "selected" : ""}>${escapeHtml(user.name)}</option>`)
                  .join("")}
              </select>`
            : `<a class="btn secondary" href="${lead.phone ? `tel:${lead.phone}` : `mailto:${lead.email}`}">${icon("phone-call")} Kontakt</a>`
        }
      </div>
    </article>
  `;
}

function leadForm() {
  return `
    <form id="leadForm">
      <label class="field"><span>Name</span><input name="name" required /></label>
      <label class="field"><span>E-Mail</span><input name="email" type="email" /></label>
      <label class="field"><span>Telefon</span><input name="phone" /></label>
      <label class="field"><span>Kampagne/Formular</span><input name="source" value="Facebook Instant Form" /></label>
      <label class="field"><span>Notiz</span><textarea name="message"></textarea></label>
      <button class="btn full" type="submit">${icon("send")} Lead anlegen & rotieren</button>
    </form>
  `;
}

function renderTeamView() {
  const sales = orderedSalesUsers();
  const nextUser = sales.find((user) => user.id === state.rotation?.nextUserId);
  return `
    <div class="grid">
      <section class="panel">
        <div class="panel-head">
          <h2>Rotation</h2>
          <span class="pill">${sales.filter((user) => user.active).length} aktiv</span>
        </div>
        <div class="rotation-summary">
          <span class="muted">Naechster Lead geht an</span>
          <strong>${nextUser ? escapeHtml(nextUser.name) : "Niemand aktiv"}</strong>
        </div>
        <div class="user-list">
          ${sales.map((user, index) => renderUserRow(user, index, sales.length)).join("")}
        </div>
      </section>
      <section class="panel">
        <h2>Vertriebler hinzufügen</h2>
        <p class="muted">Neue aktive Vertriebler werden automatisch in die Round-Robin-Reihenfolge aufgenommen.</p>
        <form id="userForm">
          <label class="field"><span>Name</span><input name="name" required /></label>
          <label class="field"><span>E-Mail</span><input name="email" type="email" required /></label>
          <label class="field"><span>Startpasswort</span><input name="password" value="vertrieb123" required /></label>
          <button class="btn full" type="submit">${icon("user-plus")} Hinzufügen</button>
        </form>
      </section>
    </div>
  `;
}

function orderedSalesUsers() {
  return state.users
    .filter((user) => user.role === "sales")
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || a.name.localeCompare(b.name));
}

function renderUserRow(user, index, count) {
  const isNext = user.id === state.rotation?.nextUserId;
  return `
    <div class="user-row ${isNext ? "next" : ""}">
      <div class="row-position">${index + 1}</div>
      <div><strong>${escapeHtml(user.name)}</strong><br /><span class="muted">${escapeHtml(user.email)}</span></div>
      <div class="icon-actions">
        <button class="btn secondary icon-btn" data-rotation-move="${user.id}" data-direction="-1" ${index === 0 ? "disabled" : ""} title="Nach oben" type="button">${icon("arrow-up")}</button>
        <button class="btn secondary icon-btn" data-rotation-move="${user.id}" data-direction="1" ${index === count - 1 ? "disabled" : ""} title="Nach unten" type="button">${icon("arrow-down")}</button>
      </div>
      <label class="switch"><input data-user-active="${user.id}" type="checkbox" ${user.active ? "checked" : ""} /> Aktiv</label>
      <button class="btn ${isNext ? "" : "secondary"}" data-next-user="${user.id}" ${!user.active ? "disabled" : ""} type="button">${isNext ? icon("check") : icon("target")} Als naechstes</button>
      <span class="pill">${state.leads.filter((lead) => lead.assignedTo === user.id).length} Leads</span>
    </div>
  `;
}

function renderSettingsView() {
  const sampleUrl = `${location.origin}/webhook/facebook?token=${state.settings.webhookToken || "local-demo-token"}`;
  return `
    <section class="panel">
      <h2>Facebook/IFTTT Webhook</h2>
      <p class="muted">IFTTT kann den rohen JSON-Body per POST an diese URL senden. Das Dashboard erkennt typische Felder wie name, full_name, email, phone_number, campaign_name und form_name.</p>
      <label class="field">
        <span>Webhook URL</span>
        <input id="webhookUrl" value="${sampleUrl}" readonly />
      </label>
      <div class="toolbar" style="margin-top:12px">
        <button class="btn secondary" id="copyWebhookBtn" type="button">${icon("copy")} Kopieren</button>
        <button class="btn" id="sendSampleBtn" type="button">${icon("test-tube")} Probe senden</button>
      </div>
      <pre class="code">{
  "full_name": "Max Mustermann",
  "email": "max@example.com",
  "phone_number": "+49 170 1234567",
  "campaign_name": "Facebook Kampagne Juni",
  "message": "Ich möchte ein Angebot."
}</pre>
    </section>
  `;
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      render();
    });
  });

  document.querySelector("#logoutBtn")?.addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    renderLogin();
  });

  document.querySelector("#filterSelect")?.addEventListener("change", (event) => {
    state.filter = event.target.value;
    render();
  });

  document.querySelector("#leadForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api("/api/leads", { method: "POST", body: JSON.stringify(payload) });
      toast("Lead wurde angelegt und verteilt.");
      await loadDashboard();
    } catch (error) {
      toast(error.message);
    }
  });

  document.querySelector("#quickLeadBtn")?.addEventListener("click", async () => {
    await api("/api/leads", {
      method: "POST",
      body: JSON.stringify({
        full_name: `Demo Lead ${Math.floor(Math.random() * 900 + 100)}`,
        email: "demo@example.com",
        phone_number: "+49 170 000000",
        campaign_name: "Testformular"
      })
    });
    toast("Test-Lead rotiert.");
    await loadDashboard();
  });

  document.querySelector("#userForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/users", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      toast("Vertriebler wurde hinzugefügt.");
      await loadDashboard();
    } catch (error) {
      toast(error.message);
    }
  });

  document.querySelectorAll("[data-lead-status]").forEach((select) => {
    select.addEventListener("change", () => updateLead(select.dataset.leadStatus, { status: select.value }));
  });

  document.querySelectorAll("[data-lead-owner]").forEach((select) => {
    select.addEventListener("change", () => updateLead(select.dataset.leadOwner, { assignedTo: select.value || null }));
  });

  document.querySelectorAll("[data-user-active]").forEach((input) => {
    input.addEventListener("change", () => updateUser(input.dataset.userActive, { active: input.checked }));
  });

  document.querySelectorAll("[data-rotation-move]").forEach((button) => {
    button.addEventListener("click", () => moveRotationUser(button.dataset.rotationMove, Number(button.dataset.direction)));
  });

  document.querySelectorAll("[data-next-user]").forEach((button) => {
    button.addEventListener("click", () => saveRotationOrder(orderedSalesUsers().map((user) => user.id), button.dataset.nextUser));
  });

  document.querySelector("#copyWebhookBtn")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(document.querySelector("#webhookUrl").value);
    toast("Webhook URL kopiert.");
  });

  document.querySelector("#sendSampleBtn")?.addEventListener("click", async () => {
    await fetch(document.querySelector("#webhookUrl").value, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_name: "Max Mustermann",
        email: "max@example.com",
        phone_number: "+49 170 1234567",
        campaign_name: "Facebook Kampagne Juni",
        message: "Ich möchte ein Angebot."
      })
    });
    toast("Probe-Webhook empfangen.");
    await loadDashboard();
  });
}

async function updateLead(id, patch) {
  try {
    await api(`/api/leads/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    await loadDashboard();
  } catch (error) {
    toast(error.message);
  }
}

async function updateUser(id, patch) {
  try {
    await api(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    await loadDashboard();
  } catch (error) {
    toast(error.message);
  }
}

async function moveRotationUser(id, direction) {
  const users = orderedSalesUsers();
  const index = users.findIndex((user) => user.id === id);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= users.length) return;
  [users[index], users[targetIndex]] = [users[targetIndex], users[index]];
  await saveRotationOrder(users.map((user) => user.id), state.rotation?.nextUserId);
}

async function saveRotationOrder(orderedUserIds, nextUserId) {
  try {
    const data = await api("/api/rotation", {
      method: "PATCH",
      body: JSON.stringify({ orderedUserIds, nextUserId })
    });
    state.users = data.users;
    state.rotation = data.rotation;
    toast("Rotation wurde gespeichert.");
    render();
  } catch (error) {
    toast(error.message);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

trySession();
