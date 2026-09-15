require('dotenv').config();

const fs = require('fs');
const path = require('path');
const stream = require('stream');
const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const { parseZomatoReceipt } = require('./zomatoParser');

const PORT = process.env.PORT || 3000;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const OCR_DRIVE_FOLDER_ID = process.env.OCR_DRIVE_FOLDER_ID || DRIVE_FOLDER_ID;
const CSV_FILE_NAME = process.env.CSV_FILE_NAME || 'food_bills.csv';
const OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
const TOKEN_FILE = process.env.GOOGLE_OAUTH_TOKEN_FILE || './oauth-token.json';
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/gmail.readonly',
];
const ZOMATO_GMAIL_QUERY = process.env.ZOMATO_GMAIL_QUERY
  || '(from:zomato.com OR subject:zomato) has:attachment filename:pdf';
const SYNCED_STORE_FILE = process.env.ZOMATO_GMAIL_SYNCED_FILE || './zomato-gmail-synced.json';
const COMPLETED_DAYS_FILE = process.env.ZOMATO_COMPLETED_DAYS_FILE || './zomato-completed-days.json';
const DAILY_REIMBURSEMENT_CAP = Number(process.env.DAILY_REIMBURSEMENT_CAP || 300);

if (!DRIVE_FOLDER_ID) {
  console.error('Missing DRIVE_FOLDER_ID in .env — see .env.example');
  process.exit(1);
}
if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
  console.error('Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET in .env');
  process.exit(1);
}

const app = express();
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Keep uploads in memory; bills are small images/PDFs, not huge files.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

// ---- Google Drive OAuth ---------------------------------------------------
const oauth2Client = new google.auth.OAuth2(
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_REDIRECT_URI
);

function tokenFilePath() {
  return path.resolve(__dirname, TOKEN_FILE);
}

function hasSavedTokens() {
  return fs.existsSync(tokenFilePath());
}

function loadSavedTokens() {
  if (!hasSavedTokens()) return null;
  try {
    return JSON.parse(fs.readFileSync(tokenFilePath(), 'utf8'));
  } catch (err) {
    console.error('Could not read saved OAuth tokens:', err.message);
    return null;
  }
}

function saveTokens(tokens) {
  fs.writeFileSync(tokenFilePath(), JSON.stringify(tokens, null, 2), 'utf8');
}

function mergeAndSaveTokens(newTokens) {
  const existing = loadSavedTokens() || {};
  saveTokens({ ...existing, ...newTokens });
}

// Persist refreshed access tokens whenever googleapis refreshes them.
oauth2Client.on('tokens', (tokens) => {
  try {
    mergeAndSaveTokens(tokens);
  } catch (err) {
    console.error('Could not save refreshed OAuth tokens:', err.message);
  }
});

// Whitelist of pages the OAuth flow is allowed to bounce back to, so the
// callback's redirect target can't be hijacked into an open redirect.
const ALLOWED_OAUTH_REDIRECTS = new Set(['/', '/bill.html', '/ocr.html']);

function safeOAuthRedirect(value) {
  return ALLOWED_OAUTH_REDIRECTS.has(value) ? value : '/';
}

function createAuthUrl(redirectTo) {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: OAUTH_SCOPES,
    state: safeOAuthRedirect(redirectTo),
  });
}

function isGoogleAuthError(err) {
  if (!err) return false;
  if (err.code === 'GOOGLE_AUTH_REQUIRED') return true;
  const dataErr = err.response?.data?.error;
  if (dataErr === 'invalid_grant' || dataErr === 'unauthorized' || dataErr === 'invalid_token') {
    return true;
  }
  if (err.code === 401 || err.status === 401) return true;
  const reason = err.response?.data?.error?.errors?.[0]?.reason;
  if (reason === 'insufficientPermissions') return true;
  const msg = String(err.message || err.response?.data?.error?.message || '');
  return /invalid_grant|Token has been expired|invalid credentials|Login Required|unauthorized|insufficient.*(scope|permission)/i.test(msg);
}

