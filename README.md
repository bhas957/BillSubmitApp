# Reimbursement

A single Node/Express web app for two personal Google-Drive-backed tools —
bill submission and OCR test-image upload — plus a dev-only helper for
hardening the receipt parser against real camera photos. Everything lives
in this one repo/npm package and deploys as one web service.

```
Reimbursement/
├── public/
│   ├── index.html            ← launcher page: pick Bill Submission or OCR
│   ├── bill.html              ← the bill-submission form
│   └── ocr.html                ← the OCR image-upload form
│   (all served as-is, no build step)
├── server.js                  ← Express server + Google Drive/Gmail logic
├── zomatoParser.js             ← parses Zomato order PDFs into bill rows
├── dev-tools/
│   └── ocr-robustness-fixtures/  ← dev tool: generates camera-noise test
│       ├── README.md              images to stress-test the receipt parser
│       ├── config.js               (see its README for setup/usage)
│       ├── src/
│       ├── input/
│       └── output/
├── package.json              ← one package.json/node_modules for the whole repo
└── .env.example
```

Open the app and pick a tool:

- **Bill Submission** (`/bill.html`) — fill in date, amount, and merchant,
  attach or photograph the bill, hit submit — the file lands in a Google
  Drive folder you choose, and a running `food_bills.csv` in that same
  folder gets a new row: `date, amount, merchant, proof` (proof = Drive
  link).
- **OCR Image Upload** (`/ocr.html`) — upload or photograph an image and
  it's saved straight to a Google Drive folder (same upload-to-Drive
  mechanism as bill submission, no CSV row).

## 1. One-time Google Cloud setup (OAuth for personal Drive)

1. Go to https://console.cloud.google.com/ and create a project (or reuse one).
2. **APIs & Services → Library** → search "Google Drive API" → **Enable**.
   Also search "Gmail API" → **Enable** (needed for Zomato order auto-sync).
3. **APIs & Services → Credentials** → **Create Credentials → OAuth client ID**.
   - If prompted, configure the consent screen first (External, testing is fine).
   - Application type: **Web application**
   - Authorized redirect URI:
     `http://localhost:3000/auth/google/callback`
4. Copy the generated **Client ID** and **Client Secret**.

## 2. Choose your Drive folder and copy its ID

1. In your Google Drive, create or open the folder where bills should go.
2. Copy the ID from URL:
   `https://drive.google.com/drive/folders/`**`THIS_PART_IS_THE_FOLDER_ID`**

## 3. Configure the project

```bash
cp .env.example .env
```

Edit `.env`:

```
PORT=3000
DRIVE_FOLDER_ID=paste_the_folder_id_here
CSV_FILE_NAME=food_bills.csv
GOOGLE_OAUTH_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=your_client_secret
```

Optionally set `OCR_DRIVE_FOLDER_ID` to save OCR-uploaded images to a
*different* Drive folder than bills — otherwise they land in the same
`DRIVE_FOLDER_ID` folder, named `ocr_YYYYMMDD_HHMMSS.<ext>`.

## 4. Install & run

```bash
npm install
npm start
```

Open **http://localhost:3000** on your laptop, or on your phone if you run it
on a machine reachable from your phone (e.g. same Wi-Fi + your computer's LAN
IP, like `http://192.168.1.23:3000`, or deploy it — see below).

Then connect your Google account once by opening:

`http://localhost:3000/auth/google`

## 5. Using it on your phone (to use the camera)

Camera capture (`capture="environment"`) works out of the box on mobile
browsers once you load the page over **HTTPS**, or `http://localhost`. Plain
HTTP over a LAN IP works on Android Chrome; iOS Safari is stricter and
generally wants HTTPS. Easiest path: deploy the server somewhere with free
HTTPS, e.g.:

- **Render / Railway / Fly.io** — push this repo as a Node web service (see
  the Render steps below for the full checklist).
- **A cheap VPS + Caddy/Nginx** for automatic HTTPS.
- **ngrok** (`ngrok http 3000`) for a quick temporary HTTPS URL while testing.

## Deploying to Render

This repo is one Node web service — the whole app (launcher + bill +
OCR pages, plus both APIs) deploys as a single Render **Web Service**.

1. Push this repo to GitHub (or another Git host Render can pull from).
2. In Render: **New → Web Service** → connect the repo.
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - Render sets `PORT` itself — don't hardcode it; `server.js` already
     reads `process.env.PORT`.
3. Add environment variables under **Environment**: `DRIVE_FOLDER_ID`,
   `CSV_FILE_NAME`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
   and `GOOGLE_OAUTH_REDIRECT_URI` set to
   `https://<your-app>.onrender.com/auth/google/callback`. Add
   `OCR_DRIVE_FOLDER_ID` too if you want OCR uploads in a separate folder.
