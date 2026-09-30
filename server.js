const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || "local-dev-change-me";
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "local-demo-token";
const DATA_DIR = path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");

const MAIL_HOST_DEFAULT = "w01997c4.kasserver.com";

function mailAccount(prefix) {
  const env = (key, fallback = "") => process.env[`${prefix}${key}`] || fallback;
  return {
    smtp: {
      host: env("SMTP_HOST", MAIL_HOST_DEFAULT),
      port: Number(env("SMTP_PORT", "465")),
      secure: env("SMTP_SECURE", "true") === "true",
      user: env("SMTP_USER"),
      pass: env("SMTP_PASS"),
      from: env("SMTP_FROM"),
    },
    imap: {
      host: env("IMAP_HOST", MAIL_HOST_DEFAULT),
      port: Number(env("IMAP_PORT", "993")),
      secure: env("IMAP_SECURE", "true") === "true",
      user: env("IMAP_USER"),
      pass: env("IMAP_PASS"),
    },
  };
}

// kontakt@ – outgoing mail
const MAIL_CONFIG = mailAccount("");
// paula@ – receives leads as JSON emails
const LEADS_MAIL_CONFIG = mailAccount("LEADS_");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), test);
}

function nowIso() {
  return new Date().toISOString();
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(STORE_PATH)) return;

  const users = [
    {
      id: crypto.randomUUID(),
      name: "Admin",
      email: "admin@example.com",
      role: "admin",
      active: true,
      order: 0,
      passwordHash: hashPassword("admin123"),
      createdAt: nowIso()
    },
    {
      id: crypto.randomUUID(),
      name: "Mia Vertrieb",
      email: "mia@example.com",
      role: "sales",
      active: true,
      order: 1,
      passwordHash: hashPassword("vertrieb123"),
      createdAt: nowIso()
    },
    {
      id: crypto.randomUUID(),
      name: "Noah Vertrieb",
      email: "noah@example.com",
      role: "sales",
      active: true,
      order: 2,
      passwordHash: hashPassword("vertrieb123"),
      createdAt: nowIso()
    },
    {
      id: crypto.randomUUID(),
      name: "Lea Vertrieb",
      email: "lea@example.com",
      role: "sales",
      active: true,
      order: 3,
      passwordHash: hashPassword("vertrieb123"),
      createdAt: nowIso()
    }
  ];

  const leads = [
    makeLead(
      {
        full_name: "Sophie Berger",
        email: "sophie.berger@example.com",
        phone_number: "+49 151 23456789",
        campaign_name: "Facebook Solar Anfrage",
        message: "Bitte um Rückruf am Nachmittag."
      },
      users[1]
    ),
    makeLead(
      {
        name: "Daniel Klein",
        email: "daniel.klein@example.com",
        phone: "+49 160 9876543",
        form_name: "Immobilienbewertung",
        city: "Köln"
      },
      users[2]
    )
  ];

  writeStore({
    settings: { rotationIndex: 0 },
    users,
    leads,
    sessions: {}
  });
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
}

function writeStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .filter(Boolean)
      .map((part) => {
        const [key, ...value] = part.trim().split("=");
        return [key, decodeURIComponent(value.join("="))];
      })
  );
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