function gmailApiDisabledMessage(err) {
  const reason = err?.response?.data?.error?.errors?.[0]?.reason;
  const msg = String(err?.response?.data?.error?.message || err?.message || '');
  if (reason !== 'accessNotConfigured' && !/has not been used in project|it is disabled/i.test(msg)) {
    return null;
  }
  const activationUrl = err?.response?.data?.error?.details
    ?.find((d) => d.metadata?.activationUrl)?.metadata?.activationUrl;
  return activationUrl
    ? `Gmail API is not enabled for this Google Cloud project. Enable it at ${activationUrl}, wait a minute, then retry.`
    : 'Gmail API is not enabled for this Google Cloud project. Enable it in Google Cloud Console (APIs & Services → Library → Gmail API), wait a minute, then retry.';
}

function authRequiredError() {
  const err = new Error('Google OAuth not connected.');
  err.code = 'GOOGLE_AUTH_REQUIRED';
  err.authUrl = createAuthUrl();
  return err;
}

function getDriveClientOrThrow() {
  const tokens = loadSavedTokens();
  if (!tokens) throw authRequiredError();
  oauth2Client.setCredentials(tokens);
  return google.drive({ version: 'v3', auth: oauth2Client });
}

function getGmailClientOrThrow() {
  const tokens = loadSavedTokens();
  if (!tokens) throw authRequiredError();
  oauth2Client.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

async function probeDriveConnection() {
  if (!hasSavedTokens()) {
    return {
      connected: false,
      reason: 'missing',
      authUrl: '/auth/google',
    };
  }

  try {
    const drive = getDriveClientOrThrow();
    const about = await drive.about.get({ fields: 'user(displayName,emailAddress)' });
    return {
      connected: true,
      email: about.data.user?.emailAddress || null,
      name: about.data.user?.displayName || null,
      authUrl: '/auth/google',
    };
  } catch (err) {
    if (isGoogleAuthError(err)) {
      return {
        connected: false,
        reason: 'expired',
        authUrl: '/auth/google',
        message: 'Google Drive connection expired. Please reconnect.',
      };
    }
    console.error('Drive probe error:', err);
    return {
      connected: false,
      reason: 'error',
      authUrl: '/auth/google',
      message: 'Could not verify Google Drive connection.',
    };
  }
}

function sendAuthRequired(res) {
  return res.status(401).json({
    error: 'Google account is not connected. Please connect and try again.',
    authUrl: '/auth/google',
  });
}

function bufferToStream(buffer) {
  const readable = new stream.Readable();
  readable.push(buffer);
  readable.push(null);
  return readable;
}

// Escape a value for safe CSV storage.
function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ---- Drive helpers ---------------------------------------------------------

function getOrdinalSuffix(day) {
  if (day >= 11 && day <= 13) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function formatAmountForFileName(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num)) return '0';
  return String(Math.round(num));
}

function buildBillFileBaseName(dateStr, amount) {
  const [, month, day] = dateStr.split('-').map(Number);
  const ordinal = getOrdinalSuffix(day);
  const monthName = MONTH_NAMES[month - 1];
  return `${day}${ordinal}${monthName}_${formatAmountForFileName(amount)}`;
}

function getFileExtension(file) {
  const fromName = path.extname(file.originalname).toLowerCase();
  if (fromName) return fromName;
  const mimeMap = {
    'image/jpeg': '.jpeg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
  };
  return mimeMap[file.mimetype] || '';
}

