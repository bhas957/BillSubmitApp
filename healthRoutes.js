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
const multer = require('multer');
const { parse: parseCsv } = require('csv-parse/sync');
const records = require('./healthRecords');
const driveTree = require('./healthDrive');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const EXTRACT_MODEL = process.env.GEMINI_EXTRACT_MODEL || GEMINI_MODEL;
const ASK_MODEL = process.env.HEALTH_AI_MODEL || GEMINI_MODEL;
const AI_PER_MINUTE = Number(process.env.HEALTH_AI_PER_MINUTE || 8);
const AI_PER_DAY = Number(process.env.HEALTH_AI_PER_DAY || 100);

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

// Everything below is per person (`profile`), except profiles and gmail.
const DEFAULT_PROFILES = [{ id: 'me', name: 'Me', relation: 'self', sex: '', birthYear: null }];
const emptyState = () => ({
  problems: [],
  categories: [...DEFAULT_CATEGORIES],
  medications: [],
  measurements: [],
  reminders: [],
  profiles: DEFAULT_PROFILES.map((p) => ({ ...p })),
  visitNotes: {}, // profile -> { doctor, nextVisit, questions }
  gmail: { imported: {}, lastRun: null, lastResult: null },
  updatedAt: 0,
});

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
    medications: Array.isArray(data.medications) ? data.medications : [],
    measurements: Array.isArray(data.measurements) ? data.measurements : [],
    reminders: Array.isArray(data.reminders) ? data.reminders : [],
    profiles: Array.isArray(data.profiles) && data.profiles.some((p) => p.id === 'me') ? data.profiles : DEFAULT_PROFILES.map((p) => ({ ...p })),
    visitNotes: data.visitNotes && typeof data.visitNotes === 'object' ? data.visitNotes : {},
    gmail: { imported: {}, lastRun: null, lastResult: null, ...(data.gmail || {}) },
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