function createSession(res, userId) {
  const sessionId = crypto.randomUUID();
  const store = readStore();
  store.sessions[sessionId] = { userId, createdAt: nowIso() };
  writeStore(store);
  const token = `${sessionId}.${sign(sessionId)}`;
  res.setHeader(
    "Set-Cookie",
    `flc_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
  );
}

function getCurrentUser(req) {
  const token = parseCookies(req).flc_session;
  if (!token) return null;
  const [sessionId, signature] = token.split(".");
  if (!sessionId || signature !== sign(sessionId)) return null;
  const store = readStore();
  const session = store.sessions[sessionId];
  if (!session) return null;
  return store.users.find((user) => user.id === session.userId) || null;
}

function requireAuth(req, res, next) {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "Nicht angemeldet" });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Nur Admins erlaubt" });
  next();
}

function extractLeadFields(payload) {
  const flat = flatten(payload);
  const fields = payload.lead || payload.fields || payload.data || payload;
  const pick = (...keys) => {
    for (const key of keys) {
      if (fields && fields[key] != null && fields[key] !== "") return fields[key];
      if (flat[key] != null && flat[key] !== "") return flat[key];
    }
    return "";
  };

  return {
    name: String(pick("full_name", "name", "first_name", "contact_name") || "Unbekannter Lead"),
    email: String(pick("email", "email_address") || ""),
    phone: String(pick("phone_number", "phone", "mobile", "telefon") || ""),
    source: String(pick("form_name", "campaign_name", "ad_name", "source") || "Facebook Instant Form"),
    message: String(pick("message", "notes", "question", "anliegen") || ""),
    raw: payload
  };
}

function flatten(value, prefix = "", output = {}) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}${index}.`, output));
    return output;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => flatten(item, `${prefix}${key}.`, output));
    return output;
  }
  output[prefix.replace(/\.$/, "")] = value;
  const shortKey = prefix.split(".").filter(Boolean).pop();
  if (shortKey) output[shortKey] = value;
  return output;
}

function activeSalesUsers(store) {
  return store.users
    .filter((user) => user.role === "sales" && user.active)
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || a.name.localeCompare(b.name));
}

function rotationSnapshot(store) {
  const sales = activeSalesUsers(store);
  if (!sales.length) return { activeUserIds: [], nextUserId: null };
  const index = Number(store.settings.rotationIndex || 0) % sales.length;
  return {
    activeUserIds: sales.map((user) => user.id),
    nextUserId: sales[index].id
  };
}

function normalizeSalesOrder(store) {
  store.users
    .filter((user) => user.role === "sales")
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || a.name.localeCompare(b.name))
    .forEach((user, index) => {
      user.order = index + 1;
    });
}

function nextSalesUser(store) {
  const sales = activeSalesUsers(store);
  if (!sales.length) return null;
  const index = Number(store.settings.rotationIndex || 0) % sales.length;
  store.settings.rotationIndex = (index + 1) % sales.length;
  return sales[index];
}

function makeLead(input, assignedUser) {
  return {
    id: crypto.randomUUID(),
    name: input.name || input.full_name || "Unbekannter Lead",
    email: input.email || "",
    phone: input.phone || input.phone_number || "",
    source: input.source || input.form_name || input.campaign_name || "Facebook Instant Form",
    message: input.message || "",
    status: "new",
    assignedTo: assignedUser ? assignedUser.id : null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    raw: input.raw || input
  };
}

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  const store = readStore();
  const user = store.users.find((candidate) => candidate.email.toLowerCase() === String(email || "").toLowerCase());
  if (!user || !verifyPassword(String(password || ""), user.passwordHash)) {
    return res.status(401).json({ error: "E-Mail oder Passwort stimmt nicht" });
  }
  createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post("/api/logout", requireAuth, (req, res) => {
  const token = parseCookies(req).flc_session;
  const [sessionId] = String(token || "").split(".");
  const store = readStore();
  delete store.sessions[sessionId];
  writeStore(store);
  res.setHeader("Set-Cookie", "flc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get("/api/dashboard", requireAuth, (req, res) => {
  const store = readStore();
  const visibleLeads =
    req.user.role === "admin" ? store.leads : store.leads.filter((lead) => lead.assignedTo === req.user.id);
  res.json({
    user: publicUser(req.user),
    users: req.user.role === "admin" ? store.users.map(publicUser) : store.users.filter((user) => user.role === "sales").map(publicUser),
    leads: visibleLeads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    settings: req.user.role === "admin" ? { ...store.settings, webhookToken: WEBHOOK_TOKEN } : undefined,
    rotation: req.user.role === "admin" ? rotationSnapshot(store) : undefined
  });
});

app.post("/api/leads", requireAuth, requireAdmin, (req, res) => {
  const store = readStore();
  const assignee = nextSalesUser(store);
  const lead = makeLead(extractLeadFields(req.body || {}), assignee);
  store.leads.push(lead);
  writeStore(store);
  res.status(201).json({ lead, assignedUser: publicUser(assignee) });
});

app.patch("/api/leads/:id", requireAuth, (req, res) => {
  const store = readStore();
  const lead = store.leads.find((candidate) => candidate.id === req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead nicht gefunden" });
  if (req.user.role !== "admin" && lead.assignedTo !== req.user.id) {
    return res.status(403).json({ error: "Kein Zugriff auf diesen Lead" });
  }
  const allowed = req.user.role === "admin" ? ["status", "assignedTo", "message"] : ["status", "message"];
  for (const key of allowed) {
    if (req.body[key] !== undefined) lead[key] = req.body[key];
  }
  lead.updatedAt = nowIso();
  writeStore(store);
  res.json({ lead });
});

app.post("/api/users", requireAuth, requireAdmin, (req, res) => {
  const store = readStore();
  const { name, email, role = "sales", password = "vertrieb123" } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: "Name und E-Mail sind Pflicht" });
  if (store.users.some((user) => user.email.toLowerCase() === String(email).toLowerCase())) {
    return res.status(409).json({ error: "Diese E-Mail existiert bereits" });
  }
  const user = {
    id: crypto.randomUUID(),
    name: String(name),
    email: String(email),
    role: role === "admin" ? "admin" : "sales",
    active: true,
    order: Math.max(0, ...store.users.map((candidate) => Number(candidate.order || 0))) + 1,
    passwordHash: hashPassword(String(password)),
    createdAt: nowIso()
  };
  store.users.push(user);
  writeStore(store);
  res.status(201).json({ user: publicUser(user) });
});

