// "My Health Reports" app: password login, a guard that keeps everything under
// public/MyHealthReports private, and the health-problems log API at
// /api/health (mirrored to Google Drive like the Bible data).
//
// The password lives in HEALTH_PASSWORD (.env); a successful login sets an
// HttpOnly cookie signed with a key derived from it, so changing the password
// signs every device out.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const HEALTH_PASSWORD = process.env.HEALTH_PASSWORD || '';
const HEALTH_DATA_FILE = process.env.HEALTH_DATA_FILE || './health-problems.json';
const HEALTH_DRIVE_FILE_NAME = process.env.HEALTH_DRIVE_FILE_NAME || 'health-problems.json';
const HEALTH_DRIVE_CSV_NAME = HEALTH_DRIVE_FILE_NAME.replace(/\.json$/i, '') + '.csv';
const COOKIE = 'health_session';
const SESSION_HOURS = 12;
const REMEMBER_DAYS = 30;
const PROTECTED_DIR = 'MyHealthReports';

// ---- Session ----------------------------------------------------------------
const sessionKey = crypto.createHash('sha256')
  .update(`health-session:${process.env.HEALTH_SESSION_SECRET || ''}:${HEALTH_PASSWORD}`)
  .digest();

function sign(exp) {
  return crypto.createHmac('sha256', sessionKey).update(String(exp)).digest('base64url');
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function isAuthed(req) {
  if (!HEALTH_PASSWORD) return false;
  const [exp, mac] = readCookie(req, COOKIE).split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const given = Buffer.from(mac);
  const expected = Buffer.from(sign(exp));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function setSessionCookie(req, res, maxAgeMs) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  const exp = Date.now() + maxAgeMs;
  res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`);
}

function passwordMatches(given) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(HEALTH_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// Max 8 wrong passwords per IP per 15 minutes.
const failedLogins = new Map();
function tooManyFailures(ip) {
  const now = Date.now();
  const recent = (failedLogins.get(ip) || []).filter((t) => now - t < 15 * 60_000);
  failedLogins.set(ip, recent);
  return recent.length >= 8;
}

// ---- Guard for /MyHealthReports --------------------------------------------
// Checks both the URL and the file it would resolve to, because Windows also
// opens "myhealthreports", "MyHealthReports." and 8.3 short names (MYHEAL~1).
function isProtectedPath(publicDir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return true;
  }
  const clean = path.posix.normalize(decoded.replace(/\\/g, '/')).toLowerCase();
  if (new RegExp(`^/*${PROTECTED_DIR.toLowerCase()}[.\\s]*(/|:|$)`).test(clean)) return true;
  try {
    const real = fs.realpathSync.native(path.join(publicDir, decoded));
    const root = fs.realpathSync.native(path.join(publicDir, PROTECTED_DIR));
    const rel = path.relative(root, real);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false; // doesn't exist: static will 404
  }
}

function makeGuard(publicDir) {
  return (req, res, next) => {
    if (!isProtectedPath(publicDir, req.path)) return next();
    res.setHeader('Cache-Control', 'no-store');
    if (isAuthed(req)) return next();
    if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') {
      return res.redirect(`/health.html?next=${encodeURIComponent(req.originalUrl)}`);
    }
    res.status(401).json({ error: 'Login required', needLogin: true });
  };
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'Login required', needLogin: true });
}

// ---- Problems store (local file + Google Drive mirror) ----------------------
const DEFAULT_CATEGORIES = [
  'Thyroid & hormones', 'Sugar, weight & metabolism', 'Digestion & gut', 'Muscles, joints & pain',
  'Head, memory & nerves', 'Eyes', 'Energy & sleep', 'Mood & stress', 'Heart & blood pressure',
  'Skin & hair', 'Breathing, nose & throat', 'Kidney & urine', 'Teeth & mouth', 'Fever & infection',
  'Medicine side-effect', 'Other',
];
const STATUSES = ['active', 'improving', 'recurring', 'watching', 'resolved'];
const FREQUENCIES = ['', 'once', 'constant', 'daily', 'few times a week', 'weekly', 'monthly', 'occasionally'];
const TIMES = ['', 'morning', 'afternoon', 'evening', 'night', 'after meals', 'after exercise', 'any time'];

const emptyState = () => ({ problems: [], categories: [...DEFAULT_CATEGORIES], updatedAt: 0 });

function dataPath() {
  return path.resolve(__dirname, HEALTH_DATA_FILE);
}

class StoreError extends Error {}

function withDefaults(data) {
  return {
    ...emptyState(),
    ...data,
    problems: Array.isArray(data.problems) ? data.problems : [],
    categories: Array.isArray(data.categories) && data.categories.length ? data.categories : [...DEFAULT_CATEGORIES],
  };
}

function loadState() {
  if (!fs.existsSync(dataPath())) return emptyState();
  try {
    return withDefaults(JSON.parse(fs.readFileSync(dataPath(), 'utf8')));
  } catch (err) {
    // Never fall back to an empty log here: the next save would wipe the real data.
    throw new StoreError(`Health data file ${dataPath()} is unreadable (${err.message}). `
      + 'Nothing was changed. Fix it or restore it from the .bak copy next to it.');
  }
}

function saveState(state) {
  const file = dataPath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(tmp, file);
}

let drive = { getClient: null, folderId: null };
let driveVersion = null;
let driveDirty = false;
let driveError = null;

function driveClient(folderId = drive.folderId) {
  if (!drive.getClient || !folderId) return null;
  try {
    return drive.getClient();
  } catch (err) {
    if (err.code === 'GOOGLE_AUTH_REQUIRED') return null;
    throw err;
  }
}

function driveStatus() {
  const connected = Boolean(driveClient());
  return { connected, ok: connected && !driveDirty && !driveError, error: driveError };
}

function noteDriveError(err) {
  driveError = err.response?.data?.error?.message || err.message || String(err);
  console.error('Health Drive sync error:', driveError);
}

async function findDriveFile(client, name) {
  const safe = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const res = await client.files.list({
    q: `name='${safe}' and '${drive.folderId}' in parents and trashed=false`,
    fields: 'files(id,version)',
    orderBy: 'modifiedTime desc',
    pageSize: 1,
    spaces: 'drive',
  });
  return res.data.files?.[0] || null;
}

async function pullFromDrive(client, local) {
  const file = await findDriveFile(client, HEALTH_DRIVE_FILE_NAME);
  if (!file) { driveDirty = true; return local; }
  if (file.version === driveVersion) return local;

  const res = await client.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'text' });
  let remote;
  try {
    remote = withDefaults(JSON.parse(res.data));
  } catch (err) {
    throw new Error(`${HEALTH_DRIVE_FILE_NAME} in Google Drive is unreadable (${err.message}) — fix or delete it there`);
  }
  // First look since this server started: keep whichever copy is newer.
  if (driveVersion === null && (local.updatedAt || 0) > (remote.updatedAt || 0)) {
    driveDirty = true;
    return local;
  }
  saveState(remote);
  driveVersion = file.version;
  driveDirty = false;
  return remote;
}

function csvCell(v) {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheets running it as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// A spreadsheet-friendly copy next to the JSON, so the log can be read in Drive.
function toCsv(state) {
  const head = ['Title', 'Category', 'Status', 'Severity (0-10)', 'Started', 'Frequency', 'Time of day', 'Body area',
    'Triggers', 'What helps', 'Medicines', 'Doctor / plan', 'Related markers', 'Tags', 'Notes', 'Log entries', 'Last update', 'Resolved on'];
  const rows = state.problems.map((p) => [
    p.title, p.category, p.status, p.severity, p.onset, p.frequency, p.timeOfDay, p.bodyArea,
    p.triggers, p.relievers, p.medicines, p.doctor, (p.markers || []).join(' '), (p.tags || []).join(' '), p.notes,
    (p.log || []).map((l) => `${l.date} [${l.severity}] ${l.note}`).join(' | '),
    new Date(p.updatedAt).toISOString().slice(0, 10), p.resolvedOn,
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

async function upsertDriveFile(client, name, mimeType, body) {
  const file = await findDriveFile(client, name);
  const media = { mimeType, body };
  return file
    ? client.files.update({ fileId: file.id, media, fields: 'id,version' })
    : client.files.create({ requestBody: { name, parents: [drive.folderId], mimeType }, media, fields: 'id,version' });
}

async function pushToDrive(client, state) {
  const res = await upsertDriveFile(client, HEALTH_DRIVE_FILE_NAME, 'application/json', JSON.stringify(state, null, 2));
  driveVersion = res.data.version;
  driveDirty = false;
  driveError = null;
  await upsertDriveFile(client, HEALTH_DRIVE_CSV_NAME, 'text/csv', toCsv(state)).catch(noteDriveError);
}

let queue = Promise.resolve();
function withState(mutate) {
  const run = queue.then(async () => {
    let state = loadState();
    const client = driveClient();
    let pulled = false;
    if (client) {
      try {
        state = await pullFromDrive(client, state);
        pulled = true;
        driveError = null;
      } catch (err) {
        noteDriveError(err);
      }
    }
    let result;
    if (mutate) {
      result = mutate(state);
      state.updatedAt = Date.now();
      saveState(state);
      driveDirty = true;
    }
    // Never push after a failed pull: that could overwrite newer data from another device.
    if (client && pulled && driveDirty) {
      await pushToDrive(client, state).catch(noteDriveError);
    }
    return { state, result };
  });
  queue = run.catch(() => {});
  return run;
}

// ---- Validation -------------------------------------------------------------
class BadRequest extends Error {}
const fail = (msg) => { throw new BadRequest(msg); };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s) => typeof s === 'string' && DATE_RE.test(s)
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const str = (v, max, field) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > max) fail(`${field} must be text up to ${max} characters`);
  return v.trim();
};
const optDate = (v, field) => {
  if (!v) return '';
  if (!isDate(v)) fail(`${field} must be YYYY-MM-DD`);
  return v;
};
const severity = (v, field) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10) fail(`${field} must be 0–10`);
  return n;
};
const list = (v, max, itemMax, field) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) fail(`${field} must be a list of up to ${max}`);
  return [...new Set(v.map((x) => str(x, itemMax, field)).filter(Boolean))];
};

function validProblem(p, categories) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) fail('problem must be an object');
  const title = str(p.title, 200, 'Title');
  if (!title) fail('Title is required');
  const category = str(p.category, 60, 'Category') || 'Other';
  if (!categories.includes(category)) fail(`Unknown category "${category}"`);
  const status = p.status || 'active';
  if (!STATUSES.includes(status)) fail('Invalid status');
  const frequency = p.frequency || '';
  if (!FREQUENCIES.includes(frequency)) fail('Invalid frequency');
  const timeOfDay = p.timeOfDay || '';
  if (!TIMES.includes(timeOfDay)) fail('Invalid time of day');
  const log = (Array.isArray(p.log) ? p.log : []).slice(0, 500).map((l) => {
    if (!l || !isDate(l.date)) fail('Each log entry needs a date');
    return {
      id: /^[a-z0-9-]{6,40}$/i.test(l.id) ? l.id : crypto.randomUUID(),
      date: l.date,
      severity: severity(l.severity, 'Log severity'),
      note: str(l.note, 2000, 'Log note'),
    };
  }).sort((a, b) => b.date.localeCompare(a.date));
  return {
    title,
    category,
    status,
    severity: severity(p.severity ?? 5, 'Severity'),
    onset: optDate(p.onset, 'Started on'),
    resolvedOn: status === 'resolved' ? (optDate(p.resolvedOn, 'Resolved on') || new Date().toISOString().slice(0, 10)) : '',
    frequency,
    timeOfDay,
    bodyArea: str(p.bodyArea, 120, 'Body area'),
    triggers: str(p.triggers, 2000, 'Triggers'),
    relievers: str(p.relievers, 2000, 'What helps'),
    medicines: str(p.medicines, 2000, 'Medicines'),
    doctor: str(p.doctor, 2000, 'Doctor / plan'),
    notes: str(p.notes, 10000, 'Notes'),
    markers: list(p.markers, 20, 30, 'Related markers'),
    tags: list(p.tags, 20, 40, 'Tags'),
    log,
  };
}

const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

const REPORT_FILE = /\.(pdf|md|png|jpe?g)$/i;

function listReportFiles(dir, base = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) return listReportFiles(path.join(dir, e.name), rel);
    if (!REPORT_FILE.test(e.name)) return [];
    const st = fs.statSync(path.join(dir, e.name));
    return [{ path: rel, folder: base || '', name: e.name, size: st.size, modified: st.mtime.toISOString() }];
  });
}

// ---- Reports folder in Google Drive -----------------------------------------
// HEALTH_REPORTS_FOLDER_ID mirrors public/MyHealthReports (pdf/, data/,
// guide.html, ...). Those files are gitignored, so on Render they only exist
// in Drive: anything missing from the local disk is streamed from there.
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const REPORTS_CACHE_MS = 60_000;
let reportsFolderId = '';
const folderCache = new Map(); // Drive folder id -> { at, files }

async function listDriveFolder(client, folderId) {
  const hit = folderCache.get(folderId);
  if (hit && Date.now() - hit.at < REPORTS_CACHE_MS) return hit.files;
  const files = [];
  let pageToken;
  do {
    const res = await client.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType,size,modifiedTime)',
      orderBy: 'modifiedTime desc', // duplicate names: the newest wins
      pageSize: 1000,
      pageToken,
      spaces: 'drive',
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  folderCache.set(folderId, { at: Date.now(), files });
  return files;
}

async function findDrivePath(client, segments) {
  let node = { id: reportsFolderId, mimeType: FOLDER_MIME };
  for (const name of segments) {
    if (node.mimeType !== FOLDER_MIME) return null;
    node = (await listDriveFolder(client, node.id)).find((f) => f.name === name);
    if (!node) return null;
  }
  return node;
}

async function listDriveReports(client, folderId, base = '') {
  const children = await listDriveFolder(client, folderId);
  const nested = await Promise.all(children.map(async (f) => {
    const rel = base ? `${base}/${f.name}` : f.name;
    if (f.mimeType === FOLDER_MIME) return listDriveReports(client, f.id, rel);
    if (!REPORT_FILE.test(f.name)) return [];
    return [{ path: rel, folder: base, name: f.name, size: Number(f.size || 0), modified: f.modifiedTime }];
  }));
  return nested.flat();
}

const driveMessage = (err) => err.response?.data?.error?.message || err.message || String(err);

// Mounted at /MyHealthReports after express.static, so it only sees files
// that aren't on disk; the guard has already checked the login.
async function serveFromDrive(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const client = driveClient(reportsFolderId);
  if (!client) return next();
  let segments;
  try {
    segments = decodeURIComponent(req.path).split('/').filter(Boolean);
  } catch {
    return next();
  }
  if (!segments.length || segments.some((s) => s === '.' || s === '..')) return next();
  try {
    const file = await findDrivePath(client, segments);
    if (!file || file.mimeType.startsWith('application/vnd.google-apps.')) return next();
    res.type(path.extname(file.name) || file.mimeType);
    if (file.size) res.setHeader('Content-Length', file.size);
    if (req.method === 'HEAD') return res.end();
    const media = await client.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'stream' });
    media.data.on('error', (err) => {
      console.error('Health Drive download error:', driveMessage(err));
      res.destroy(err);
    }).pipe(res);
  } catch (err) {
    console.error('Health Drive download error:', driveMessage(err));
    res.status(502).type('text').send(`Could not load this file from Google Drive: ${driveMessage(err)}`);
  }
}

// ---- Router -----------------------------------------------------------------
module.exports = function healthRoutes({ getDriveClient, folderId, reportsFolder, publicDir }) {
  drive = { getClient: getDriveClient, folderId };
  reportsFolderId = reportsFolder || '';
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  router.get('/session', (req, res) => {
    res.json({ authed: isAuthed(req), configured: Boolean(HEALTH_PASSWORD) });
  });

  router.post('/login', (req, res) => {
    if (!HEALTH_PASSWORD) {
      return res.status(503).json({ error: 'HEALTH_PASSWORD is not set on the server (.env).' });
    }
    if (tooManyFailures(req.ip)) {
      return res.status(429).json({ error: 'Too many wrong attempts. Try again in 15 minutes.' });
    }
    if (!passwordMatches(req.body?.password || '')) {
      failedLogins.get(req.ip).push(Date.now());
      return res.status(401).json({ error: 'Wrong password' });
    }
    failedLogins.delete(req.ip);
    setSessionCookie(req, res, req.body?.remember ? REMEMBER_DAYS * 864e5 : SESSION_HOURS * 3600e3);
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  router.use(requireAuth);

  // Drive's pdf/ folder plus any local-only files (the local copy wins on the
  // same path, matching how the files themselves are served).
  router.get('/reports', route(async (_req, res) => {
    const byPath = new Map();
    let error = null;
    const client = driveClient(reportsFolderId);
    if (client) {
      try {
        const pdf = await findDrivePath(client, ['pdf']);
        if (pdf?.mimeType === FOLDER_MIME) {
          for (const f of await listDriveReports(client, pdf.id)) byPath.set(f.path, f);
        }
      } catch (err) {
        error = `Google Drive: ${driveMessage(err)}`;
        console.error('Health reports listing error:', error);
      }
    }
    for (const f of listReportFiles(path.join(publicDir, PROTECTED_DIR, 'pdf'))) byPath.set(f.path, f);
    const files = [...byPath.values()]
      .map((f) => ({ ...f, url: `/${PROTECTED_DIR}/pdf/${f.path.split('/').map(encodeURIComponent).join('/')}` }));
    res.json({ files, drive: Boolean(client), error });
  }));

  router.get('/problems', route(async (_req, res) => {
    const { state } = await withState();
    res.json({
      problems: state.problems,
      categories: state.categories,
      statuses: STATUSES,
      frequencies: FREQUENCIES,
      times: TIMES,
      drive: driveStatus(),
    });
  }));

  // body: { problem } — creates (POST) or replaces (PUT /:id) one problem.
  router.post('/problems', route(async (req, res) => {
    const { result } = await withState((state) => {
      const p = validProblem(req.body?.problem, state.categories);
      const now = Date.now();
      const created = { id: crypto.randomUUID(), ...p, createdAt: now, updatedAt: now };
      state.problems.unshift(created);
      return created;
    });
    res.json({ ok: true, problem: result, drive: driveStatus() });
  }));

  router.put('/problems/:id', route(async (req, res) => {
    const { result } = await withState((state) => {
      const i = state.problems.findIndex((x) => x.id === req.params.id);
      if (i < 0) fail('That problem no longer exists (deleted on another device?)');
      const p = validProblem(req.body?.problem, state.categories);
      state.problems[i] = { ...state.problems[i], ...p, updatedAt: Date.now() };
      return state.problems[i];
    });
    res.json({ ok: true, problem: result, drive: driveStatus() });
  }));

  router.delete('/problems/:id', route(async (req, res) => {
    await withState((state) => {
      state.problems = state.problems.filter((x) => x.id !== req.params.id);
    });
    res.json({ ok: true, drive: driveStatus() });
  }));

  // body: { categories: [...] } — the full category list (rename/add/remove).
  router.put('/categories', route(async (req, res) => {
    const { result } = await withState((state) => {
      const cats = list(req.body?.categories, 60, 60, 'Categories');
      if (!cats.length) fail('Keep at least one category');
      const inUse = new Set(state.problems.map((p) => p.category));
      const missing = [...inUse].filter((c) => !cats.includes(c));
      if (missing.length) fail(`Still used by a problem: ${missing.join(', ')}`);
      state.categories = cats;
      return cats;
    });
    res.json({ ok: true, categories: result, drive: driveStatus() });
  }));

  router.post('/sync', route(async (_req, res) => {
    driveVersion = null; // force a fresh look at Drive
    const { state } = await withState();
    res.json({ problems: state.problems, categories: state.categories, drive: driveStatus() });
  }));

  router.use((err, _req, res, _next) => {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    if (err instanceof StoreError) return res.status(500).json({ error: err.message });
    console.error('Health API error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  });

  return { router, guard: makeGuard(publicDir), driveFiles: serveFromDrive };
};
