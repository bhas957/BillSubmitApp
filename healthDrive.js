// Path-style access to a Google Drive folder tree ("pdf/Blood Tests/x.pdf"),
// used by the health app (serving + uploads) and dev-tools/health/drive-sync.js.
const { Readable } = require('stream');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,size,md5Checksum,modifiedTime,parents';

module.exports = function driveTree(rootId, { cacheMs = 60_000 } = {}) {
  const cache = new Map(); // folder id -> { at, files }

  async function list(client, folderId) {
    const hit = cache.get(folderId);
    if (hit && Date.now() - hit.at < cacheMs) return hit.files;
    const files = [];
    let pageToken;
    do {
      const res = await client.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: `nextPageToken, files(${FIELDS})`,
        orderBy: 'modifiedTime desc', // duplicate names: the newest wins
        pageSize: 1000,
        pageToken,
        spaces: 'drive',
      });
      files.push(...(res.data.files || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    cache.set(folderId, { at: Date.now(), files });
    return files;
  }

  async function find(client, segments) {
    let node = { id: rootId, mimeType: FOLDER_MIME };
    for (const name of segments) {
      if (node.mimeType !== FOLDER_MIME) return null;
      node = (await list(client, node.id)).find((f) => f.name === name);
      if (!node) return null;
    }
    return node;
  }

  // Id of the folder at `segments`, creating missing folders on the way.
  async function ensureFolder(client, segments) {
    let id = rootId;
    for (const name of segments) {
      let node = (await list(client, id)).find((f) => f.name === name && f.mimeType === FOLDER_MIME);
      if (!node) {
        node = (await client.files.create({ requestBody: { name, mimeType: FOLDER_MIME, parents: [id] }, fields: FIELDS })).data;
        cache.delete(id);
      }
      id = node.id;
    }
    return id;
  }

  // Creates or replaces the file at `segments` (last segment = file name).
  async function put(client, segments, mimeType, body) {
    const parent = await ensureFolder(client, segments.slice(0, -1));
    const name = segments[segments.length - 1];
    const existing = (await list(client, parent)).find((f) => f.name === name && f.mimeType !== FOLDER_MIME);
    const media = { mimeType, body: Buffer.isBuffer(body) ? Readable.from(body) : body };
    const res = existing
      ? await client.files.update({ fileId: existing.id, media, fields: FIELDS })
      : await client.files.create({ requestBody: { name, parents: [parent] }, media, fields: FIELDS });
    cache.delete(parent);
    return res.data;
  }

  // Renames and/or moves an existing file to `segments`.
  async function move(client, file, segments) {
    const parent = await ensureFolder(client, segments.slice(0, -1));
    const old = file.parents?.[0];
    const res = await client.files.update({
      fileId: file.id,
      requestBody: { name: segments[segments.length - 1] },
      addParents: old !== parent ? parent : undefined,
      removeParents: old && old !== parent ? old : undefined,
      fields: FIELDS,
    });
    cache.delete(parent);
    if (old) cache.delete(old);
    return res.data;
  }

  // Every file below `segments`, with its path relative to the root.
  async function walk(client, segments = []) {
    const start = segments.length ? await find(client, segments) : { id: rootId, mimeType: FOLDER_MIME };
    if (!start || start.mimeType !== FOLDER_MIME) return [];
    const out = [];
    const visit = async (id, base) => {
      for (const f of await list(client, id)) {
        const rel = base ? `${base}/${f.name}` : f.name;
        if (f.mimeType === FOLDER_MIME) await visit(f.id, rel);
        else out.push({ ...f, path: rel });
      }
    };
    await visit(start.id, segments.join('/'));
    return out;
  }

  return { rootId, list, find, ensureFolder, put, move, walk, clearCache: () => cache.clear(), FOLDER_MIME };
};

module.exports.FOLDER_MIME = FOLDER_MIME;
