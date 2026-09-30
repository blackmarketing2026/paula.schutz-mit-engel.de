const state = {
  user: null,
  users: [],
  leads: [],
  settings: {},
  rotation: { activeUserIds: [], nextUserId: null },
  logs: [],
  templates: [],
  openLeadId: null,
  editUserId: null,
  editTemplateId: null,
  lastCredentials: null,
  view: "leads",
  filter: "all",
  logFilter: "all"
};

const logTypeLabels = {
  lead: "Lead",
  mail: "E-Mail",
  auth: "Login",
  team: "Team",
  contact: "Kontakt",
  template: "Textbaustein",
  error: "Fehler",
  system: "System"
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

function formatDateTime(value) {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
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
        <label class="field">
          <span>E-Mail</span>
          <input name="email" type="email" autocomplete="email" required />
        </label>
        <label class="field">
          <span>Passwort</span>
          <input name="password" type="password" autocomplete="current-password" required />
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
          ${state.user.role === "admin" ? navButton("settings", "settings", "Lead-Eingang") : ""}
          ${state.user.role === "admin" ? navButton("log", "scroll-text", "Log") : ""}
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
        ${storageWarning()}
        ${state.view === "leads" ? renderLeadsView() : ""}
        ${state.view === "team" ? renderTeamView() : ""}
        ${state.view === "settings" ? renderSettingsView() : ""}
        ${state.view === "log" ? renderLogView() : ""}
        ${state.view === "lead" ? renderLeadFileView() : ""}
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
  if (state.view === "log") return "Log";
  if (state.view === "lead") return "Lead-Akte";
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

function isAdmin() {
  return state.user?.role === "admin";
}

function renderLeadsView() {
  const counts = metrics();
  const pipeline = `
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
      </section>`;
  return `
    <div class="stats">
      <div class="stat"><span>Gesamt</span><strong>${counts.total}</strong></div>
      <div class="stat"><span>Neu</span><strong>${counts.new}</strong></div>
      <div class="stat"><span>Kontaktiert</span><strong>${counts.contacted}</strong></div>
      <div class="stat"><span>Gewonnen</span><strong>${counts.won}</strong></div>
    </div>
    ${
      isAdmin()
        ? `<div class="grid">
            ${pipeline}
            <section class="panel">
              <h2>Schnellerfassung</h2>
              <p class="muted">Zum Testen oder für manuelle Nachträge.</p>
              ${leadForm()}
            </section>
          </div>`
        : pipeline
    }
  `;
}

// ---------- Contact helpers ----------

function whatsappNumber(phone) {
  let digits = String(phone || "").replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = `49${digits.slice(1)}`;
  return digits;
}

function contactButtons(lead) {
  const phone = String(lead.phone || "").replace(/[^\d+]/g, "");
  const wa = whatsappNumber(lead.phone);
  return `
    <div class="contact-actions">
      ${lead.phone ? `<a class="btn secondary" href="tel:${escapeHtml(phone)}" data-contact="phone" data-lead="${lead.id}">${icon("phone")} Anrufen</a>` : ""}
      ${wa ? `<a class="btn whatsapp" href="https://wa.me/${wa}" target="_blank" rel="noopener" data-contact="whatsapp" data-lead="${lead.id}">${icon("message-circle")} WhatsApp</a>` : ""}
      ${lead.email ? `<a class="btn secondary" href="mailto:${escapeHtml(lead.email)}" data-contact="email" data-lead="${lead.id}">${icon("mail")} E-Mail</a>` : ""}
    </div>
  `;
}

function leadSelects(lead) {
  return `
    <select data-lead-status="${lead.id}" aria-label="Lead-Status">
      ${Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${lead.status === value ? "selected" : ""}>${label}</option>`).join("")}
    </select>
    ${
      isAdmin()
        ? `<select data-lead-owner="${lead.id}" aria-label="Zuständigkeit">
            <option value="">Nicht zugewiesen</option>
            ${state.users
              .filter((user) => user.role === "sales")
              .map((user) => `<option value="${user.id}" ${lead.assignedTo === user.id ? "selected" : ""}>${escapeHtml(user.name)}${user.locked ? " (gesperrt)" : ""}</option>`)
              .join("")}
          </select>`
        : ""
    }
  `;
}

function detailsList(lead) {
  if (!lead.details?.length) return "";
  return `<dl class="lead-details">${lead.details
    .map((item) => `<div><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value)}</dd></div>`)
    .join("")}</dl>`;
}

function renderLeadCard(lead) {
  const noteCount = lead.notes?.length || 0;
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
        ${noteCount ? `<span>${icon("notebook-pen", 14)} ${noteCount} ${noteCount === 1 ? "Notiz" : "Notizen"}</span>` : ""}
      </div>
      ${lead.message ? `<p class="muted">${escapeHtml(lead.message)}</p>` : ""}
      ${detailsList(lead)}
      ${contactButtons(lead)}
      <div class="lead-actions">
        ${leadSelects(lead)}
        <button class="btn" data-open-lead="${lead.id}" type="button">${icon("folder-open")} Akte öffnen</button>
      </div>
    </article>
  `;
}