const obj = (v, what) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${what} must be an object`);
  return v;
};
const optNum = (v, min, max, field) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(`${field} must be a number from ${min} to ${max}`);
  return n;
};
const oneOf = (v, options, field) => {
  const s = v ?? options[0];
  if (!options.includes(s)) fail(`Invalid ${field}`);
  return s;
};
const markerKeys = (v) => list(v, 30, 30, 'Tests').filter((k) => records.MARKERS.some((m) => m.key === k));
const PROFILE_ID = /^[a-z0-9-]{1,30}$/;

const MED_KINDS = ['medicine', 'supplement'];
function validMedication(m) {
  obj(m, 'medicine');
  const name = str(m.name, 120, 'Name');
  if (!name) fail('Name is required');
  const startedOn = optDate(m.startedOn, 'Started on');
  const stoppedOn = optDate(m.stoppedOn, 'Stopped on');
  if (startedOn && stoppedOn && stoppedOn < startedOn) fail('Stopped date is before the start date');
  return {
    name,
    kind: oneOf(m.kind, MED_KINDS, 'type'),
    dose: str(m.dose, 120, 'Dose'),
    frequency: str(m.frequency, 120, 'How often'),
    reason: str(m.reason, 300, 'Reason'),
    prescribedBy: str(m.prescribedBy, 120, 'Prescribed by'),
    startedOn,
    stoppedOn,
    markers: markerKeys(m.markers),
    notes: str(m.notes, 4000, 'Notes'),
  };
}

// One row per date; any metric may be blank.
const METRICS = {
  weight: [10, 400, 'Weight (kg)'], waist: [30, 250, 'Waist (cm)'], bpSys: [50, 260, 'BP systolic'], bpDia: [30, 180, 'BP diastolic'],
  pulse: [20, 250, 'Pulse'], sleepHours: [0, 24, 'Sleep (hours)'], steps: [0, 200000, 'Steps'], glucose: [20, 600, 'Glucose (mg/dL)'],
  bodyFat: [2, 75, 'Body fat (%)'],
};
function validMeasurement(x) {
  obj(x, 'measurement');
  if (!isDate(x.date)) fail('Date must be YYYY-MM-DD');
  const out = { date: x.date, note: str(x.note, 500, 'Note') };
  for (const [k, [min, max, label]] of Object.entries(METRICS)) out[k] = optNum(x[k], min, max, label);
  if (Object.keys(METRICS).every((k) => out[k] == null)) fail('Enter at least one measurement');
  return out;
}

function validReminder(r) {
  obj(r, 'reminder');
  const title = str(r.title, 200, 'Title');
  if (!title) fail('Title is required');
  if (!isDate(r.due)) fail('Due date must be YYYY-MM-DD');
  return { title, due: r.due, markers: markerKeys(r.markers), notes: str(r.notes, 2000, 'Notes'), done: Boolean(r.done) };
}

function validProfile(p) {
  obj(p, 'person');
  const name = str(p.name, 80, 'Name');
  if (!name) fail('Name is required');
  const birthYear = optNum(p.birthYear, 1900, new Date().getFullYear(), 'Birth year');
  return { name, relation: str(p.relation, 40, 'Relation'), sex: oneOf(p.sex || '', ['', 'male', 'female', 'other'], 'sex'), birthYear };
}

function validVisitNotes(v) {
  obj(v, 'visit notes');
  return { doctor: str(v.doctor, 200, 'Doctor'), nextVisit: optDate(v.nextVisit, 'Next visit'), questions: str(v.questions, 8000, 'Questions') };
}

// Hand corrections to a parsed report (see healthRecords.js `edits`).
function validRecordEdits(e, profiles) {
  obj(e, 'edits');
  const out = {};
  const set = (k, v) => { if (v !== '' && v !== null && v !== undefined) out[k] = v; };
  set('title', str(e.title, 120, 'Title'));
  set('date', optDate(e.date, 'Date'));
  if (e.collectedTime && !/^\d{2}:\d{2}$/.test(e.collectedTime)) fail('Time must be HH:MM');
  set('collectedTime', e.collectedTime);
  set('provider', str(e.provider, 80, 'Provider'));
  set('orderedVia', str(e.orderedVia, 80, 'Ordered via'));
  set('orderId', str(e.orderId, 40, 'Order id'));
  if (e.type) set('type', oneOf(e.type, ['lab', 'imaging', 'cardiac', 'other'], 'type'));
  if (e.status) set('status', oneOf(e.status, ['final', 'interim'], 'status'));
  if (e.profile) {
    if (!profiles.some((p) => p.id === e.profile)) fail('Unknown person');
    set('profile', e.profile);
  }
  if (e.reviewed) set('reviewed', isDate(e.reviewed) ? e.reviewed : new Date().toISOString().slice(0, 10));
  if (e.values !== undefined) {
    obj(e.values, 'values');
    const values = {};
    for (const [k, v] of Object.entries(e.values)) {
      if (!records.MARKERS.some((m) => m.key === k && !m.derived)) fail(`Unknown test "${k}"`);
      values[k] = v === null ? null : optNum(v, -1e9, 1e9, k);
    }
    if (Object.keys(values).length) out.values = values;
  }
  return out;
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
let reportsFolderId = '';
let tree = driveTree('');

async function findDrivePath(client, segments) {
  return tree.find(client, segments);
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

// ---- Parsed report records ------------------------------------------------------
// data/health-records.json (see healthRecords.js) lives next to the PDFs: on
// disk locally, in the Drive reports folder on Render. Uploads write both.
let reportsDir = '';
const RECORDS_CACHE_MS = 60_000;
let combinedCache = null; // { at, data }

async function loadCombined() {
  if (combinedCache && Date.now() - combinedCache.at < RECORDS_CACHE_MS) return combinedCache.data;
  const local = path.join(reportsDir, 'data', 'health-records.json');
  let data = null;
  if (fs.existsSync(local)) {
    data = JSON.parse(fs.readFileSync(local, 'utf8'));
  } else {
    const client = driveClient(reportsFolderId);
    const file = client && await tree.find(client, ['data', 'health-records.json']);
    if (file) data = (await client.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'json' })).data;
  }
  data = data && data.schema === records.SCHEMA ? data : records.buildCombined([]);
  combinedCache = { at: Date.now(), data };
  return data;
}

// Writes a file under public/MyHealthReports locally (when possible) and in Drive (when connected).
async function writeReportFile(rel, mimeType, body) {
  const where = [];
  try {
    const abs = path.join(reportsDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    where.push('disk');
  } catch (err) {
    console.error(`Health: could not write ${rel} locally:`, err.message);
  }
  const client = driveClient(reportsFolderId);
  if (client) {
    await tree.put(client, rel.split('/'), mimeType, Buffer.isBuffer(body) ? body : Buffer.from(body));
    where.push('drive');
  }
  return where;
}

const UPLOAD_TYPES = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, Boolean(UPLOAD_TYPES[file.mimetype])),
});

const PDF_PASSWORDS = (process.env.HEALTH_PDF_PASSWORDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const gemini = () => (GEMINI_API_KEY ? { apiKey: GEMINI_API_KEY, model: EXTRACT_MODEL } : null);

async function saveCombined(next) {
  await writeReportFile('data/health-records.json', 'application/json', JSON.stringify(next, null, 2));
  await writeReportFile('data/health-data.json', 'application/json', JSON.stringify(records.buildChartData(next, 'me'), null, 2));
  combinedCache = { at: Date.now(), data: next };
  tree.clearCache();
}

// Record JSON as parsed (without edits applied): local copy first, then Drive.
async function readRawRecord(id) {
  if (!/^[\w .&()+,-]{1,200}$/.test(id)) fail('Bad report id');
  const local = path.join(reportsDir, 'data', 'records', `${id}.json`);
  if (fs.existsSync(local)) return JSON.parse(fs.readFileSync(local, 'utf8'));
  const client = driveClient(reportsFolderId);
  const file = client && await tree.find(client, ['data', 'records', `${id}.json`]);
  if (file) return (await client.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'json' })).data;
  const fromCombined = (await loadCombined()).reports.find((r) => r.id === id);
  if (!fromCombined) fail('That report no longer exists');
  return fromCombined; // already has edits applied; applying them again is harmless
}

async function removeReportFile(rel) {
  fs.rmSync(path.join(reportsDir, ...rel.split('/')), { force: true });
  const client = driveClient(reportsFolderId);
  const file = client && await tree.find(client, rel.split('/'));
  if (file) await client.files.update({ fileId: file.id, requestBody: { trashed: true } });
}

// Moves the report file to `to` (both relative to pdf/), on disk and in Drive.
async function moveReportFile(from, to) {
  const src = path.join(reportsDir, 'pdf', ...from.split('/'));
  if (fs.existsSync(src)) {
    const dst = path.join(reportsDir, 'pdf', ...to.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
  }
  const client = driveClient(reportsFolderId);
  const file = client && await tree.find(client, ['pdf', ...from.split('/')]);
  if (file) await tree.move(client, file, ['pdf', ...to.split('/')]);
}

// The family member whose name appears in the report's patient name, else `fallback`.
// Words in the owner's own name (a shared surname) don't count as a match.
const nameWords = (s) => String(s || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
function matchProfile(profiles, patientName, fallback, ownerName) {
  const own = new Set([...nameWords(ownerName), ...nameWords(profiles.find((p) => p.id === 'me')?.name)]);
  const words = nameWords(patientName);
  const hit = profiles.find((p) => p.id !== 'me' && nameWords(p.name).some((w) => !own.has(w) && words.includes(w)));
  return hit ? hit.id : fallback;
}

let uploadQueue = Promise.resolve();
// options: { profile, autoProfile, source }
function ingestReport(buffer, originalName, mimeType, { profile = 'me', autoProfile = false, source } = {}) {
  const run = uploadQueue.then(async () => {
    combinedCache = null;
    const combined = await loadCombined();
    const sha = records.sha256(buffer);
    const dupe = combined.reports.find((r) => r.sha256 === sha);
    if (dupe) return { duplicate: true, record: dupe };

    const parsed = await records.parseReport({ buffer, fileName: originalName, mimeType, gemini: gemini(), passwords: PDF_PASSWORDS, profile });
    if (autoProfile) {
      const { state } = await withState();
      parsed.profile = matchProfile(state.profiles, parsed.patient?.name, profile, records.forProfile(combined, 'me').patient?.name);
    }
    let { folder, name } = records.canonicalPath(parsed, UPLOAD_TYPES[mimeType]);
    const taken = new Set(combined.reports.map((r) => r.file));
    for (let i = 2; taken.has(`${folder}/${name}`); i++) name = name.replace(/(-\d+)?(\.[^.]+)$/, `-${i}$2`);
    const rec = { ...parsed, id: name.replace(/\.[^.]+$/, ''), file: `${folder}/${name}`, originalName, source };

    const savedTo = await writeReportFile(`pdf/${rec.file}`, mimeType, buffer);
    await writeReportFile(`data/records/${rec.id}.json`, 'application/json', `${JSON.stringify(rec, null, 2)}\n`);
    const next = records.buildCombined([...combined.reports, rec]);
    await saveCombined(next);
    return { record: next.reports.find((r) => r.id === rec.id), changes: records.changesFor(next, rec.id), savedTo };
  });
  uploadQueue = run.catch(() => {});
  return run;
}

// Applies hand corrections; renames the file when its date/provider/title/person changed.
function editRecord(id, edits, locked) {
  const run = uploadQueue.then(async () => {
    combinedCache = null;
    const combined = await loadCombined();
    const raw = await readRawRecord(id);
    raw.edits = edits;
    if (locked !== undefined) raw.locked = Boolean(locked);
    const ext = path.extname(raw.file) || '.pdf';
    let { folder, name } = records.canonicalPath(raw, ext);
    const taken = new Set(combined.reports.filter((r) => r.id !== id).map((r) => r.file));
    for (let i = 2; taken.has(`${folder}/${name}`); i++) name = name.replace(/(-\d+)?(\.[^.]+)$/, `-${i}$2`);
    const file = `${folder}/${name}`;
    if (file !== raw.file) {
      await moveReportFile(raw.file, file);
      raw.file = file;
      raw.id = name.slice(0, -ext.length);
    }
    await writeReportFile(`data/records/${raw.id}.json`, 'application/json', `${JSON.stringify(raw, null, 2)}\n`);
    if (raw.id !== id) await removeReportFile(`data/records/${id}.json`);
    const next = records.buildCombined([...combined.reports.filter((r) => r.id !== id), raw]);
    await saveCombined(next);
    return next.reports.find((r) => r.id === raw.id);
  });
  uploadQueue = run.catch(() => {});
  return run;
}

// ---- Gmail import ----------------------------------------------------------------
// Lab and hospital emails with PDF reports. Each attachment is checked for
// medical wording before any AI call, and de-duplicated by content.
const GMAIL_QUERY = process.env.HEALTH_GMAIL_QUERY || 'has:attachment filename:pdf ('
  + 'from:(thyrocare.com OR pharmeasy.in OR apollo247.com OR apollohl.com OR apollodiagnostics.in OR healthians.com OR '
  + 'redcliffelabs.com OR 1mg.com OR lalpathlabs.com OR metropolisindia.com OR srl.in OR orangehealth.in OR '
  + 'neubergdiagnostics.com OR evenhealthcare.com OR practo.com OR mfine.co) OR '
  + 'subject:("lab report" OR "test report" OR "health report" OR "diagnostic report" OR "reports are ready" OR "report is ready" OR "health checkup"))';
const GMAIL_SYNC_HOURS = Number(process.env.HEALTH_GMAIL_SYNC_HOURS ?? 12);
let getGmail = null;
let gmailRunning = null;

function pdfParts(payload, out = []) {
  if (!payload) return out;
  if (payload.body?.attachmentId && (/pdf/i.test(payload.mimeType || '') || /\.pdf$/i.test(payload.filename || ''))) out.push(payload);
  for (const p of payload.parts || []) pdfParts(p, out);
  return out;
}

async function importFromGmail({ days = 400 } = {}) {
  if (gmailRunning) return gmailRunning;
  gmailRunning = (async () => {
    const gmail = getGmail();
    const { state } = await withState();
    const done = state.gmail.imported || {};
    const ids = [];
    let pageToken;
    do {
      const res = await gmail.users.messages.list({ userId: 'me', q: `${GMAIL_QUERY} newer_than:${days}d`, maxResults: 100, pageToken });
      ids.push(...(res.data.messages || []).map((m) => m.id));
      pageToken = res.data.nextPageToken;
    } while (pageToken && ids.length < 300);

    const result = { scanned: ids.length, imported: [], duplicates: 0, notMedical: 0, needPassword: [], errors: [] };
    const marks = {};
    for (const id of ids) {
      if (done[id] && !['password', 'error'].includes(done[id].status)) continue;
      const msg = (await gmail.users.messages.get({ userId: 'me', id, format: 'full' })).data;
      const header = (n) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === n)?.value || '';
      const source = { gmail: { id, from: header('from'), subject: header('subject'), date: header('date') } };
      let status = 'skipped';
      for (const part of pdfParts(msg.payload)) {
        try {
          const att = await gmail.users.messages.attachments.get({ userId: 'me', messageId: id, id: part.body.attachmentId });
          const buffer = Buffer.from(att.data.data, 'base64');
          const { text } = await records.readPdf(buffer, PDF_PASSWORDS);
          if (!records.looksMedical(text)) { result.notMedical++; continue; }
          const out = await ingestReport(buffer, part.filename || 'report.pdf', 'application/pdf', { autoProfile: true, source });
          if (out.duplicate) { result.duplicates++; status = 'duplicate'; continue; }
          result.imported.push({ file: out.record.file, date: out.record.date, provider: out.record.provider, warnings: out.record.warnings, changes: out.changes });
          status = 'imported';
        } catch (err) {
          if (err.code === 'PDF_PASSWORD') {
            result.needPassword.push(`${source.gmail.subject} (${part.filename})`);
            status = 'password';
          } else {
            if (/invalid_grant|insufficient|unauthorized/i.test(err.message)) throw err;
            result.errors.push(`${source.gmail.subject}: ${err.message}`);
            status = 'error';
          }
        }
      }
      marks[id] = { status, at: new Date().toISOString(), subject: source.gmail.subject.slice(0, 120) };
    }
    await withState((st) => {
      st.gmail.imported = { ...st.gmail.imported, ...marks };
      const keys = Object.keys(st.gmail.imported);
      for (const k of keys.slice(0, Math.max(0, keys.length - 3000))) delete st.gmail.imported[k];
      st.gmail.lastRun = new Date().toISOString();
      st.gmail.lastResult = { ...result, imported: result.imported.map((x) => x.file) };
    });
    return result;
  })();
  try {
    return await gmailRunning;
  } finally {
    gmailRunning = null;
  }
}

// ---- Google Calendar reminders -------------------------------------------------------
let getCalendar = null;
async function addToCalendar(reminder, personName) {
  const cal = getCalendar();
  const next = new Date(`${reminder.due}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const event = {
    summary: `${reminder.title}${personName ? ` (${personName})` : ''}`,
    description: `${reminder.notes || ''}\n\nFrom My Health Reports.`.trim(),
    start: { date: reminder.due },
    end: { date: next.toISOString().slice(0, 10) },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 3 * 24 * 60 }, { method: 'email', minutes: 7 * 24 * 60 }] },
  };
  const res = reminder.calendarEventId
    ? await cal.events.update({ calendarId: 'primary', eventId: reminder.calendarEventId, requestBody: event })
    : await cal.events.insert({ calendarId: 'primary', requestBody: event });
  return { calendarEventId: res.data.id, calendarLink: res.data.htmlLink };
}

