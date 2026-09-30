const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const mysql = require("mysql2/promise");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || "local-dev-change-me";
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "local-demo-token";
// Vercel only allows writing to /tmp (ephemeral, per instance)
const DATA_DIR = process.env.VERCEL ? "/tmp/paula-data" : path.join(__dirname, "data");
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
const STORE_PATH = path.join(DATA_DIR, "store.json");
const MAX_LOG_ENTRIES = 2000;
const MAIL_SYNC_INTERVAL_MS = 60 * 1000;
const MAIL_BATCH_SIZE = 25;
const MAIL_SYNC_TIME_BUDGET_MS = 40 * 1000;
// Optional shared secret for /api/cron/mail (Vercel Cron sends it as Bearer token)
const CRON_SECRET = process.env.CRON_SECRET || "";

// Persistent storage on Vercel: Upstash Redis (Vercel Marketplace sets KV_* or UPSTASH_* vars)
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const REDIS_KEY = "paula:store";
// Persistent storage via MySQL (e.g. All-Inkl); takes precedence over Redis
const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST || "",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || ""
};
const MYSQL_TABLE = "paula_store";
const STORAGE_MODE =
  MYSQL_CONFIG.host && MYSQL_CONFIG.user && MYSQL_CONFIG.database
    ? "mysql"
    : REDIS_URL && REDIS_TOKEN
      ? "redis"
      : process.env.VERCEL
        ? "tmp"
        : "file";

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

function createInitialStore() {
  // Only the hash of the default admin password is stored; ADMIN_PASSWORD overrides it
  const adminPasswordHash = process.env.ADMIN_PASSWORD
    ? hashPassword(process.env.ADMIN_PASSWORD)
    : "7b041f88c948794ad158c9982cfc47be:5e6bb51c24e17b6900ad9a2740e1f90e5a3d46bc22bcf2467db651a8eb2768066f3fc6f20859f00bdcb9e8e2cef8bc545faa26d8684cdef3c95bae422deed0f1";

  const store = {
    settings: { rotationIndex: 0 },
    users: [
      {
        id: crypto.randomUUID(),
        name: "Admin",
        email: process.env.ADMIN_EMAIL || "paula-engel@function-concept.de",
        role: "admin",
        active: true,
        order: 0,
        passwordHash: adminPasswordHash,
        createdAt: nowIso()
      }
    ],
    leads: [],
    logs: []
  };
  addLog(store, "system", "Paula wurde eingerichtet");
  return store;
}

function normalizeStore(store) {
  store.settings = store.settings || { rotationIndex: 0 };
  store.users = store.users || [];
  store.leads = store.leads || [];
  store.logs = store.logs || [];
  store.templates = store.templates || defaultTemplates();
  delete store.sessions;
  return store;
}

function defaultTemplates() {
  const template = (title, text) => ({ id: crypto.randomUUID(), title, text, createdAt: nowIso(), updatedAt: nowIso() });
  return [
    template(
      "Erstkontakt",
      "Hallo {vorname}, hier ist {berater} von Schutz mit Engel. Du hattest dich für unseren Rechtsschutz interessiert. Wann passt es dir für ein kurzes Telefonat?"
    ),
    template("Nicht erreicht", "Hallo {vorname}, ich habe gerade versucht, dich anzurufen. Wann bist du am besten erreichbar? Viele Grüße, {berater}"),
    template("Terminbestätigung", "Hallo {vorname}, danke für das nette Gespräch! Wie besprochen melde ich mich zum vereinbarten Termin. Viele Grüße, {berater}")
  ];
}

async function redis(command) {
  const response = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(`Datenbankfehler: ${data.error || response.status}`);
  return data.result;
}