// ---------- Lead file (Akte) ----------

function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") };
}

function fillTemplate(text, lead) {
  const { first, last } = splitName(lead.name);
  const values = {
    vorname: first,
    nachname: last,
    name: lead.name || "",
    berater: state.user?.name || "",
    email: lead.email || "",
    telefon: lead.phone || ""
  };
  return String(text).replace(/\{(\w+)\}/g, (match, key) => (key.toLowerCase() in values ? values[key.toLowerCase()] : match));
}

function currentLead() {
  return state.leads.find((lead) => lead.id === state.openLeadId);
}

function renderLeadFileView() {
  const lead = currentLead();
  if (!lead) {
    return `<section class="panel"><div class="empty">Dieser Lead ist nicht (mehr) sichtbar.</div>
      <button class="btn secondary" data-view="leads" type="button" style="margin-top:12px">${icon("arrow-left")} Zurück zu den Leads</button></section>`;
  }
  const notes = lead.notes || [];
  return `
    <button class="btn ghost back-btn" data-view="leads" type="button">${icon("arrow-left")} Zurück zu den Leads</button>
    <div class="grid file-grid">
      <div class="stack">
        <section class="panel">
          <div class="lead-main">
            <div>
              <h2>${escapeHtml(lead.name)}</h2>
              <div class="meta">
                <span>${icon("calendar", 14)} Eingang ${formatDateTime(lead.createdAt)}</span>
                <span>${icon("megaphone", 14)} ${escapeHtml(lead.source)}</span>
                <span>${icon("user-check", 14)} ${escapeHtml(userName(lead.assignedTo))}</span>
              </div>
            </div>
            <span class="pill ${lead.status}">${statusLabels[lead.status] || lead.status}</span>
          </div>
          <dl class="lead-details">
            <div><dt>E-Mail</dt><dd>${lead.email ? escapeHtml(lead.email) : "–"}</dd></div>
            <div><dt>Telefon</dt><dd>${lead.phone ? escapeHtml(lead.phone) : "–"}</dd></div>
            ${(lead.details || []).map((item) => `<div><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value)}</dd></div>`).join("")}
          </dl>
          ${lead.message ? `<p class="muted">${escapeHtml(lead.message)}</p>` : ""}
          ${contactButtons(lead)}
          <div class="lead-actions">${leadSelects(lead)}</div>
        </section>

        <section class="panel">
          <h2>Gesprächsnotizen</h2>
          <form id="noteForm">
            <label class="field"><span>Neue Notiz</span><textarea name="text" rows="4" placeholder="Was wurde besprochen? Nächste Schritte?" required></textarea></label>
            <button class="btn full" type="submit">${icon("save")} Notiz speichern</button>
          </form>
          <div class="note-list">
            ${
              notes.length
                ? notes
                    .map(
                      (note) => `
                  <article class="note">
                    <div class="note-head">
                      <span><strong>${escapeHtml(note.authorName)}</strong> · ${formatDateTime(note.at)}</span>
                      ${
                        isAdmin() || note.authorId === state.user.id
                          ? `<button class="btn ghost icon-btn" data-delete-note="${note.id}" title="Notiz löschen" type="button">${icon("trash-2", 16)}</button>`
                          : ""
                      }
                    </div>
                    <p>${escapeHtml(note.text).replace(/\n/g, "<br />")}</p>
                  </article>`
                    )
                    .join("")
                : `<div class="empty">Noch keine Notizen.</div>`
            }
          </div>
        </section>
      </div>

      ${renderTemplatesPanel(lead)}
    </div>
  `;
}