app.patch("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const store = readStore();
  const user = store.users.find((candidate) => candidate.id === req.params.id);
  if (!user) return res.status(404).json({ error: "Nutzer nicht gefunden" });
  const previousNextUserId = rotationSnapshot(store).nextUserId;
  for (const key of ["name", "email", "role", "active", "order"]) {
    if (req.body[key] !== undefined) user[key] = req.body[key];
  }
  if (req.body.password) user.passwordHash = hashPassword(String(req.body.password));
  normalizeSalesOrder(store);
  const active = activeSalesUsers(store);
  const nextIndex = active.findIndex((candidate) => candidate.id === previousNextUserId);
  store.settings.rotationIndex = nextIndex >= 0 ? nextIndex : 0;
  writeStore(store);
  res.json({ user: publicUser(user) });
});

app.patch("/api/rotation", requireAuth, requireAdmin, (req, res) => {
  const store = readStore();
  const { orderedUserIds, nextUserId } = req.body || {};
  if (!Array.isArray(orderedUserIds)) {
    return res.status(400).json({ error: "Reihenfolge fehlt" });
  }

  const sales = store.users.filter((user) => user.role === "sales");
  const salesIds = new Set(sales.map((user) => user.id));
  const cleanIds = orderedUserIds.filter((id, index) => salesIds.has(id) && orderedUserIds.indexOf(id) === index);
  const missingIds = sales
    .filter((user) => !cleanIds.includes(user.id))
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .map((user) => user.id);
  [...cleanIds, ...missingIds].forEach((id, index) => {
    const user = store.users.find((candidate) => candidate.id === id);
    if (user) user.order = index + 1;
  });

  const active = activeSalesUsers(store);
  const nextIndex = active.findIndex((user) => user.id === nextUserId);
  store.settings.rotationIndex = nextIndex >= 0 ? nextIndex : 0;
  writeStore(store);
  res.json({ users: store.users.map(publicUser), rotation: rotationSnapshot(store) });
});

app.post("/webhook/facebook", (req, res) => {
  const token = req.query.token || req.headers["x-webhook-token"];
  if (token !== WEBHOOK_TOKEN) return res.status(401).json({ error: "Webhook Token fehlt oder ist falsch" });
  const store = readStore();
  const assignee = nextSalesUser(store);
  const lead = makeLead(extractLeadFields(req.body || {}), assignee);
  store.leads.push(lead);
  writeStore(store);
  res.status(201).json({ ok: true, leadId: lead.id, assignedTo: assignee ? assignee.email : null });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  ensureStore();
  console.log(`Facebook Lead Center läuft auf http://localhost:${PORT}`);
  console.log("Admin Login: admin@example.com / admin123");
});