function escapeDriveQueryString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function resolveUniqueBillFileName(drive, date, amount, ext) {
  const baseName = buildBillFileBaseName(date, amount);
  const safeBase = escapeDriveQueryString(baseName);

  const res = await drive.files.list({
    q: `'${DRIVE_FOLDER_ID}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false and name contains '${safeBase}'`,
    fields: 'files(name)',
    spaces: 'drive',
  });

  const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedExt = ext.replace(/\./g, '\\.');
  const pattern = new RegExp(`^${escapedBase}(_\\d+)?${escapedExt}$`, 'i');

  const existing = (res.data.files || []).filter((f) => pattern.test(f.name));
  if (existing.length === 0) return `${baseName}${ext}`;

  const usedIndices = new Set();
  for (const file of existing) {
    const match = file.name.match(new RegExp(`^${escapedBase}(_(\\d+))?${escapedExt}$`, 'i'));
    if (!match) continue;
    if (match[2]) {
      usedIndices.add(parseInt(match[2], 10));
    } else {
      usedIndices.add(0);
    }
  }

  if (!usedIndices.has(0)) return `${baseName}${ext}`;

  let index = 1;
  while (usedIndices.has(index)) index += 1;
  return `${baseName}_${index}${ext}`;
}

async function uploadBillFile(drive, file, date, amount) {
  const ext = getFileExtension(file);
  const fileName = await resolveUniqueBillFileName(drive, date, amount, ext);

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [DRIVE_FOLDER_ID],
    },
    media: {
      mimeType: file.mimetype,
      body: bufferToStream(file.buffer),
    },
    fields: 'id, webViewLink',
  });

  return res.data; // { id, webViewLink }
}

function buildOcrFileBaseName() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `ocr_${y}${m}${d}_${hh}${mm}${ss}`;
}

async function uploadOcrImage(drive, file) {
  const ext = getFileExtension(file) || '.jpg';
  const fileName = `${buildOcrFileBaseName()}${ext}`;

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [OCR_DRIVE_FOLDER_ID],
    },
    media: {
      mimeType: file.mimetype,
      body: bufferToStream(file.buffer),
    },
    fields: 'id, webViewLink',
  });

  return res.data; // { id, webViewLink }
}