function renderTemplatesPanel(lead) {
  const editing = state.templates.find((template) => template.id === state.editTemplateId);
  const wa = whatsappNumber(lead.phone);
  return `
    <section class="panel">
      <h2>Textbausteine</h2>
      <p class="muted">Mit einem Klick kopieren und im WhatsApp-Chat einfügen. Der Name des Kunden wird automatisch eingesetzt.</p>
      <div class="template-list">
        ${
          state.templates.length
            ? state.templates
                .map((template) => {
                  const filled = fillTemplate(template.text, lead);
                  return `
              <article class="template">
                <div class="note-head">
                  <strong>${escapeHtml(template.title)}</strong>
                  <div class="icon-actions">
                    <button class="btn ghost icon-btn" data-edit-template="${template.id}" title="Bearbeiten" type="button">${icon("pencil", 16)}</button>
                    <button class="btn ghost icon-btn" data-delete-template="${template.id}" title="Löschen" type="button">${icon("trash-2", 16)}</button>
                  </div>
                </div>
                <p>${escapeHtml(filled).replace(/\n/g, "<br />")}</p>
                <div class="toolbar">
                  <button class="btn secondary" data-copy-template="${template.id}" type="button">${icon("copy")} Kopieren</button>
                  ${
                    wa
                      ? `<a class="btn whatsapp" href="https://wa.me/${wa}?text=${encodeURIComponent(filled)}" target="_blank" rel="noopener" data-contact="whatsapp" data-lead="${lead.id}" data-template-title="${escapeHtml(template.title)}">${icon("message-circle")} In WhatsApp öffnen</a>`
                      : ""
                  }
                </div>
              </article>`;
                })
                .join("")
            : `<div class="empty">Noch keine Textbausteine.</div>`
        }
      </div>
      <form id="templateForm" class="template-form">
        <h3>${editing ? "Textbaustein bearbeiten" : "Neuer Textbaustein"}</h3>
        <label class="field"><span>Titel</span><input name="title" value="${escapeHtml(editing?.title || "")}" maxlength="100" required /></label>
        <label class="field"><span>Text</span><textarea name="text" rows="5" maxlength="5000" required>${escapeHtml(editing?.text || "")}</textarea></label>
        <p class="muted small">Platzhalter: {vorname}, {nachname}, {name}, {berater}, {telefon}, {email}</p>
        <div class="toolbar">
          <button class="btn" type="submit">${icon("save")} ${editing ? "Änderungen speichern" : "Textbaustein anlegen"}</button>
          ${editing ? `<button class="btn secondary" id="cancelTemplateEdit" type="button">Abbrechen</button>` : ""}
        </div>
      </form>
    </section>
  `;
}

// ---------- Team ----------

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((byte) => chars[byte % chars.length]).join("");
}

function credentialsText(credentials) {
  return `Login für Paula\nAdresse: ${location.origin}\nE-Mail: ${credentials.email}\nPasswort: ${credentials.password}`;
}

function renderCredentialsBox() {
  const credentials = state.lastCredentials;
  if (!credentials) return "";
  return `
    <div class="credentials">
      <strong>${escapeHtml(credentials.title)}</strong>
      <pre class="code">${escapeHtml(credentialsText(credentials))}</pre>
      <div class="toolbar">
        <button class="btn" id="copyCredentialsBtn" type="button">${icon("copy")} Login-Daten kopieren</button>
        <button class="btn secondary" id="dismissCredentialsBtn" type="button">Schließen</button>
      </div>
      <p class="muted small">Das Passwort wird nur jetzt angezeigt. Bitte direkt an den Vertriebler weitergeben.</p>
    </div>
  `;
}

