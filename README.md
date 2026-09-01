# Bill Submission Slip

A one-page tool for submitting company food bills. Fill in date, amount, and
merchant, attach or photograph the bill, hit submit — the file lands in a
Google Drive folder you choose, and a running `food_bills.csv` in that same
folder gets a new row: `date, amount, merchant, proof` (proof = Drive link).

```
bill-submit/
├── public/
│   └── index.html      ← the form (served as-is, no build step)
├── server.js            ← Express server + Google Drive logic
├── package.json
└── .env.example
```

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

- **Render / Railway / Fly.io** — push this folder as a Node web service,
  set the three env vars in their dashboard (upload the service-account JSON
  as a "secret file" or base64 it into an env var and adjust the auth code).
- **A cheap VPS + Caddy/Nginx** for automatic HTTPS.
- **ngrok** (`ngrok http 3000`) for a quick temporary HTTPS URL while testing.

## How it works

- **Frontend** (`public/index.html`): plain HTML/CSS/JS, no build step.
  Date input defaults to today and is capped to the current month. Two
  upload buttons — "Upload file" (gallery/file picker, accepts images or
  PDF) and "Take photo" (opens the camera directly on phones). Below the
  calendar, two more buttons let you auto-sync Zomato orders straight from
  Gmail for the selected date, or for that date's whole month.
- **Backend** (`server.js`):
  - `POST /api/submit` receives the form (`multipart/form-data`) with fields
    `date`, `amount`, `merchant`, and file field `bill`.
  - Uploads the file straight into your Drive folder via the Drive API.
  - Looks for `food_bills.csv` in that folder; creates it with a header row
    if missing, otherwise downloads it, appends the new row, and re-uploads
    the updated content (Drive doesn't support true byte-append, so this is
    a safe read‑modify‑write — fine for one person submitting bills).
  - Responds with the Drive link to the uploaded proof file.
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

## Notes & limits

- Upload size capped at 20 MB per file (edit `limits.fileSize` in
  `server.js` if needed).
- This is built for single-user, personal use (no login). If you expose it
  on the public internet, put it behind at least a simple password/HTTP
  basic auth so random visitors can't submit bills into your Drive.
- Amounts are stored as plain numbers (e.g. `250.00`), always in rupees.