async function findCsvFile(drive) {
  const res = await drive.files.list({
    q: `name='${CSV_FILE_NAME}' and '${DRIVE_FOLDER_ID}' in parents and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
  });
  return res.data.files && res.data.files.length ? res.data.files[0] : null;
}

async function downloadFileText(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'text' }
  );
  return res.data;
}

function parseCsvRows(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const startIndex = /^date\s*,/i.test(lines[0]) ? 1 : 0;
  const rows = [];

  for (let i = startIndex; i < lines.length; i += 1) {
    const parts = [];
    let current = '';
    let inQuotes = false;
    const line = lines[i];

    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c];
      if (inQuotes) {
        if (ch === '"' && line[c + 1] === '"') {
          current += '"';
          c += 1;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        parts.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    parts.push(current);

    const [date, amount, merchant = '', proof = ''] = parts;
    const amountNum = Number(amount);
    if (!date || !Number.isFinite(amountNum)) continue;
    rows.push({
      date: date.trim(),
      amount: amountNum,
      merchant: merchant.trim(),
      proof: proof.trim(),
    });
  }

  return rows;
}

function summarizeBillsByDate(rows) {
  const byDate = {};
  for (const row of rows) {
    if (!byDate[row.date]) {
      byDate[row.date] = { total: 0, count: 0, bills: [] };
    }
    byDate[row.date].total += row.amount;
    byDate[row.date].count += 1;
    byDate[row.date].bills.push(row);
  }

  for (const date of Object.keys(byDate)) {
    byDate[date].total = Number(byDate[date].total.toFixed(2));
  }
  return byDate;
}

async function readAllBills(drive) {
  const existing = await findCsvFile(drive);
  if (!existing) return { bills: [], byDate: {} };
  const text = await downloadFileText(drive, existing.id);
  const bills = parseCsvRows(text);
  return { bills, byDate: summarizeBillsByDate(bills) };
}

async function appendRowToCsv(drive, rowValues) {
  const header = 'date,amount,merchant,proof\n';
  const row = rowValues.map(csvEscape).join(',') + '\n';

  const existing = await findCsvFile(drive);

  if (!existing) {
    // Create a brand new CSV with header + first row.
    await drive.files.create({
      requestBody: {
        name: CSV_FILE_NAME,
        parents: [DRIVE_FOLDER_ID],
        mimeType: 'text/csv',
      },
      media: {
        mimeType: 'text/csv',
        body: bufferToStream(Buffer.from(header + row, 'utf8')),
      },
      fields: 'id',
    });
    return;
  }

  // Append to existing CSV.
  let currentText = await downloadFileText(drive, existing.id);
  if (typeof currentText !== 'string') {
    currentText = String(currentText || '');
  }
  if (!currentText.endsWith('\n') && currentText.length > 0) {
    currentText += '\n';
  }
  const updatedText = currentText.length > 0 ? currentText + row : header + row;

  await drive.files.update({
    fileId: existing.id,
    media: {
      mimeType: 'text/csv',
      body: bufferToStream(Buffer.from(updatedText, 'utf8')),
    },
  });
}

// ---- Zomato Gmail auto-sync -------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

function gmailDateStr(d) {
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function buildGmailQueryDateRange(dateStr, mode) {
  const [y, m, d] = dateStr.split('-').map(Number);
  let start;
  let end;
  if (mode === 'month') {
    start = new Date(y, m - 1, 1);
    end = new Date(y, m, 1);
  } else {
    start = new Date(y, m - 1, d);
    end = new Date(y, m - 1, d + 1);
  }
  return { after: gmailDateStr(start), before: gmailDateStr(end) };
}

function findPdfAttachmentParts(payload, results = []) {
  if (!payload) return results;
  const filename = payload.filename || '';
  if (filename.toLowerCase().endsWith('.pdf') && payload.body?.attachmentId) {
    results.push({ filename, attachmentId: payload.body.attachmentId });
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) findPdfAttachmentParts(part, results);
  }
  return results;
}

function syncedStorePath() {
  return path.resolve(__dirname, SYNCED_STORE_FILE);
}

function loadSyncedMessageIds() {
  try {
    if (!fs.existsSync(syncedStorePath())) return new Set();
    const data = JSON.parse(fs.readFileSync(syncedStorePath(), 'utf8'));
    return new Set(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error('Could not read Zomato Gmail sync store:', err.message);
    return new Set();
  }
}

function saveSyncedMessageIds(set) {
  fs.writeFileSync(syncedStorePath(), JSON.stringify([...set], null, 2), 'utf8');
}

function completedDaysStorePath() {
  return path.resolve(__dirname, COMPLETED_DAYS_FILE);
}

// Dates whose ₹DAILY_REIMBURSEMENT_CAP allowance has already been fully
// accounted for by a previous sync — future syncs skip Gmail entirely for them.
function loadCompletedDays() {
  try {
    if (!fs.existsSync(completedDaysStorePath())) return new Set();
    const data = JSON.parse(fs.readFileSync(completedDaysStorePath(), 'utf8'));
    return new Set(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error('Could not read Zomato completed-days store:', err.message);
    return new Set();
  }
}

function saveCompletedDays(set) {
  fs.writeFileSync(completedDaysStorePath(), JSON.stringify([...set], null, 2), 'utf8');
}

async function listGmailMessageIds(gmail, query) {
  const ids = [];
  let pageToken;
  do {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 100,
      pageToken,
    });
    (listRes.data.messages || []).forEach((m) => ids.push(m.id));
    pageToken = listRes.data.nextPageToken;
  } while (pageToken && ids.length < 300);
  return ids;
}

// For a single Gmail message, download every PDF attachment, parse each as a
// Zomato receipt, and keep only the highest-value one — Zomato sends both an
// "Invoice" PDF and an "Order ID" PDF per order, and we only want to upload
// and record one bill per real-world order.
async function parseBestAttachmentForMessage(gmail, messageId, pdfParts) {
  let best = null;
  for (const part of pdfParts) {
    const attachRes = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: part.attachmentId,
    });
    const buffer = Buffer.from(attachRes.data.data, 'base64');

    let parsed;
    try {
      parsed = await parseZomatoReceipt(buffer);
    } catch (err) {
      continue; // Not a parseable Zomato receipt — try the next attachment, if any.
    }

    if (!best || parsed.amount > best.parsed.amount) {
      best = {
        parsed,
        buffer,
        filename: part.filename || `${parsed.date}.pdf`,
      };
    }
  }
  return best;
}

// Scans Gmail for Zomato order emails in the given date/month, parses the PDF
// receipts found (picking the higher-value PDF per order), and applies the
// company's daily reimbursement cap: for each date, orders are ranked highest
// amount first and accepted while the running total stays within the cap: as
// soon as the next order (in that order) would push the total over the cap,
// selection for that date stops and the date is marked complete so future
// syncs skip Gmail entirely for it. Already-processed messages are skipped
// using a small local store so re-running the sync is safe.
async function syncZomatoFromGmail({ dateStr, mode }) {
  const completedDays = loadCompletedDays();
  if (mode === 'day' && completedDays.has(dateStr)) {
    return {
      found: 0,
      synced: 0,
      alreadySynced: 0,
      skipped: 0,
      capSkipped: 0,
      errors: 0,
      dayComplete: true,
    };
  }

  const tokens = loadSavedTokens();
  if (!tokens) throw authRequiredError();
  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  const { after, before } = buildGmailQueryDateRange(dateStr, mode);
  const query = `${ZOMATO_GMAIL_QUERY} after:${after} before:${before}`;

  const messageIds = await listGmailMessageIds(gmail, query);
  const syncedIds = loadSyncedMessageIds();
  const summary = {
    found: messageIds.length,
    synced: 0,
    alreadySynced: 0,
    skipped: 0,
    capSkipped: 0,
    errors: 0,
  };

  // Gather one best-of-two-PDFs candidate order per unprocessed message.
  const candidates = []; // { messageId, parsed, buffer, filename }
  for (const messageId of messageIds) {
    if (syncedIds.has(messageId)) {
      summary.alreadySynced += 1;
      continue;
    }

    try {
      const msgRes = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
      const pdfParts = findPdfAttachmentParts(msgRes.data.payload);
      const best = await parseBestAttachmentForMessage(gmail, messageId, pdfParts);

      if (!best) {
        summary.skipped += 1;
        syncedIds.add(messageId);
        continue;
      }

      candidates.push({ messageId, ...best });
    } catch (err) {
      if (isGoogleAuthError(err)) throw err;
      console.error(`Zomato Gmail sync error for message ${messageId}:`, err.message);
      summary.errors += 1;
    }
  }

  // Safety net: if the same order's two PDFs ever arrive as separate emails,
  // dedupe by orderId across messages and keep only the higher-value one.
  const byOrderId = new Map();
  const noOrderId = [];
  for (const candidate of candidates) {
    const orderId = candidate.parsed.orderId;
    if (!orderId) {
      noOrderId.push(candidate);
      continue;
    }
    const existing = byOrderId.get(orderId);
    if (!existing || candidate.parsed.amount > existing.parsed.amount) {
      if (existing) syncedIds.add(existing.messageId); // drop the lower-value duplicate
      byOrderId.set(orderId, candidate);
    } else {
      syncedIds.add(candidate.messageId); // drop this lower-value duplicate
    }
  }
  const dedupedCandidates = [...byOrderId.values(), ...noOrderId];

  // Group by order date so the daily cap can be applied per date.
  const candidatesByDate = {};
  for (const candidate of dedupedCandidates) {
    const date = candidate.parsed.date;
    if (!candidatesByDate[date]) candidatesByDate[date] = [];
    candidatesByDate[date].push(candidate);
  }

  // Seed each date's running total from what's already saved, so the cap
  // accounts for both prior manual submissions and prior syncs.
  const { byDate: existingByDate } = await readAllBills(drive);
  const dailyTotals = {};
  for (const [date, info] of Object.entries(existingByDate)) {
    dailyTotals[date] = info.total;
  }

  for (const [date, dateCandidates] of Object.entries(candidatesByDate)) {
    if (completedDays.has(date)) {
      for (const candidate of dateCandidates) syncedIds.add(candidate.messageId);
      summary.capSkipped += dateCandidates.length;
      continue;
    }

    // Highest amount first: prefer the biggest orders toward the cap.
    dateCandidates.sort((a, b) => b.parsed.amount - a.parsed.amount);

    let runningTotal = dailyTotals[date] || 0;
    let stoppedForCap = false;

    for (const candidate of dateCandidates) {
      const { parsed, buffer, filename, messageId } = candidate;

      if (stoppedForCap || runningTotal + parsed.amount > DAILY_REIMBURSEMENT_CAP) {
        stoppedForCap = true;
        summary.capSkipped += 1;
        syncedIds.add(messageId); // decided for good — don't re-check next time
        continue;
      }

      const file = { originalname: filename, mimetype: 'application/pdf', buffer };
      const uploaded = await uploadBillFile(drive, file, date, parsed.amount);
      const proofLink = uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`;
      await appendRowToCsv(drive, [date, Number(parsed.amount).toFixed(2), parsed.merchant, proofLink]);

      runningTotal += parsed.amount;
      summary.synced += 1;
      syncedIds.add(messageId);
    }

    if (runningTotal >= DAILY_REIMBURSEMENT_CAP) {
      completedDays.add(date);
    }
  }

  saveSyncedMessageIds(syncedIds);
  saveCompletedDays(completedDays);
  return summary;
}