const googleAuthMessage = (err) => /invalid_grant|insufficient|unauthorized|invalid_token|Login Required/i.test(`${err.code} ${err.message} ${JSON.stringify(err.response?.data || '')}`);

// ---- Ask AI ------------------------------------------------------------------------
const ASK_SYSTEM = `You are a careful personal health-records assistant for one person (the user).
You are given their complete health records as JSON: every lab report over the years
(markerTrends already converted to one unit per test, with normal ranges), scan and
cardiac reports, their own log of health problems and symptoms, the medicines and
supplements they take (with start/stop dates) and body measurements (weight, waist,
blood pressure, sleep...). When asked whether something worked, compare readings before
and after its start date, and say when other changes or lab/time-of-day differences
could explain the difference.

How to answer:
- Answer from the records. Quote exact values with their dates and the normal range, and
  describe the trend when there are several readings. Mention which lab, if labs disagree.
- If the records don't contain what is needed, say so plainly and name the test or
  information that would answer it.
- You may explain what results commonly mean and give general, evidence-based diet,
  exercise and lifestyle guidance. Do not diagnose and do not tell them to start, stop or
  change any medicine or dose: suggest what to ask their doctor instead.
- If the question describes possibly urgent symptoms (chest pain, breathlessness,
  fainting, sudden weakness, severe pain, blood in stool/urine...), first tell them to get
  medical care now.
- Write in plain, simple English. Short paragraphs or bullet points, Markdown, key numbers
  in bold. Keep it under about 350 words unless they ask for detail.
- End with one line: "Based on:" followed by the report dates you used.`;