4. Back in Google Cloud Console (**Credentials** → your OAuth client), add
   that same `https://<your-app>.onrender.com/auth/google/callback` as an
   **Authorized redirect URI** (you can keep the `localhost` one alongside
   it for local dev).
5. Deploy, then open `https://<your-app>.onrender.com/auth/google` once to
   connect your Google account.

**Ephemeral disk note**: `oauth-token.json` and `zomato-gmail-synced.json`
are written to the service's local filesystem. On Render's free tier that
disk is wiped on every redeploy/restart, so you'd need to reconnect Google
after each one, and a wiped `zomato-gmail-synced.json` means the next Gmail
sync can re-save Zomato orders it had already synced before the wipe (there's
no separate content-based dedupe — that file *is* the dedupe record). If
that matters to you, add a Render **persistent disk** mounted at a fixed
path and point `GOOGLE_OAUTH_TOKEN_FILE` / `ZOMATO_GMAIL_SYNCED_FILE` at it
(see `.env.example`).

## How it works

- **Frontend**: plain HTML/CSS/JS, no build step.
  - `public/index.html` — launcher page with two cards linking to `/bill.html`
    and `/ocr.html`.
  - `public/bill.html` — the bill form. Date input defaults to today and is
    capped to the current month. Two upload buttons — "Upload file"
    (gallery/file picker, accepts images or PDF) and "Take photo" (opens the
    camera directly on phones). Below the calendar, two more buttons let you
    auto-sync Zomato orders straight from Gmail for the selected date, or for
    that date's whole month.
  - `public/ocr.html` — the OCR upload form. "Upload file" or "Take photo",
    then "Save to Drive".
  - Each of `bill.html`/`ocr.html` shows its own Google-connection status and
    a "Connect" link (see OAuth flow below).
- **Backend** (`server.js`):
  - `POST /api/submit` receives the bill form (`multipart/form-data`) with
    fields `date`, `amount`, `merchant`, and file field `bill`.
    - Uploads the file straight into your Drive folder via the Drive API.
    - Looks for `food_bills.csv` in that folder; creates it with a header row
      if missing, otherwise downloads it, appends the new row, and re-uploads
      the updated content (Drive doesn't support true byte-append, so this is
      a safe read‑modify‑write — fine for one person submitting bills).
    - Responds with the Drive link to the uploaded proof file.
  - `POST /api/ocr/upload` receives an image (`multipart/form-data`, file
    field `image`) and uploads it straight to `OCR_DRIVE_FOLDER_ID` (or
    `DRIVE_FOLDER_ID` if unset), named `ocr_YYYYMMDD_HHMMSS.<ext>`. No CSV
    row — just the file and a proof link back.
  - `POST /api/sync-zomato-gmail` (`{ date, mode: 'day' | 'month' }`) searches
    the connected Gmail account for Zomato order emails with a PDF receipt in
    that date's day or month, parses each one with the same Zomato parser,
    and saves any new ones to Drive + the CSV exactly like a manual Zomato
    upload. Already-processed emails are tracked in a local
    `zomato-gmail-synced.json` file so re-running a sync never double-saves.
    Adjust which emails match via the `ZOMATO_GMAIL_QUERY` env var (default:
    `(from:zomato.com OR subject:zomato) has:attachment filename:pdf`).
    Respects a per-day reimbursement cap: once a date's already-saved bills
    (manual + synced) total `DAILY_REIMBURSEMENT_CAP` (default `300`), any
    further Zomato orders found for that same date are skipped.
  - `GET /auth/google` (optionally `?redirect=/bill.html` or `/ocr.html`)
    starts the OAuth flow and, once connected, sends you back to that page
    (falls back to `/`). The redirect target is checked against a fixed
    whitelist (`/`, `/bill.html`, `/ocr.html`) so it can't be hijacked into
    redirecting somewhere else.

## Notes & limits

- Upload size capped at 20 MB per file (edit `limits.fileSize` in
  `server.js` if needed).
- This is built for single-user, personal use (no login). If you expose it
  on the public internet, put it behind at least a simple password/HTTP
  basic auth so random visitors can't submit bills into your Drive.
- Amounts are stored as plain numbers (e.g. `250.00`), always in rupees.

## Dev tool: OCR robustness fixtures

`dev-tools/ocr-robustness-fixtures/` generates synthetic camera-photo-like
receipt images (perspective skew, blur, noise, uneven lighting) from clean
input files, so you can test how well `zomatoParser.js`'s receipt parsing
holds up against the kind of image quality a phone camera actually
produces. It shares this repo's `package.json`/`node_modules` — its
dependencies (`sharp`, `pdf2pic`) are `devDependencies`, so a production
install (`npm ci --omit=dev`) skips them. Run it with:

```bash
npm run ocr:fixtures
```

See [dev-tools/ocr-robustness-fixtures/README.md](dev-tools/ocr-robustness-fixtures/README.md)
for full setup and usage.