function renderTeamView() {
  const sales = orderedSalesUsers();
  const nextUser = sales.find((user) => user.id === state.rotation?.nextUserId);
  const editing = state.users.find((user) => user.id === state.editUserId);
  return `
    ${renderCredentialsBox()}
    <div class="grid">
      <section class="panel">
        <div class="panel-head">
          <h2>Rotation</h2>
          <span class="pill">${sales.filter((user) => user.active && !user.locked).length} aktiv</span>
        </div>
        <div class="rotation-summary">
          <span class="muted">Nächster Lead geht an</span>
          <strong>${nextUser ? escapeHtml(nextUser.name) : "Niemand aktiv"}</strong>
        </div>
        <div class="user-list">
          ${sales.length ? sales.map((user, index) => renderUserRow(user, index, sales.length)).join("") : `<div class="empty">Noch keine Vertriebler angelegt.</div>`}
        </div>
      </section>
      ${editing ? renderUserEditPanel(editing) : renderUserCreatePanel()}
    </div>
    <section class="panel" style="margin-top:16px">
      <h2>Alle Zugänge</h2>
      <div class="access-list">
        ${state.users
          .slice()
          .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "admin" ? -1 : 1))
          .map(
            (user) => `
          <div class="access-row ${user.locked ? "locked" : ""}">
            <div><strong>${escapeHtml(user.name)}</strong><br /><span class="muted">${escapeHtml(user.email)}</span></div>
            <span class="pill">${user.role === "admin" ? "Admin" : "Vertrieb"}</span>
            <span class="pill ${user.locked ? "lost" : "won"}">${user.locked ? "Gesperrt" : "Aktiv"}</span>
            <button class="btn secondary" data-edit-user="${user.id}" type="button">${icon("pencil")} Bearbeiten</button>
          </div>`
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderUserCreatePanel() {
  return `
    <section class="panel">
      <h2>Vertriebler hinzufügen</h2>
      <p class="muted">Nach dem Anlegen kann sich der Vertriebler sofort einloggen und sieht nur seine eigenen Leads.</p>
      <form id="userForm">
        <label class="field"><span>Name</span><input name="name" required /></label>
        <label class="field"><span>E-Mail (Login)</span><input name="email" type="email" required /></label>
        <label class="field"><span>Startpasswort</span>
          <div class="input-row">
            <input name="password" type="text" minlength="8" required />
            <button class="btn secondary" data-generate-password type="button" title="Passwort erzeugen">${icon("wand-sparkles")}</button>
          </div>
        </label>
        <label class="field"><span>Rolle</span>
          <select name="role"><option value="sales">Vertrieb</option><option value="admin">Admin</option></select>
        </label>
        <button class="btn full" type="submit">${icon("user-plus")} Zugang anlegen</button>
      </form>
    </section>
  `;
}

function renderUserEditPanel(user) {
  const isSelf = user.id === state.user.id;
  return `
    <section class="panel">
      <div class="panel-head">
        <h2>${escapeHtml(user.name)} bearbeiten</h2>
        <span class="pill ${user.locked ? "lost" : "won"}">${user.locked ? "Gesperrt" : "Aktiv"}</span>
      </div>
      <form id="userEditForm" data-user-id="${user.id}">
        <label class="field"><span>Name</span><input name="name" value="${escapeHtml(user.name)}" required /></label>
        <label class="field"><span>E-Mail (Login)</span><input name="email" type="email" value="${escapeHtml(user.email)}" required /></label>
        <label class="field"><span>Rolle</span>
          <select name="role" ${isSelf ? "disabled" : ""}>
            <option value="sales" ${user.role === "sales" ? "selected" : ""}>Vertrieb</option>
            <option value="admin" ${user.role === "admin" ? "selected" : ""}>Admin</option>
          </select>
        </label>
        <label class="field"><span>Neues Passwort (leer lassen = unverändert)</span>
          <div class="input-row">
            <input name="password" type="text" minlength="8" autocomplete="new-password" />
            <button class="btn secondary" data-generate-password type="button" title="Passwort erzeugen">${icon("wand-sparkles")}</button>
          </div>
        </label>
        <div class="toolbar">
          <button class="btn" type="submit">${icon("save")} Speichern</button>
          <button class="btn secondary" id="cancelUserEdit" type="button">Abbrechen</button>
        </div>
      </form>
      ${
        isSelf
          ? ""
          : `<div class="danger-zone">
              <p class="muted">${user.locked ? "Der Zugang ist gesperrt. Der Nutzer kann sich nicht einloggen und bekommt keine Leads." : "Gesperrte Nutzer werden sofort abgemeldet und bekommen keine neuen Leads mehr."}</p>
              <button class="btn ${user.locked ? "" : "danger"}" data-toggle-lock="${user.id}" data-locked="${user.locked ? "1" : ""}" type="button">
                ${user.locked ? `${icon("lock-open")} Zugang entsperren` : `${icon("lock")} Zugang sperren`}
              </button>
            </div>`
      }
    </section>
  `;
}

function orderedSalesUsers() {
  return state.users
    .filter((user) => user.role === "sales")
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || a.name.localeCompare(b.name));
}

function renderUserRow(user, index, count) {
  const isNext = user.id === state.rotation?.nextUserId;
  const usable = user.active && !user.locked;
  return `
    <div class="user-row ${isNext ? "next" : ""} ${user.locked ? "locked" : ""}">
      <div class="row-position">${index + 1}</div>
      <div><strong>${escapeHtml(user.name)}</strong>${user.locked ? ` <span class="pill lost">Gesperrt</span>` : ""}<br /><span class="muted">${escapeHtml(user.email)}</span></div>
      <div class="icon-actions">
        <button class="btn secondary icon-btn" data-rotation-move="${user.id}" data-direction="-1" ${index === 0 ? "disabled" : ""} title="Nach oben" type="button">${icon("arrow-up")}</button>
        <button class="btn secondary icon-btn" data-rotation-move="${user.id}" data-direction="1" ${index === count - 1 ? "disabled" : ""} title="Nach unten" type="button">${icon("arrow-down")}</button>
      </div>
      <label class="switch"><input data-user-active="${user.id}" type="checkbox" ${user.active ? "checked" : ""} ${user.locked ? "disabled" : ""} /> In Rotation</label>
      <button class="btn ${isNext ? "" : "secondary"}" data-next-user="${user.id}" ${!usable ? "disabled" : ""} type="button">${isNext ? icon("check") : icon("target")} Als nächstes</button>
      <span class="pill">${state.leads.filter((lead) => lead.assignedTo === user.id).length} Leads</span>
      <button class="btn secondary icon-btn" data-edit-user="${user.id}" title="Bearbeiten" type="button">${icon("pencil")}</button>
    </div>
  `;
}

function storageWarning() {
  if (state.user.role !== "admin" || state.settings?.storageMode !== "tmp") return "";
  return `<div class="notice">${icon("triangle-alert")} Keine Datenbank verbunden: Leads und Log gehen beim nächsten Neustart auf Vercel verloren. Bitte die MYSQL_*-Variablen der All-Inkl-Datenbank in Vercel eintragen.</div>`;
}

function renderMailPanel() {
  const settings = state.settings || {};
  const status = !settings.mailConfigured
    ? "Nicht eingerichtet: LEADS_IMAP_USER und LEADS_IMAP_PASS fehlen in Vercel."
    : settings.mailLastError
      ? `Letzter Abruf fehlgeschlagen: ${settings.mailLastError}`
      : settings.mailLastSyncAt
        ? `Zuletzt abgerufen: ${formatDateTime(settings.mailLastSyncAt)}`
        : "Noch nicht abgerufen.";
  return `
    <section class="panel">
      <h2>E-Mail-Eingang</h2>
      <p class="muted">Leads als JSON an diese Adresse senden, der Betreff ist egal. Das Postfach wird automatisch abgerufen, solange das Dashboard offen ist (höchstens einmal pro Minute).</p>
      <label class="field">
        <span>Adresse</span>
        <input value="${escapeHtml(settings.leadsMailbox || "")}" readonly />
      </label>
      <p class="muted">${escapeHtml(status)}</p>
      <div class="toolbar" style="margin-top:12px">
        <button class="btn" id="syncMailBtn" type="button" ${settings.mailConfigured ? "" : "disabled"}>${icon("mail-check")} Postfach jetzt abrufen</button>
      </div>
      <pre class="code">[
  {"name": "full_name", "values": ["Max Mustermann"]},
  {"name": "email", "values": ["max@example.com"]},
  {"name": "phone_number", "values": ["+49 170 1234567"]}
]</pre>
    </section>
  `;
}

function filteredLogs() {
  return (state.logs || []).filter((entry) => state.logFilter === "all" || entry.type === state.logFilter);
}

function renderLogView() {
  const logs = filteredLogs();
  return `
    <section class="panel">
      <div class="panel-head">
        <h2>Aktivitäten</h2>
        <div class="toolbar">
          <select id="logFilterSelect" aria-label="Log filtern">
            <option value="all">Alle Einträge</option>
            ${Object.entries(logTypeLabels).map(([value, label]) => `<option value="${value}" ${state.logFilter === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
          <button class="btn secondary" id="refreshLogBtn" type="button">${icon("refresh-cw")} Aktualisieren</button>
        </div>
      </div>
      ${
        logs.length
          ? `<div class="log-list">${logs
              .map(
                (entry) => `
                <div class="log-row">
                  <time datetime="${escapeHtml(entry.at)}">${formatDateTime(entry.at)}</time>
                  <span class="pill log-${escapeHtml(entry.type)}">${escapeHtml(logTypeLabels[entry.type] || entry.type)}</span>
                  <div>
                    <div>${escapeHtml(entry.message)}</div>
                    <small class="muted">${escapeHtml(entry.actor || "System")}</small>
                  </div>
                </div>`
              )
              .join("")}</div>`
          : `<div class="empty">Noch keine Einträge.</div>`
      }
    </section>
  `;
}

function renderSettingsView() {
  const sampleUrl = `${location.origin}/webhook/facebook?token=${state.settings.webhookToken || "local-demo-token"}`;
  return `
    ${renderMailPanel()}
    <section class="panel" style="margin-top:16px">
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
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const { user } = await api("/api/users", { method: "POST", body: JSON.stringify(payload) });
      state.lastCredentials = { title: `Zugang angelegt für ${user.name}`, email: user.email, password: payload.password };
      toast("Zugang wurde angelegt.");
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

  document.querySelector("#logFilterSelect")?.addEventListener("change", (event) => {
    state.logFilter = event.target.value;
    render();
  });

  document.querySelector("#refreshLogBtn")?.addEventListener("click", () => loadDashboard().catch((error) => toast(error.message)));

  document.querySelector("#syncMailBtn")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      const result = await api("/api/mail/sync", { method: "POST" });
      toast(result.skipped || `${result.imported} neue Leads, ${result.ignored} E-Mails ohne JSON.`);
      await loadDashboard();
    } catch (error) {
      toast(error.message);
      await loadDashboard().catch(() => {});
    }
  });

  document.querySelectorAll("[data-open-lead]").forEach((button) => {
    button.addEventListener("click", () => {
      state.openLeadId = button.dataset.openLead;
      state.editTemplateId = null;
      state.view = "lead";
      render();
      window.scrollTo(0, 0);
    });
  });

  document.querySelectorAll("[data-contact]").forEach((link) => {
    link.addEventListener("click", () => {
      logContact(link.dataset.lead, link.dataset.contact, link.dataset.templateTitle);
    });
  });

  document.querySelector("#noteForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get("text");
    try {
      await api(`/api/leads/${state.openLeadId}/notes`, { method: "POST", body: JSON.stringify({ text }) });
      toast("Notiz gespeichert.");
      await loadDashboard();
    } catch (error) {
      toast(error.message);
    }
  });

  document.querySelectorAll("[data-delete-note]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Diese Notiz wirklich löschen?")) return;
      try {
        await api(`/api/leads/${state.openLeadId}/notes/${button.dataset.deleteNote}`, { method: "DELETE" });
        toast("Notiz gelöscht.");
        await loadDashboard();
      } catch (error) {
        toast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-copy-template]").forEach((button) => {
    button.addEventListener("click", async () => {
      const template = state.templates.find((entry) => entry.id === button.dataset.copyTemplate);
      const lead = currentLead();
      if (!template || !lead) return;
      await copyText(fillTemplate(template.text, lead));
      toast(`„${template.title}“ kopiert. Jetzt im WhatsApp-Chat einfügen.`);
      logContact(lead.id, "template", template.title);
    });
  });

  document.querySelectorAll("[data-edit-template]").forEach((button) => {
    button.addEventListener("click", () => {
      state.editTemplateId = button.dataset.editTemplate;
      render();
      document.querySelector("#templateForm")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });

  document.querySelectorAll("[data-delete-template]").forEach((button) => {
    button.addEventListener("click", async () => {
      const template = state.templates.find((entry) => entry.id === button.dataset.deleteTemplate);
      if (!template || !confirm(`Textbaustein „${template.title}“ wirklich löschen?`)) return;
      try {
        await api(`/api/templates/${template.id}`, { method: "DELETE" });
        if (state.editTemplateId === template.id) state.editTemplateId = null;
        toast("Textbaustein gelöscht.");
        await loadDashboard();
      } catch (error) {
        toast(error.message);
      }
    });
  });

  document.querySelector("#templateForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    try {
      if (state.editTemplateId) {
        await api(`/api/templates/${state.editTemplateId}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast("Textbaustein gespeichert.");
      } else {
        await api("/api/templates", { method: "POST", body: JSON.stringify(payload) });
        toast("Textbaustein angelegt.");
      }
      state.editTemplateId = null;
      await loadDashboard();
    } catch (error) {
      toast(error.message);
    }
  });

  document.querySelector("#cancelTemplateEdit")?.addEventListener("click", () => {
    state.editTemplateId = null;
    render();
  });

  document.querySelectorAll("[data-edit-user]").forEach((button) => {
    button.addEventListener("click", () => {
      state.editUserId = button.dataset.editUser;
      render();
      window.scrollTo(0, 0);
    });
  });

  document.querySelector("#cancelUserEdit")?.addEventListener("click", () => {
    state.editUserId = null;
    render();
  });

  document.querySelector("#userEditForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form));
    if (!payload.password) delete payload.password;
    try {
      const { user } = await api(`/api/users/${form.dataset.userId}`, { method: "PATCH", body: JSON.stringify(payload) });
      if (payload.password) {
        state.lastCredentials = { title: `Neues Passwort für ${user.name}`, email: user.email, password: payload.password };
      }
      state.editUserId = null;
      toast("Zugang gespeichert.");
      await loadDashboard();
    } catch (error) {
      toast(error.message);
    }
  });

  document.querySelectorAll("[data-toggle-lock]").forEach((button) => {
    button.addEventListener("click", async () => {
      const lock = !button.dataset.locked;
      if (lock && !confirm("Zugang wirklich sperren? Der Nutzer wird sofort abgemeldet.")) return;
      try {
        await api(`/api/users/${button.dataset.toggleLock}`, { method: "PATCH", body: JSON.stringify({ locked: lock }) });
        toast(lock ? "Zugang gesperrt." : "Zugang entsperrt.");
        await loadDashboard();
      } catch (error) {
        toast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-generate-password]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = button.parentElement.querySelector("input");
      input.value = generatePassword();
      input.focus();
    });
  });

  document.querySelector("#copyCredentialsBtn")?.addEventListener("click", async () => {
    await copyText(credentialsText(state.lastCredentials));
    toast("Login-Daten kopiert.");
  });

  document.querySelector("#dismissCredentialsBtn")?.addEventListener("click", () => {
    state.lastCredentials = null;
    render();
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

function logContact(leadId, channel, template) {
  api(`/api/leads/${leadId}/contact`, { method: "POST", body: JSON.stringify({ channel, template }) }).catch(() => {});
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
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

// Refresh every minute; this also triggers the mailbox import on the server
function hasDraft() {
  const active = document.activeElement;
  if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return true;
  return [...document.querySelectorAll("#app form input, #app form textarea")].some(
    (field) => field.value && field.value !== field.defaultValue
  );
}

setInterval(() => {
  if (state.user && !document.hidden && !hasDraft()) loadDashboard().catch(() => {});
}, 60 * 1000);

trySession();