const aiCalls = new Map(); // ip -> timestamps
let aiDay = { day: '', count: 0 };
function aiLimited(ip) {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  if (aiDay.day !== today) aiDay = { day: today, count: 0 };
  if (aiDay.count >= AI_PER_DAY) return `Daily limit of ${AI_PER_DAY} AI questions reached. Try again tomorrow.`;
  const recent = (aiCalls.get(ip) || []).filter((t) => now - t < 60_000);
  if (recent.length >= AI_PER_MINUTE) return 'Too many questions in a minute. Wait a moment.';
  recent.push(now);
  aiCalls.set(ip, recent);
  aiDay.count++;
  return null;
}

async function askGemini(question, history, context) {
  const contents = [
    ...history.map((h) => ({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: question }] },
  ];
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ASK_MODEL)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: `${ASK_SYSTEM}\n\n<health_records>\n${JSON.stringify(context)}\n</health_records>` }] },
      contents,
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `Gemini request failed (HTTP ${res.status})`);
  const answer = (body.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
  if (!answer) throw new Error(`Gemini returned no answer (${body.promptFeedback?.blockReason || body.candidates?.[0]?.finishReason || 'empty reply'})`);
  return answer;
}

// ---- Router -----------------------------------------------------------------
module.exports = function healthRoutes({ getDriveClient, getGmailClient, getCalendarClient, folderId, reportsFolder, publicDir }) {
  drive = { getClient: getDriveClient, folderId };
  reportsFolderId = reportsFolder || '';
  tree = driveTree(reportsFolderId);
  reportsDir = path.join(publicDir, PROTECTED_DIR);
  getGmail = getGmailClient || null;
  getCalendar = getCalendarClient || null;

  // Background Gmail import every HEALTH_GMAIL_SYNC_HOURS (0 turns it off).
  if (getGmail && GMAIL_SYNC_HOURS > 0) {
    const tick = () => importFromGmail({ days: 60 })
      .then((r) => { if (r.imported.length) console.log(`Health: imported ${r.imported.length} report(s) from Gmail`); })
      .catch((err) => { if (err.code !== 'GOOGLE_AUTH_REQUIRED') console.error('Health Gmail import:', err.message); });
    setTimeout(tick, 2 * 60_000).unref();
    setInterval(tick, GMAIL_SYNC_HOURS * 3600_000).unref();
  }
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

  // Every page sends ?profile=<id> (health.js); default is the account owner.
  router.use((req, _res, next) => {
    const p = String(req.query.profile || 'me');
    req.profile = PROFILE_ID.test(p) ? p : 'me';
    next();
  });
  const mine = (req) => (x) => (x.profile || 'me') === req.profile;
  const profileOf = (state, id) => state.profiles.find((p) => p.id === id) || state.profiles[0];

  // Drive's pdf/ folder plus any local-only files (the local copy wins on the
  // same path, matching how the files themselves are served).
  router.get('/reports', route(async (req, res) => {
    const byPath = new Map();
    let error = null;
    const client = driveClient(reportsFolderId);
    if (client) {
      try {
        for (const f of await tree.walk(client, ['pdf'])) {
          if (!REPORT_FILE.test(f.name)) continue;
          const rel = f.path.slice('pdf/'.length);
          byPath.set(rel, { path: rel, folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '', name: f.name, size: Number(f.size || 0), modified: f.modifiedTime });
        }
      } catch (err) {
        error = `Google Drive: ${driveMessage(err)}`;
        console.error('Health reports listing error:', error);
      }
    }
    for (const f of listReportFiles(path.join(publicDir, PROTECTED_DIR, 'pdf'))) byPath.set(f.path, f);
    const byFile = new Map(((await loadCombined().catch(() => null))?.reports || []).map((r) => [r.file, r]));
    const files = [...byPath.values()]
      .filter((f) => (byFile.get(f.path)?.profile || records.profileFromPath(f.path)) === req.profile)
      .map((f) => {
        const r = byFile.get(f.path);
        return {
          ...f,
          url: `/${PROTECTED_DIR}/pdf/${f.path.split('/').map(encodeURIComponent).join('/')}`,
          record: r && {
            id: r.id, date: r.date, type: r.type, provider: r.provider, title: r.title, status: r.status, summary: r.summary,
            warnings: r.warnings?.length || 0, unverified: (r.results || []).filter((x) => x.verified === false).length, reviewed: r.reviewed || null,
          },
        };
      });
    res.json({ files, drive: Boolean(client), error });
  }));

  router.get('/problems', route(async (req, res) => {
    const { state } = await withState();
    res.json({
      problems: state.problems.filter(mine(req)),
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
      const created = { id: crypto.randomUUID(), profile: req.profile, ...p, createdAt: now, updatedAt: now };
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

  // The AI context for the current person (also what ?ai=1 shows).
  async function contextFor(req) {
    const { state } = await withState();
    return records.aiContext(records.forProfile(await loadCombined(), req.profile), state.problems.filter(mine(req)), {
      medications: state.medications.filter(mine(req)),
      measurements: state.measurements.filter(mine(req)),
      profile: profileOf(state, req.profile),
    });
  }

  // One person's parsed reports (edits applied). ?ai=1 returns the compact form the AI sees.
  router.get('/records', route(async (req, res) => {
    if (req.query.ai) return res.json(await contextFor(req));
    res.json({ ...records.forProfile(await loadCombined(), req.profile), aiConfigured: Boolean(GEMINI_API_KEY) });
  }));

  // One report: the record with edits applied, the raw edits, and what changed since the previous test.
  router.get('/records/:id', route(async (req, res) => {
    const combined = await loadCombined();
    const rec = combined.reports.find((r) => r.id === req.params.id);
    if (!rec) return res.status(404).json({ error: 'Report not found' });
    const raw = await readRawRecord(rec.id).catch(() => null);
    const parsed = raw ? { ...Object.fromEntries(records.EDITABLE.map((k) => [k, raw[k] ?? null])), profile: raw.profile || 'me' } : null;
    const { state } = await withState();
    res.json({ record: rec, parsed, changes: records.changesFor(combined, rec.id), markers: combined.markers, profiles: state.profiles });
  }));

  // body: { edits: {...}, locked? } — replaces the record's hand corrections.
  router.put('/records/:id', route(async (req, res) => {
    const { state } = await withState();
    const edits = validRecordEdits(req.body?.edits || {}, state.profiles);
    const record = await editRecord(req.params.id, edits, req.body?.locked);
    res.json({ ok: true, record, changes: records.changesFor(await loadCombined(), record.id) });
  }));

  // Chart data (what compare.html draws) for the current person.
  router.get('/chart-data', route(async (req, res) => {
    res.json(records.buildChartData(await loadCombined(), req.profile));
  }));

  // What changed in the person's latest blood test.
  router.get('/changes/latest', route(async (req, res) => {
    const combined = await loadCombined();
    const latest = records.forProfile(combined, req.profile).reports.filter((r) => r.type === 'lab' && Object.keys(r.values || {}).length).pop();
    res.json({ changes: latest ? records.changesFor(combined, latest.id) : null });
  }));

  // Standard HL7 FHIR R4 bundle (Patient + DiagnosticReport + Observation, LOINC codes)
  // for importing into other health apps or handing to a hospital.
  router.get('/export/fhir', route(async (req, res) => {
    const bundle = records.toFhirBundle(records.forProfile(await loadCombined(), req.profile));
    res.setHeader('Content-Disposition', `attachment; filename="health-records-fhir-${req.profile}-${new Date().toISOString().slice(0, 10)}.json"`);
    res.type('application/fhir+json').send(JSON.stringify(bundle, null, 2));
  }));

  // multipart field "file": PDF / PNG / JPG. Parses, names, stores and indexes it.
  router.post('/upload', (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 25 MB' : err.message });
    if (!req.file) return res.status(400).json({ error: 'Choose a PDF, PNG or JPG report' });
    next();
  }), route(async (req, res) => {
    const out = await ingestReport(req.file.buffer, path.basename(req.file.originalname || 'report'), req.file.mimetype, { profile: req.profile });
    res.json({ ok: true, ...out, aiParsed: Boolean(GEMINI_API_KEY) });
  }));

  // body: { question, history: [{ role: 'user'|'model', text }] }
  router.post('/ask', route(async (req, res) => {
    if (!GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY is not set in .env — add it and restart the server.' });
    const question = str(req.body?.question, 4000, 'Question');
    if (!question) fail('Type a question');
    const history = (Array.isArray(req.body?.history) ? req.body.history : []).slice(-12)
      .map((h) => ({ role: h?.role === 'model' ? 'model' : 'user', text: str(h?.text, 12000, 'History') }))
      .filter((h) => h.text);
    const limited = aiLimited(req.ip);
    if (limited) return res.status(429).json({ error: limited });
    const context = await contextFor(req);
    try {
      res.json({ answer: await askGemini(question, history, context), model: ASK_MODEL });
    } catch (err) {
      console.error('Health AI error:', err.message);
      res.status(502).json({ error: err.message });
    }
  }));

  router.post('/sync', route(async (req, res) => {
    driveVersion = null; // force a fresh look at Drive
    const { state } = await withState();
    res.json({ problems: state.problems.filter(mine(req)), categories: state.categories, drive: driveStatus() });
  }));

  // ---- People (family profiles) ----
  router.get('/profiles', route(async (_req, res) => {
    const { state } = await withState();
    res.json({ profiles: state.profiles });
  }));

  router.post('/profiles', route(async (req, res) => {
    const { result } = await withState((state) => {
      const p = validProfile(req.body?.profile);
      let id = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'person';
      for (let i = 2; state.profiles.some((x) => x.id === id) || id === 'me'; i++) id = `${id.replace(/-\d+$/, '')}-${i}`;
      const created = { id, ...p };
      state.profiles.push(created);
      return created;
    });
    res.json({ ok: true, profile: result });
  }));

  router.put('/profiles/:id', route(async (req, res) => {
    const { result } = await withState((state) => {
      const i = state.profiles.findIndex((x) => x.id === req.params.id);
      if (i < 0) fail('That person no longer exists');
      state.profiles[i] = { ...state.profiles[i], ...validProfile(req.body?.profile) };
      return state.profiles[i];
    });
    res.json({ ok: true, profile: result });
  }));

  router.delete('/profiles/:id', route(async (req, res) => {
    const id = req.params.id;
    if (id === 'me') fail('You can\'t remove yourself');
    const combined = await loadCombined();
    if (combined.reports.some((r) => r.profile === id)) fail('Move or delete this person\'s reports first');
    await withState((state) => {
      const used = ['problems', 'medications', 'measurements', 'reminders'].filter((k) => state[k].some((x) => x.profile === id));
      if (used.length) fail(`This person still has ${used.join(', ')}. Delete those first.`);
      state.profiles = state.profiles.filter((p) => p.id !== id);
      delete state.visitNotes[id];
    });
    res.json({ ok: true });
  }));

  // ---- Medicines, measurements, reminders: same CRUD shape, per person ----
  const COLLECTIONS = { medications: validMedication, measurements: validMeasurement, reminders: validReminder };
  router.get('/tracking', route(async (req, res) => {
    const { state } = await withState();
    const out = { profiles: state.profiles, profile: profileOf(state, req.profile), metrics: METRICS, drive: driveStatus() };
    for (const k of Object.keys(COLLECTIONS)) out[k] = state[k].filter(mine(req));
    out.measurements.sort((a, b) => a.date.localeCompare(b.date));
    out.reminders.sort((a, b) => a.due.localeCompare(b.due));
    res.json(out);
  }));

  for (const [name, valid] of Object.entries(COLLECTIONS)) {
    router.post(`/${name}`, route(async (req, res) => {
      const { result } = await withState((state) => {
        const item = valid(req.body?.item);
        // One measurements row per date: merge into an existing one.
        if (name === 'measurements') {
          const same = state.measurements.find((x) => x.profile === req.profile && x.date === item.date);
          if (same) {
            for (const [k, v] of Object.entries(item)) if (v !== null && v !== '') same[k] = v;
            same.updatedAt = Date.now();
            return same;
          }
        }
        const created = { id: crypto.randomUUID(), profile: req.profile, ...item, createdAt: Date.now(), updatedAt: Date.now() };
        state[name].push(created);
        return created;
      });
      res.json({ ok: true, item: result, drive: driveStatus() });
    }));

    router.put(`/${name}/:id`, route(async (req, res) => {
      const { result } = await withState((state) => {
        const i = state[name].findIndex((x) => x.id === req.params.id);
        if (i < 0) fail('That entry no longer exists (deleted on another device?)');
        state[name][i] = { ...state[name][i], ...valid(req.body?.item), updatedAt: Date.now() };
        return state[name][i];
      });
      res.json({ ok: true, item: result, drive: driveStatus() });
    }));

    router.delete(`/${name}/:id`, route(async (req, res) => {
      await withState((state) => {
        state[name] = state[name].filter((x) => x.id !== req.params.id);
      });
      res.json({ ok: true, drive: driveStatus() });
    }));
  }

  // body: { csv } — rows with a date column plus any of the metric columns
  // (headers like "Weight (kg)", "Systolic", "Sleep hours" are recognised).
  router.post('/measurements/import', route(async (req, res) => {
    const csv = str(req.body?.csv, 2_000_000, 'CSV');
    let rows;
    try {
      rows = parseCsv(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
    } catch (err) {
      fail(`Could not read the CSV: ${err.message}`);
    }
    const ALIASES = {
      date: /^(date|day|time|timestamp)/i, weight: /weight|body ?mass|kg/i, waist: /waist/i, bpSys: /systolic|^sys|bp.?sys|upper/i,
      bpDia: /diastolic|^dia|bp.?dia|lower/i, pulse: /pulse|heart ?rate|hr\b|bpm/i, sleepHours: /sleep/i, steps: /step/i, glucose: /glucose|sugar/i,
      bodyFat: /fat.*(%|percent|pct)|^body ?fat$/i,
    };
    const headers = Object.keys(rows[0] || {});
    const map = {};
    for (const [k, re] of Object.entries(ALIASES)) {
      const h = headers.find((x) => re.test(x) && !Object.values(map).includes(x));
      if (h) map[k] = h;
    }
    if (!map.date) fail('No date column found (name a column "Date")');
    const toIso = (s) => {
      const t = String(s).trim();
      let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
      m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/); // dd/mm/yyyy (India)
      if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      const d = new Date(t);
      return Number.isNaN(+d) ? null : d.toISOString().slice(0, 10);
    };
    const { result } = await withState((state) => {
      let added = 0;
      let merged = 0;
      const skipped = [];
      for (const [n, row] of rows.entries()) {
        const item = { date: toIso(row[map.date]) };
        for (const k of Object.keys(METRICS)) if (map[k]) item[k] = String(row[map[k]] ?? '').replace(/[^\d.]/g, '');
        let v;
        try {
          v = validMeasurement(item);
        } catch (err) {
          skipped.push(`row ${n + 2}: ${err.message}`);
          continue;
        }
        const same = state.measurements.find((x) => x.profile === req.profile && x.date === v.date);
        if (same) {
          for (const [k, val] of Object.entries(v)) if (val !== null && val !== '') same[k] = val;
          merged++;
        } else {
          state.measurements.push({ id: crypto.randomUUID(), profile: req.profile, ...v, createdAt: Date.now(), updatedAt: Date.now() });
          added++;
        }
      }
      return { added, merged, skipped: skipped.slice(0, 20), columns: map };
    });
    res.json({ ok: true, ...result, drive: driveStatus() });
  }));

  // ---- Retest plan + Google Calendar ----
  router.get('/reminders/suggest', route(async (req, res) => {
    const { state } = await withState();
    const have = new Set(state.reminders.filter(mine(req)).map((r) => r.title));
    res.json({ suggestions: records.retestSuggestions(records.forProfile(await loadCombined(), req.profile)).filter((s) => !have.has(s.title)) });
  }));

  router.post('/reminders/:id/calendar', route(async (req, res) => {
    const { state } = await withState();
    const r = state.reminders.find((x) => x.id === req.params.id);
    if (!r) fail('That reminder no longer exists');
    let added;
    try {
      added = await addToCalendar(r, r.profile !== 'me' ? profileOf(state, r.profile).name : '');
    } catch (err) {
      if (err.code === 'GOOGLE_AUTH_REQUIRED' || googleAuthMessage(err)) {
        return res.status(401).json({ error: 'Google Calendar access is needed. Reconnect Google and allow Calendar.', authUrl: '/auth/google?redirect=%2FMyHealthReports%2Fplan.html' });
      }
      throw err;
    }
    const { result } = await withState((st) => {
      const x = st.reminders.find((y) => y.id === r.id);
      if (x) Object.assign(x, added, { updatedAt: Date.now() });
      return x;
    });
    res.json({ ok: true, item: result });
  }));

  // ---- Doctor-visit pack ----
  router.get('/visit', route(async (req, res) => {
    const { state } = await withState();
    const combined = await loadCombined();
    const mineReports = records.forProfile(combined, req.profile).reports;
    const labs = mineReports.filter((r) => r.type === 'lab' && Object.keys(r.values || {}).length);
    const latest = labs[labs.length - 1];
    const abnormal = latest ? combined.markers.filter((m) => {
      const s = records.markerStatus(m, latest.values[m.key]);
      return s && s !== 'ok';
    }).map((m) => ({
      ...m,
      status: records.markerStatus(m, latest.values[m.key]),
      history: labs.filter((r) => r.values[m.key] != null).slice(-5).map((r) => ({ date: r.date, value: r.values[m.key], provider: r.provider })),
    })) : [];
    const scans = mineReports.filter((r) => r.type !== 'lab').slice(-6).reverse()
      .map((r) => ({ id: r.id, date: r.date, provider: r.provider, title: r.title, impression: r.impression, summary: r.summary }));
    const today = new Date().toISOString().slice(0, 10);
    res.json({
      profile: profileOf(state, req.profile),
      patient: records.forProfile(combined, req.profile).patient,
      latest: latest && { id: latest.id, date: latest.date, provider: latest.provider, title: latest.title },
      changes: latest ? records.changesFor(combined, latest.id) : null,
      abnormal,
      scans,
      problems: state.problems.filter(mine(req)).filter((p) => p.status !== 'resolved').sort((a, b) => b.severity - a.severity),
      medications: state.medications.filter(mine(req)).filter((m) => !m.stoppedOn || m.stoppedOn >= today),
      measurements: state.measurements.filter(mine(req)).sort((a, b) => a.date.localeCompare(b.date)).slice(-12),
      reminders: state.reminders.filter(mine(req)).filter((r) => !r.done),
      notes: state.visitNotes[req.profile] || { doctor: '', nextVisit: '', questions: '' },
      aiConfigured: Boolean(GEMINI_API_KEY),
    });
  }));

  router.put('/visit/notes', route(async (req, res) => {
    const { result } = await withState((state) => {
      state.visitNotes[req.profile] = validVisitNotes(req.body?.notes);
      return state.visitNotes[req.profile];
    });
    res.json({ ok: true, notes: result, drive: driveStatus() });
  }));

  router.post('/visit/questions', route(async (req, res) => {
    if (!GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY is not set in .env — add it and restart the server.' });
    const limited = aiLimited(req.ip);
    if (limited) return res.status(429).json({ error: limited });
    const doctor = str(req.body?.doctor, 200, 'Doctor');
    const q = `I have a doctor's appointment${doctor ? ` with ${doctor}` : ''}. Write the 6 to 10 most useful questions I should ask, `
      + 'based on my records: the most important out-of-range results and trends first, then symptoms, then medicines/supplements. '
      + 'One line each, as a numbered list, no introduction. After each question add the key number in brackets, e.g. "(TSH 9.04 on 19 Oct 2026)". '
      + 'Do not add a "Based on" line.';
    try {
      res.json({ questions: await askGemini(q, [], await contextFor(req)) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  }));

  // ---- Gmail import ----
  router.get('/gmail', route(async (_req, res) => {
    const { state } = await withState();
    res.json({ lastRun: state.gmail.lastRun, lastResult: state.gmail.lastResult, autoHours: GMAIL_SYNC_HOURS, running: Boolean(gmailRunning), query: GMAIL_QUERY });
  }));

  router.post('/gmail/import', route(async (req, res) => {
    if (!getGmail) fail('Gmail is not available on this server');
    try {
      res.json({ ok: true, ...(await importFromGmail({ days: Math.min(Number(req.body?.days) || 400, 3650) })) });
    } catch (err) {
      if (err.code === 'GOOGLE_AUTH_REQUIRED' || googleAuthMessage(err)) {
        return res.status(401).json({ error: 'Gmail access has expired. Reconnect Google, then try again.', authUrl: '/auth/google?redirect=%2FMyHealthReports%2F' });
      }
      throw err;
    }
  }));

  router.use((err, _req, res, _next) => {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    if (err instanceof StoreError) return res.status(500).json({ error: err.message });
    console.error('Health API error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  });

  // Used by the home page's "Sync with Google": drops every Drive cache so
  // reports, records and the problems log are re-read from Drive.
  async function sync() {
    driveVersion = null;
    combinedCache = null;
    tree.clearCache();
    await withState();
    return driveStatus();
  }

  return { router, guard: makeGuard(publicDir), driveFiles: serveFromDrive, sync };
};