// ---- Routes -----------------------------------------------------------

app.get('/api/bills', async (_req, res) => {
  try {
    const drive = getDriveClientOrThrow();
    const { bills, byDate } = await readAllBills(drive);
    res.json({ bills, byDate, dailyCap: DAILY_REIMBURSEMENT_CAP });
  } catch (err) {
    console.error('Bills fetch error:', err);
    if (isGoogleAuthError(err)) return sendAuthRequired(res);
    res.status(500).json({ error: 'Could not load existing bills.' });
  }
});

app.post('/api/submit', upload.single('bill'), async (req, res) => {
  try {
    const { date, amount, merchant } = req.body;

    if (!date) return res.status(400).json({ error: 'Date is required.' });
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'A valid amount is required.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Please attach or photograph the bill.' });
    }

    const drive = getDriveClientOrThrow();
    const uploaded = await uploadBillFile(drive, req.file, date, amount);
    const proofLink = uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`;

    await appendRowToCsv(drive, [date, Number(amount).toFixed(2), merchant || '', proofLink]);

    const { byDate } = await readAllBills(drive);

    res.json({
      success: true,
      message: 'Bill submitted successfully.',
      proofLink,
      byDate,
    });
  } catch (err) {
    console.error('Submit error:', err);
    if (isGoogleAuthError(err)) return sendAuthRequired(res);
    res.status(500).json({ error: 'Something went wrong while saving your bill. Please try again.' });
  }
});

app.post('/api/ocr/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please attach or photograph an image.' });
    }
    if (!req.file.mimetype.startsWith('image/')) {
      return res.status(400).json({ error: 'Only image files are accepted.' });
    }

    const drive = getDriveClientOrThrow();
    const uploaded = await uploadOcrImage(drive, req.file);
    const proofLink = uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`;

    res.json({ success: true, message: 'Image saved to Google Drive.', proofLink });
  } catch (err) {
    console.error('OCR upload error:', err);
    if (isGoogleAuthError(err)) return sendAuthRequired(res);
    res.status(500).json({ error: 'Something went wrong while saving the image. Please try again.' });
  }
});