let mysqlPoolPromise = null;
function mysqlPool() {
  mysqlPoolPromise ??= (async () => {
    const pool = mysql.createPool({
      ...MYSQL_CONFIG,
      connectionLimit: 2,
      connectTimeout: 10000,
      charset: "utf8mb4",
      ...(process.env.MYSQL_SSL === "true" ? { ssl: { rejectUnauthorized: false } } : {})
    });
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${MYSQL_TABLE} (id VARCHAR(64) PRIMARY KEY, data LONGTEXT NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) CHARACTER SET utf8mb4`
    );
    return pool;
  })().catch((error) => {
    mysqlPoolPromise = null;
    throw new Error(`Datenbankfehler: ${error.message}`);
  });
  return mysqlPoolPromise;
}

async function loadStoreRaw() {
  if (STORAGE_MODE === "mysql") {
    const [rows] = await (await mysqlPool()).query(`SELECT data FROM ${MYSQL_TABLE} WHERE id = ?`, ["main"]);
    return rows.length ? rows[0].data : null;
  }
  if (STORAGE_MODE === "redis") return redis(["GET", REDIS_KEY]);
  return fs.existsSync(STORE_PATH) ? fs.readFileSync(STORE_PATH, "utf8") : null;
}

async function readStore() {
  const raw = await loadStoreRaw();
  if (raw) {
    const parsed = JSON.parse(raw);
    const needsMigration = !parsed.templates;
    const store = normalizeStore(parsed);
    if (needsMigration) await writeStore(store);
    return store;
  }
  const store = createInitialStore();
  await writeStore(store);
  return store;
}

async function writeStore(store) {
  const json = JSON.stringify(store, null, 2);
  if (STORAGE_MODE === "mysql") {
    await (await mysqlPool()).query(
      `INSERT INTO ${MYSQL_TABLE} (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)`,
      ["main", json]
    );
    return;
  }
  if (STORAGE_MODE === "redis") {
    await redis(["SET", REDIS_KEY, json]);
    return;
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, json);
}

// Row lock (SELECT ... FOR UPDATE) keeps concurrent serverless instances from overwriting each other
async function updateStoreMysql(mutate) {
  await readStore(); // makes sure the row exists
  const connection = await (await mysqlPool()).getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(`SELECT data FROM ${MYSQL_TABLE} WHERE id = ? FOR UPDATE`, ["main"]);
    const store = normalizeStore(JSON.parse(rows[0].data));
    const result = await mutate(store);
    await connection.query(`UPDATE ${MYSQL_TABLE} SET data = ? WHERE id = ?`, [JSON.stringify(store, null, 2), "main"]);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

// Serialize read-modify-write cycles within this instance
let storeQueue = Promise.resolve();
function updateStore(mutate) {
  const run = storeQueue.then(async () => {
    if (STORAGE_MODE === "mysql") return updateStoreMysql(mutate);
    const store = await readStore();
    const result = await mutate(store);
    await writeStore(store);
    return result;
  });
  storeQueue = run.catch(() => {});
  return run;
}

function actorName(user) {
  return user ? `${user.name} (${user.email})` : "System";
}

function addLog(store, type, message, { actor = "System", details } = {}) {
  store.logs = store.logs || [];
  store.logs.unshift({ id: crypto.randomUUID(), at: nowIso(), type, actor, message, ...(details ? { details } : {}) });
  if (store.logs.length > MAX_LOG_ENTRIES) store.logs.length = MAX_LOG_ENTRIES;
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

// Stateless session: signed cookie with email + expiry, so it survives serverless instance changes
function createSession(res, user) {
  const expires = Date.now() + SESSION_MAX_AGE * 1000;
  const payload = Buffer.from(JSON.stringify({ email: user.email.toLowerCase(), expires })).toString("base64url");
  const token = `${payload}.${sign(payload)}`;
  res.setHeader(
    "Set-Cookie",
    `flc_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${process.env.VERCEL ? "; Secure" : ""}`
  );
}

async function getCurrentUser(req) {
  const token = parseCookies(req).flc_session;
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  let session;
  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!session.email || Date.now() > Number(session.expires)) return null;
  const store = await readStore();
  return store.users.find((user) => !user.locked && user.email.toLowerCase() === session.email) || null;
}

// Wraps async handlers so errors become JSON 500 responses
function handle(fn) {
  return (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch((error) => {
      console.error(error);
      if (!res.headersSent) res.status(500).json({ error: error.message || "Serverfehler" });
    });
}

const requireAuth = handle(async (req, res, next) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "Nicht angemeldet" });
  req.user = user;
  next();
});

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Nur Admins erlaubt" });
  next();
}

const NAME_KEYS = ["full_name", "name", "first_name", "contact_name"];
const EMAIL_KEYS = ["email", "email_address"];
const PHONE_KEYS = ["phone_number", "phone", "mobile", "telefon"];
const SOURCE_KEYS = ["form_name", "campaign_name", "ad_name", "source"];
const MESSAGE_KEYS = ["message", "notes", "question", "anliegen"];
const KNOWN_KEYS = new Set([...NAME_KEYS, ...EMAIL_KEYS, ...PHONE_KEYS, ...SOURCE_KEYS, ...MESSAGE_KEYS]);

// Facebook lead format: [{ name, values: [] }] (also nested as field_data) -> { name: "v1, v2" }
function normalizePayload(payload) {
  const isFieldList = (value) =>
    Array.isArray(value) && value.length > 0 && value.every((item) => item && typeof item === "object" && "name" in item && "values" in item);
  const toObject = (list) =>
    Object.fromEntries(
      list.map((item) => [
        String(item.name).trim(),
        [].concat(item.values ?? []).map((value) => String(value).replace(/\s+/g, " ").trim()).join(", ")
      ])
    );

  if (isFieldList(payload)) return toObject(payload);
  if (payload && typeof payload === "object" && isFieldList(payload.field_data)) {
    const { field_data, ...rest } = payload;
    return { ...rest, ...toObject(field_data) };
  }
  if (Array.isArray(payload) && payload.length === 1 && payload[0] && typeof payload[0] === "object") return payload[0];
  return payload || {};
}

function prettify(value) {
  const text = String(value).replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function extractLeadFields(rawPayload) {
  const payload = normalizePayload(rawPayload);
  const flat = flatten(payload);
  const fields = payload.lead || payload.fields || payload.data || payload;
  const pick = (keys) => {
    for (const key of keys) {
      if (fields && fields[key] != null && fields[key] !== "") return fields[key];
      if (flat[key] != null && flat[key] !== "") return flat[key];
    }
    return "";
  };

  const details = Object.entries(fields && typeof fields === "object" ? fields : {})
    .filter(([key, value]) => !KNOWN_KEYS.has(key) && value != null && value !== "" && typeof value !== "object")
    .map(([key, value]) => ({ label: prettify(key), value: prettify(value) }));

  return {
    name: String(pick(NAME_KEYS) || "Unbekannter Lead"),
    email: String(pick(EMAIL_KEYS) || ""),
    phone: String(pick(PHONE_KEYS) || ""),
    source: String(pick(SOURCE_KEYS) || ""),
    message: String(pick(MESSAGE_KEYS) || ""),
    details,
    raw: rawPayload
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
    .filter((user) => user.role === "sales" && user.active && !user.locked)
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

function makeLead(input, assignedUser, defaultSource = "Facebook Instant Form") {
  return {
    id: crypto.randomUUID(),
    name: input.name || input.full_name || "Unbekannter Lead",
    email: input.email || "",
    phone: input.phone || input.phone_number || "",
    source: input.source || input.form_name || input.campaign_name || defaultSource,
    message: input.message || "",
    details: input.details || [],
    status: "new",
    assignedTo: assignedUser ? assignedUser.id : null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    raw: input.raw || input
  };
}

// Creates a lead with round-robin assignment and logs it
function addLead(store, fields, { channel, actor = "System", defaultSource, extra = {} }) {
  const assignee = nextSalesUser(store);
  const lead = { ...makeLead(fields, assignee, defaultSource), channel, ...extra };
  store.leads.push(lead);
  addLog(store, "lead", `Lead „${lead.name}“ über ${channel} angelegt → ${assignee ? assignee.name : "nicht zugewiesen"}`, {
    actor,
    details: { leadId: lead.id, email: lead.email, phone: lead.phone, source: lead.source }
  });
  return { lead, assignee };
}

// ---------- Email intake (paula@) ----------

// Mail clients hard-wrap long lines and append link hints like "<+49%20177...>" or "<mailto:...>"
function cleanMailText(text) {
  return String(text || "")
    .replace(/\s*<(?:mailto:|tel:|https?:\/\/|\+)[^<>\s]*>/g, "")
    .replace(/\r?\n/g, " ");
}

// Finds the first parseable JSON array/object in free text (e.g. an email body)
// Prefers the largest match, so a broken outer array does not fall back to one inner object
function extractJson(text) {
  const matches = [findJson(text), findJson(cleanMailText(text))].filter(Boolean);
  if (!matches.length) return null;
  return matches.sort((a, b) => b.size - a.size)[0].value;
}

function findJson(text) {
  const source = String(text || "").replace(/[„“”″]/g, '"').replace(/[‚‘’]/g, "'");
  for (let start = 0; start < source.length; start++) {
    const open = source[start];
    if (open !== "[" && open !== "{") continue;
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let inString = false;
    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (inString) {
        if (char === "\\") i++;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === open) depth++;
      else if (char === close && --depth === 0) {
        try {
          const value = JSON.parse(source.slice(start, i + 1));
          if (value && typeof value === "object") return { value, size: i + 1 - start };
        } catch {}
        break;
      }
    }
  }
  return null;
}

function openLeadsMailbox() {
  const { host, port, secure, user, pass } = LEADS_MAIL_CONFIG.imap;
  return new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass },
    logger: false,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000
  });
}

async function parseLeadMail(source) {
  const mail = await simpleParser(source);
  const jsonAttachments = (mail.attachments || [])
    .filter((file) => /json/i.test(file.contentType) || /\.json$/i.test(file.filename || ""))
    .map((file) => file.content.toString("utf8"));
  let payload = null;
  for (const candidate of [...jsonAttachments, mail.text, mail.html]) {
    payload = extractJson(candidate);
    if (payload) break;
  }
  return {
    payload,
    messageId: mail.messageId || "",
    subject: mail.subject || "",
    from: mail.from?.text || "",
    date: mail.date ? mail.date.toISOString() : ""
  };
}

// Stores one batch of parsed mails as leads, oldest first, and advances the UID cursor
function applyMailBatch(store, uidValidity, parsed, actor, result) {
  if (store.settings.mailUidValidity !== uidValidity) {
    store.settings.mailUidValidity = uidValidity;
    store.settings.mailLastUid = 0;
  }
  for (const mail of parsed) {
    if (mail.uid <= Number(store.settings.mailLastUid || 0)) continue;
    store.settings.mailLastUid = mail.uid;
    const mailInfo = { subject: mail.subject, from: mail.from, date: mail.date, messageId: mail.messageId };
    if (mail.messageId && store.leads.some((lead) => lead.mailMessageId === mail.messageId)) {
      result.duplicates++;
      continue;
    }
    if (mail.parseError || !mail.payload) {
      result.ignored++;
      addLog(store, "mail", `E-Mail „${mail.subject || "(ohne Betreff)"}“ ignoriert: ${mail.parseError || "kein JSON gefunden"}`, {
        actor,
        details: mailInfo
      });
      continue;
    }
    addLead(store, extractLeadFields(mail.payload), {
      channel: "E-Mail",
      actor,
      defaultSource: "E-Mail-Eingang",
      extra: { mailMessageId: mail.messageId, mailSubject: mail.subject, mailFrom: mail.from }
    });
    result.imported++;
  }
}

let mailSyncRunning = null;

function mailSyncConfigured() {
  return Boolean(LEADS_MAIL_CONFIG.imap.user && LEADS_MAIL_CONFIG.imap.pass);
}

// Imports all new emails from paula@ as leads, batch by batch, until the inbox is
// caught up or the time budget is used. Throttled unless force is set.
function syncMailbox({ force = false, actor = "System", logEmpty = false } = {}) {
  if (mailSyncRunning) return mailSyncRunning;
  mailSyncRunning = (async () => {
    if (!mailSyncConfigured()) return { skipped: "Postfach nicht konfiguriert (LEADS_IMAP_USER / LEADS_IMAP_PASS fehlen)" };
    const snapshot = await readStore();
    const lastSync = Date.parse(snapshot.settings.mailLastSyncAt || 0) || 0;
    if (!force && Date.now() - lastSync < MAIL_SYNC_INTERVAL_MS) return { skipped: "Kürzlich abgerufen" };

    const startedAt = Date.now();
    const result = { imported: 0, ignored: 0, duplicates: 0, remaining: 0 };
    const client = openLeadsMailbox();
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uidValidity = String(client.mailbox.uidValidity);
        let lastUid = snapshot.settings.mailUidValidity === uidValidity ? Number(snapshot.settings.mailLastUid || 0) : 0;

        while (true) {
          const uids = client.mailbox.exists > 0 ? ((await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })) || []) : [];
          // "n:*" also matches the newest mail when n is beyond the last UID
          const pending = uids.filter((uid) => uid > lastUid).sort((a, b) => a - b);
          if (!pending.length) break;
          if (Date.now() - startedAt > MAIL_SYNC_TIME_BUDGET_MS) {
            result.remaining = pending.length;
            break;
          }

          const batch = pending.slice(0, MAIL_BATCH_SIZE);
          const parsed = [];
          for await (const message of client.fetch(batch.join(","), { uid: true, source: true }, { uid: true })) {
            try {
              parsed.push({ uid: message.uid, ...(await parseLeadMail(message.source)) });
            } catch (error) {
              parsed.push({ uid: message.uid, parseError: error.message });
            }
          }
          parsed.sort((a, b) => a.uid - b.uid);

          lastUid = await updateStore((store) => {
            applyMailBatch(store, uidValidity, parsed, actor, result);
            return Number(store.settings.mailLastUid || 0);
          });
          if (batch.length < MAIL_BATCH_SIZE) break;
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      await updateStore((store) => {
        store.settings.mailLastSyncAt = nowIso();
        store.settings.mailLastError = error.message;
        addLog(store, "error", `Postfach ${LEADS_MAIL_CONFIG.imap.user} konnte nicht abgerufen werden: ${error.message}`, { actor });
      });
      return { ...result, error: error.message };
    } finally {
      await client.logout().catch(() => {});
    }

    await updateStore((store) => {
      store.settings.mailLastSyncAt = nowIso();
      store.settings.mailLastError = "";
      if (logEmpty || result.imported || result.ignored || result.remaining) {
        addLog(
          store,
          "mail",
          `Postfach abgerufen: ${result.imported} neue Leads, ${result.ignored} ignoriert` +
            `${result.duplicates ? `, ${result.duplicates} doppelt` : ""}` +
            `${result.remaining ? `, ${result.remaining} folgen beim nächsten Abruf` : ""}`,
          { actor }
        );
      }
    });
    return result;
  })().finally(() => {
    mailSyncRunning = null;
  });
  return mailSyncRunning;
}

// ---------- Routes ----------

app.post("/api/login", handle(async (req, res) => {
  const { email, password } = req.body || {};
  const user = await updateStore((store) => {
    const candidate = store.users.find((entry) => entry.email.toLowerCase() === String(email || "").toLowerCase());
    if (!candidate || !verifyPassword(String(password || ""), candidate.passwordHash)) {
      addLog(store, "auth", `Fehlgeschlagener Login für „${String(email || "").slice(0, 100)}“`, { details: { ip: req.ip } });
      return null;
    }
    if (candidate.locked) {
      addLog(store, "auth", "Login abgelehnt: Zugang gesperrt", { actor: actorName(candidate), details: { ip: req.ip } });
      return { locked: true };
    }
    addLog(store, "auth", "Login erfolgreich", { actor: actorName(candidate) });
    return candidate;
  });
  if (!user) return res.status(401).json({ error: "E-Mail oder Passwort stimmt nicht" });
  if (user.locked) return res.status(403).json({ error: "Dein Zugang ist gesperrt. Bitte wende dich an den Admin." });
  createSession(res, user);
  res.json({ user: publicUser(user) });
}));

app.post("/api/logout", handle(async (req, res) => {
  const user = await getCurrentUser(req);
  if (user) await updateStore((store) => addLog(store, "auth", "Abgemeldet", { actor: actorName(user) }));
  res.setHeader("Set-Cookie", "flc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
}));

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get("/api/dashboard", requireAuth, handle(async (req, res) => {
  await syncMailbox().catch((error) => console.error("Mail sync failed", error));
  const store = await readStore();
  const isAdmin = req.user.role === "admin";
  const visibleLeads = isAdmin ? store.leads : store.leads.filter((lead) => lead.assignedTo === req.user.id);
  res.json({
    user: publicUser(req.user),
    users: isAdmin ? store.users.map(publicUser) : store.users.filter((user) => user.role === "sales").map(publicUser),
    leads: visibleLeads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    settings: isAdmin
      ? {
          ...store.settings,
          webhookToken: WEBHOOK_TOKEN,
          storageMode: STORAGE_MODE,
          leadsMailbox: LEADS_MAIL_CONFIG.imap.user,
          mailConfigured: mailSyncConfigured()
        }
      : undefined,
    rotation: isAdmin ? rotationSnapshot(store) : undefined,
    templates: store.templates,
    logs: isAdmin ? store.logs.slice(0, 500) : undefined
  });
}));

app.post("/api/mail/sync", requireAuth, requireAdmin, handle(async (req, res) => {
  const result = await syncMailbox({ force: true, actor: actorName(req.user), logEmpty: true });
  if (result.error) return res.status(502).json({ error: `Postfach-Abruf fehlgeschlagen: ${result.error}` });
  res.json(result);
}));

// Called every minute by an external cron service (and daily by Vercel Cron, see vercel.json)
app.get("/api/cron/mail", handle(async (req, res) => {
  if (CRON_SECRET) {
    const provided = req.query.key || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (provided !== CRON_SECRET) return res.status(401).json({ error: "Cron-Schlüssel fehlt oder ist falsch" });
  }
  res.json(await syncMailbox({ force: true, actor: "Cronjob" }));
}));

app.post("/api/leads", requireAuth, requireAdmin, handle(async (req, res) => {
  const { lead, assignee } = await updateStore((store) =>
    addLead(store, extractLeadFields(req.body || {}), { channel: "manuelle Erfassung", actor: actorName(req.user) })
  );
  res.status(201).json({ lead, assignedUser: publicUser(assignee) });
}));

app.patch("/api/leads/:id", requireAuth, handle(async (req, res) => {
  const outcome = await updateStore((store) => {
    const lead = store.leads.find((candidate) => candidate.id === req.params.id);
    if (!lead) return { status: 404, error: "Lead nicht gefunden" };
    if (req.user.role !== "admin" && lead.assignedTo !== req.user.id) {
      return { status: 403, error: "Kein Zugriff auf diesen Lead" };
    }
    const allowed = req.user.role === "admin" ? ["status", "assignedTo", "message"] : ["status", "message"];
    const userName = (id) => store.users.find((user) => user.id === id)?.name || "niemand";
    for (const key of allowed) {
      if (req.body[key] === undefined || req.body[key] === lead[key]) continue;
      const before = lead[key];
      lead[key] = req.body[key];
      const message =
        key === "status"
          ? `Status von „${lead.name}“: ${before} → ${lead.status}`
          : key === "assignedTo"
            ? `„${lead.name}“ neu zugewiesen: ${userName(before)} → ${userName(lead.assignedTo)}`
            : `Notiz von „${lead.name}“ geändert`;
      addLog(store, "lead", message, { actor: actorName(req.user), details: { leadId: lead.id } });
    }
    lead.updatedAt = nowIso();
    return { lead };
  });
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  res.json({ lead: outcome.lead });
}));

// Loads a lead the current user may work on, or returns an error outcome
function findAccessibleLead(store, user, leadId) {
  const lead = store.leads.find((candidate) => candidate.id === leadId);
  if (!lead) return { status: 404, error: "Lead nicht gefunden" };
  if (user.role !== "admin" && lead.assignedTo !== user.id) return { status: 403, error: "Kein Zugriff auf diesen Lead" };
  return { lead };
}

function sendOutcome(res, outcome, successStatus = 200) {
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  res.status(successStatus).json(outcome);
}

app.post("/api/leads/:id/notes", requireAuth, handle(async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Die Notiz ist leer" });
  if (text.length > 10000) return res.status(400).json({ error: "Die Notiz ist zu lang" });
  const outcome = await updateStore((store) => {
    const found = findAccessibleLead(store, req.user, req.params.id);
    if (found.error) return found;
    const note = { id: crypto.randomUUID(), at: nowIso(), authorId: req.user.id, authorName: req.user.name, text };
    found.lead.notes = [note, ...(found.lead.notes || [])];
    found.lead.updatedAt = nowIso();
    addLog(store, "lead", `Gesprächsnotiz zu „${found.lead.name}“ hinzugefügt`, { actor: actorName(req.user), details: { leadId: found.lead.id } });
    return { note, lead: found.lead };
  });
  sendOutcome(res, outcome, 201);
}));

app.delete("/api/leads/:id/notes/:noteId", requireAuth, handle(async (req, res) => {
  const outcome = await updateStore((store) => {
    const found = findAccessibleLead(store, req.user, req.params.id);
    if (found.error) return found;
    const note = (found.lead.notes || []).find((entry) => entry.id === req.params.noteId);
    if (!note) return { status: 404, error: "Notiz nicht gefunden" };
    if (req.user.role !== "admin" && note.authorId !== req.user.id) return { status: 403, error: "Nur eigene Notizen können gelöscht werden" };
    found.lead.notes = found.lead.notes.filter((entry) => entry.id !== note.id);
    addLog(store, "lead", `Gesprächsnotiz zu „${found.lead.name}“ gelöscht`, { actor: actorName(req.user), details: { leadId: found.lead.id, text: note.text } });
    return { lead: found.lead };
  });
  sendOutcome(res, outcome);
}));

const CONTACT_CHANNELS = { phone: "Anruf", whatsapp: "WhatsApp", email: "E-Mail", template: "Textbaustein kopiert" };

app.post("/api/leads/:id/contact", requireAuth, handle(async (req, res) => {
  const channel = CONTACT_CHANNELS[req.body?.channel];
  if (!channel) return res.status(400).json({ error: "Unbekannter Kontaktweg" });
  const outcome = await updateStore((store) => {
    const found = findAccessibleLead(store, req.user, req.params.id);
    if (found.error) return found;
    const suffix = req.body.template ? `: „${String(req.body.template).slice(0, 100)}“` : "";
    addLog(store, "contact", `${channel} bei „${found.lead.name}“${suffix}`, { actor: actorName(req.user), details: { leadId: found.lead.id } });
    return { ok: true };
  });
  sendOutcome(res, outcome);
}));

function templateInput(body) {
  const title = String(body?.title || "").trim();
  const text = String(body?.text || "").trim();
  if (!title || !text) return { error: "Titel und Text sind Pflicht" };
  if (title.length > 100 || text.length > 5000) return { error: "Titel oder Text ist zu lang" };
  return { title, text };
}

app.post("/api/templates", requireAuth, handle(async (req, res) => {
  const input = templateInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  const template = await updateStore((store) => {
    const created = { id: crypto.randomUUID(), ...input, createdBy: req.user.id, createdAt: nowIso(), updatedAt: nowIso() };
    store.templates.push(created);
    addLog(store, "template", `Textbaustein „${created.title}“ angelegt`, { actor: actorName(req.user) });
    return created;
  });
  res.status(201).json({ template });
}));

app.patch("/api/templates/:id", requireAuth, handle(async (req, res) => {
  const input = templateInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  const outcome = await updateStore((store) => {
    const template = store.templates.find((entry) => entry.id === req.params.id);
    if (!template) return { status: 404, error: "Textbaustein nicht gefunden" };
    Object.assign(template, input, { updatedAt: nowIso() });
    addLog(store, "template", `Textbaustein „${template.title}“ bearbeitet`, { actor: actorName(req.user) });
    return { template };
  });
  sendOutcome(res, outcome);
}));

app.delete("/api/templates/:id", requireAuth, handle(async (req, res) => {
  const outcome = await updateStore((store) => {
    const template = store.templates.find((entry) => entry.id === req.params.id);
    if (!template) return { status: 404, error: "Textbaustein nicht gefunden" };
    store.templates = store.templates.filter((entry) => entry.id !== template.id);
    addLog(store, "template", `Textbaustein „${template.title}“ gelöscht`, { actor: actorName(req.user), details: { text: template.text } });
    return { ok: true };
  });
  sendOutcome(res, outcome);
}));

app.post("/api/users", requireAuth, requireAdmin, handle(async (req, res) => {
  const { name, email, role = "sales", password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "Name, E-Mail und Passwort sind Pflicht" });
  if (String(password).length < 8) return res.status(400).json({ error: "Das Passwort muss mindestens 8 Zeichen haben" });
  const user = await updateStore((store) => {
    if (store.users.some((entry) => entry.email.toLowerCase() === String(email).toLowerCase())) return null;
    const created = {
      id: crypto.randomUUID(),
      name: String(name),
      email: String(email),
      role: role === "admin" ? "admin" : "sales",
      active: true,
      locked: false,
      order: Math.max(0, ...store.users.map((candidate) => Number(candidate.order || 0))) + 1,
      passwordHash: hashPassword(String(password)),
      createdAt: nowIso()
    };
    store.users.push(created);
    addLog(store, "team", `Nutzer „${created.name}“ (${created.email}) angelegt`, { actor: actorName(req.user) });
    return created;
  });
  if (!user) return res.status(409).json({ error: "Diese E-Mail existiert bereits" });
  res.status(201).json({ user: publicUser(user) });
}));

app.patch("/api/users/:id", requireAuth, requireAdmin, handle(async (req, res) => {
  const body = req.body || {};
  if (body.password !== undefined && String(body.password).length < 8) {
    return res.status(400).json({ error: "Das Passwort muss mindestens 8 Zeichen haben" });
  }
  const outcome = await updateStore((store) => {
    const target = store.users.find((candidate) => candidate.id === req.params.id);
    if (!target) return { status: 404, error: "Nutzer nicht gefunden" };
    const isSelf = target.id === req.user.id;
    if (isSelf && body.locked === true) return { status: 400, error: "Du kannst deinen eigenen Zugang nicht sperren" };
    if (isSelf && body.role && body.role !== "admin") return { status: 400, error: "Du kannst dir die Admin-Rechte nicht selbst entziehen" };
    if (body.email !== undefined) {
      const email = String(body.email).trim();
      if (!email) return { status: 400, error: "E-Mail darf nicht leer sein" };
      if (store.users.some((user) => user.id !== target.id && user.email.toLowerCase() === email.toLowerCase())) {
        return { status: 409, error: "Diese E-Mail existiert bereits" };
      }
      body.email = email;
    }
    if (body.name !== undefined && !String(body.name).trim()) return { status: 400, error: "Name darf nicht leer sein" };
    if (body.role !== undefined) body.role = body.role === "admin" ? "admin" : "sales";

    const previousNextUserId = rotationSnapshot(store).nextUserId;
    const changes = [];
    const labels = { name: "Name", email: "E-Mail", role: "Rolle", order: "Position" };
    for (const key of ["name", "email", "role", "active", "locked", "order"]) {
      if (body[key] === undefined || body[key] === target[key]) continue;
      if (key === "active") changes.push(body.active ? "in Rotation aufgenommen" : "aus Rotation genommen");
      else if (key === "locked") changes.push(body.locked ? "Zugang gesperrt" : "Zugang entsperrt");
      else changes.push(`${labels[key]}: ${target[key]} → ${body[key]}`);
      target[key] = key === "name" ? String(body[key]).trim() : body[key];
    }
    if (body.password) {
      target.passwordHash = hashPassword(String(body.password));
      changes.push("Passwort zurückgesetzt");
    }
    normalizeSalesOrder(store);
    const active = activeSalesUsers(store);
    const nextIndex = active.findIndex((candidate) => candidate.id === previousNextUserId);
    store.settings.rotationIndex = nextIndex >= 0 ? nextIndex : 0;
    if (changes.length) addLog(store, "team", `Nutzer „${target.name}“: ${changes.join(", ")}`, { actor: actorName(req.user) });
    return { user: target };
  });
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  res.json({ user: publicUser(outcome.user) });
}));

app.patch("/api/rotation", requireAuth, requireAdmin, handle(async (req, res) => {
  const { orderedUserIds, nextUserId } = req.body || {};
  if (!Array.isArray(orderedUserIds)) {
    return res.status(400).json({ error: "Reihenfolge fehlt" });
  }
  const store = await updateStore((store) => {
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
    const next = active[store.settings.rotationIndex];
    addLog(store, "team", `Rotation geändert: ${active.map((user) => user.name).join(" → ") || "leer"}; nächster Lead an ${next ? next.name : "niemand"}`, {
      actor: actorName(req.user)
    });
    return store;
  });
  res.json({ users: store.users.map(publicUser), rotation: rotationSnapshot(store) });
}));

app.post("/webhook/facebook", handle(async (req, res) => {
  const token = req.query.token || req.headers["x-webhook-token"];
  if (token !== WEBHOOK_TOKEN) {
    await updateStore((store) => addLog(store, "error", "Webhook-Aufruf mit falschem Token abgelehnt", { details: { ip: req.ip } }));
    return res.status(401).json({ error: "Webhook Token fehlt oder ist falsch" });
  }
  const { lead, assignee } = await updateStore((store) =>
    addLead(store, extractLeadFields(req.body || {}), { channel: "Webhook", actor: "Webhook" })
  );
  res.status(201).json({ ok: true, leadId: lead.id, assignedTo: assignee ? assignee.email : null });
}));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Facebook Lead Center läuft auf http://localhost:${PORT} (Speicher: ${STORAGE_MODE})`);
});
