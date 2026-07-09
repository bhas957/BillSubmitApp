require('dotenv').config();

const fs = require('fs');
const path = require('path');
const stream = require('stream');
const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');

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

function createAuthUrl() {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: OAUTH_SCOPES,
  });
}

function getDriveClientOrThrow() {
  const tokens = loadSavedTokens();
  if (!tokens) {
    const err = new Error('Google OAuth not connected.');
    err.code = 'GOOGLE_AUTH_REQUIRED';
    err.authUrl = createAuthUrl();
    throw err;
  }
  oauth2Client.setCredentials(tokens);
  return google.drive({ version: 'v3', auth: oauth2Client });
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
  if (Number.isInteger(num) || num % 1 === 0) return String(Math.round(num));
  return String(parseFloat(num.toFixed(2)));
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

    res.json({
      success: true,
      message: 'Bill submitted successfully.',
      proofLink,
    });
  } catch (err) {
    console.error('Submit error:', err);
    if (err.code === 'GOOGLE_AUTH_REQUIRED') {
      return res.status(401).json({
        error: 'Google account is not connected. Please connect and try again.',
        authUrl: err.authUrl,
      });
    }
    res.status(500).json({ error: 'Something went wrong while saving your bill. Please try again.' });
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
    res.send('Google Drive connected successfully. You can close this tab and return to the app.');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('Could not connect Google account. Check server logs.');
  }
});

app.get('/api/auth-status', (_req, res) => {
  res.json({
    connected: hasSavedTokens(),
    authUrl: '/auth/google',
  });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Food bill submission server running at http://localhost:${PORT}`);
  if (!hasSavedTokens()) {
    console.log(`Google account not connected yet. Open http://localhost:${PORT}/auth/google`);
  }
});