app.post('/api/submit-zomato', upload.single('bill'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a Zomato receipt PDF.' });
    }

    const isPdf =
      req.file.mimetype === 'application/pdf' ||
      path.extname(req.file.originalname).toLowerCase() === '.pdf';
    if (!isPdf) {
      return res.status(400).json({ error: 'Zomato upload accepts PDF receipts only.' });
    }

    const parsed = await parseZomatoReceipt(req.file.buffer);
    const drive = getDriveClientOrThrow();

    const uploaded = await uploadBillFile(drive, req.file, parsed.date, parsed.amount);
    const proofLink = uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`;

    await appendRowToCsv(drive, [
      parsed.date,
      Number(parsed.amount).toFixed(2),
      parsed.merchant,
      proofLink,
    ]);

    const { byDate } = await readAllBills(drive);
    const daySummary = byDate[parsed.date] || null;

    res.json({
      success: true,
      message: 'Zomato bill parsed and submitted successfully.',
      parsed,
      proofLink,
      byDate,
      daySummary,
    });
  } catch (err) {
    console.error('Zomato submit error:', err);
    if (isGoogleAuthError(err)) return sendAuthRequired(res);
    if (err.code === 'NOT_ZOMATO' || err.code === 'PARSE_FAILED') {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Could not parse or save the Zomato receipt. Please try again.' });
  }
});

app.post('/api/sync-zomato-gmail', async (req, res) => {
  try {
    const { date, mode } = req.body || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'A valid date is required.' });
    }
    const syncMode = mode === 'month' ? 'month' : 'day';

    const summary = await syncZomatoFromGmail({ dateStr: date, mode: syncMode });
    const drive = getDriveClientOrThrow();
    const { byDate } = await readAllBills(drive);

    let message;
    if (summary.dayComplete) {
      message = `Daily ₹${DAILY_REIMBURSEMENT_CAP} allowance was already reached for ${date} on a previous sync — skipped Gmail check.`;
    } else {
      message = summary.synced > 0
        ? `Synced ${summary.synced} new Zomato order${summary.synced === 1 ? '' : 's'} from Gmail.`
        : 'No new Zomato orders found to sync.';
      if (summary.capSkipped > 0) {
        message += ` Skipped ${summary.capSkipped} order${summary.capSkipped === 1 ? '' : 's'} — daily ₹${DAILY_REIMBURSEMENT_CAP} allowance reached for that date.`;
      }
    }

    res.json({ success: true, mode: syncMode, summary, byDate, message, dailyCap: DAILY_REIMBURSEMENT_CAP });
  } catch (err) {
    console.error('Zomato Gmail sync error:', err);
    if (isGoogleAuthError(err)) return sendAuthRequired(res);
    const disabledMessage = gmailApiDisabledMessage(err);
    if (disabledMessage) return res.status(400).json({ error: disabledMessage });
    res.status(500).json({ error: 'Could not sync Zomato orders from Gmail. Please try again.' });
  }
});

app.get('/auth/google', (req, res) => {
  res.redirect(createAuthUrl(req.query.redirect));
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || typeof code !== 'string') {
      return res.status(400).send('Missing OAuth code.');
    }
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    saveTokens(tokens);
    const redirectTo = safeOAuthRedirect(state);
    const sep = redirectTo.includes('?') ? '&' : '?';
    res.redirect(`${redirectTo}${sep}drive=connected`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('Could not connect Google account. Check server logs.');
  }
});

app.get('/api/auth-status', async (_req, res) => {
  try {
    const status = await probeDriveConnection();
    res.json(status);
  } catch (err) {
    console.error('Auth status error:', err);
    res.json({
      connected: false,
      reason: 'error',
      authUrl: '/auth/google',
      message: 'Could not verify Google Drive connection.',
    });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Food bill submission server running at http://localhost:${PORT}`);
  if (!hasSavedTokens()) {
    console.log(`Google account not connected yet. Open http://localhost:${PORT}/auth/google`);
  }
});
