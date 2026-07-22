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
const CSV_FILE_NAME = process.env.CSV_FILE_NAME || 'food_bills.csv';
const OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
const TOKEN_FILE = process.env.GOOGLE_OAUTH_TOKEN_FILE || './oauth-token.json';
const OAUTH_SCOPES = ['https://www.googleapis.com/auth/drive'];

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

function createAuthUrl() {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: OAUTH_SCOPES,
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
  const msg = String(err.message || '');
  return /invalid_grant|Token has been expired|invalid credentials|Login Required|unauthorized/i.test(msg);
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

// ---- Routes -----------------------------------------------------------

app.get('/api/bills', async (_req, res) => {
  try {
    const drive = getDriveClientOrThrow();
    const { bills, byDate } = await readAllBills(drive);
    res.json({ bills, byDate });
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

app.get('/auth/google', (_req, res) => {
  res.redirect(createAuthUrl());
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code || typeof code !== 'string') {
      return res.status(400).send('Missing OAuth code.');
    }
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    saveTokens(tokens);
    res.redirect('/?drive=connected');
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
