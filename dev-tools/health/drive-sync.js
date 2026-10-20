// Mirrors public/MyHealthReports/{pdf/, data/, guide.html} into the Google
// Drive folder HEALTH_REPORTS_FOLDER_ID, which is where the deployed app reads
// them from.
//
//   npm run health:sync                 upload new/changed files, apply renames
//   npm run health:sync -- --dry-run    only show what would change
//   npm run health:sync -- --prune      also move Drive-only files to the Drive bin
//
// Files are matched by content (MD5), so a report renamed or moved locally is
// renamed/moved in Drive instead of uploaded twice. Uses the same Google login
// as the app (oauth-token.json or GOOGLE_OAUTH_REFRESH_TOKEN).
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');
const driveTree = require('../../healthDrive');

const PROJECT = path.resolve(__dirname, '../..');
const ROOT = path.join(PROJECT, 'public/MyHealthReports');
const SYNCED = ['pdf', 'data', 'guide.html'];
const MIME = { '.pdf': 'application/pdf', '.json': 'application/json', '.md': 'text/markdown', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.csv': 'text/csv' };
const args = new Set(process.argv.slice(2));
const dry = args.has('--dry-run');

function driveClient() {
  const tokenFile = path.resolve(PROJECT, process.env.GOOGLE_OAUTH_TOKEN_FILE || './oauth-token.json');
  const tokens = fs.existsSync(tokenFile)
    ? JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
    : process.env.GOOGLE_OAUTH_REFRESH_TOKEN && { refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN };
  if (!tokens) throw Object.assign(new Error('not connected'), { needLogin: true });
  const auth = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  auth.setCredentials(tokens);
  auth.on('tokens', (t) => {
    if (fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, JSON.stringify({ ...tokens, ...t }, null, 2));
  });
  return google.drive({ version: 'v3', auth });
}

function localFiles() {
  const out = [];
  const visit = (abs, rel) => {
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isDirectory()) {
      for (const name of fs.readdirSync(abs)) visit(path.join(abs, name), `${rel}/${name}`);
    } else if (!/\.(tmp|bak)$/i.test(rel)) {
      const buf = fs.readFileSync(abs);
      out.push({ path: rel, abs, md5: crypto.createHash('md5').update(buf).digest('hex'), size: buf.length });
    }
  };
  for (const top of SYNCED) visit(path.join(ROOT, top), top);
  return out;
}

async function main() {
  const folderId = process.env.HEALTH_REPORTS_FOLDER_ID;
  if (!folderId) throw new Error('Set HEALTH_REPORTS_FOLDER_ID in .env first');
  const client = driveClient();
  const tree = driveTree(folderId, { cacheMs: Infinity });
  const remote = (await Promise.all(SYNCED.map((top) => tree.walk(client, [top])))).flat();
  const top = (await tree.list(client, folderId)).filter((f) => f.mimeType !== tree.FOLDER_MIME);
  remote.push(...top.filter((f) => SYNCED.includes(f.name)).map((f) => ({ ...f, path: f.name })));

  const byPath = new Map(remote.map((f) => [f.path, f]));
  const claimed = new Set();
  const stats = { same: 0, updated: 0, moved: 0, uploaded: 0, pruned: 0 };
  const local = localFiles();
  const localPaths = new Set(local.map((f) => f.path));

  for (const f of local) {
    const segs = f.path.split('/');
    const hit = byPath.get(f.path);
    if (hit) {
      claimed.add(hit.id);
      if (hit.md5Checksum === f.md5) { stats.same++; continue; }
      console.log(`  update  ${f.path}`);
      if (!dry) await tree.put(client, segs, MIME[path.extname(f.path).toLowerCase()] || 'application/octet-stream', fs.readFileSync(f.abs));
      stats.updated++;
      continue;
    }
    // Same content somewhere else in Drive that no local file claims: it was renamed/moved.
    const twin = remote.find((r) => r.md5Checksum === f.md5 && !claimed.has(r.id) && !localPaths.has(r.path));
    if (twin) {
      claimed.add(twin.id);
      console.log(`  rename  ${twin.path}\n       →  ${f.path}`);
      if (!dry) await tree.move(client, twin, segs);
      stats.moved++;
      continue;
    }
    console.log(`  upload  ${f.path} (${(f.size / 1048576).toFixed(1)} MB)`);
    if (!dry) await tree.put(client, segs, MIME[path.extname(f.path).toLowerCase()] || 'application/octet-stream', fs.readFileSync(f.abs));
    stats.uploaded++;
  }

  const extra = remote.filter((r) => !claimed.has(r.id));
  for (const r of extra) {
    if (args.has('--prune')) {
      console.log(`  bin     ${r.path}`);
      if (!dry) await client.files.update({ fileId: r.id, requestBody: { trashed: true } });
      stats.pruned++;
    } else {
      console.log(`  only in Drive (kept; --prune moves it to the Drive bin): ${r.path}`);
    }
  }
  console.log(`\n${dry ? '[dry run] ' : ''}${stats.uploaded} uploaded, ${stats.moved} renamed/moved, ${stats.updated} updated, ${stats.same} already in sync${stats.pruned ? `, ${stats.pruned} binned` : ''}.`);
}

main().catch((err) => {
  const msg = err.response?.data?.error_description || err.response?.data?.error?.message || err.response?.data?.error || err.message;
  if (err.needLogin || /invalid_grant|unauthorized|invalid_token/i.test(JSON.stringify(err.response?.data || msg))) {
    console.error('Google login has expired or is missing. Start the app (npm start), open http://localhost:3000/auth/google,\n'
      + 'approve access, then run this again. (Tip: publishing the OAuth consent screen stops the 7-day expiry.)');
  } else {
    console.error(`Sync failed: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  process.exit(1);
});
