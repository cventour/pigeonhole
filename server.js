#!/usr/bin/env node
// Pigeonhole — a small self-hosted file manager.
//
// Node standard library only. Uploads arrive as a raw PUT body rather than
// multipart/form-data, which removes the only reason this would need a
// dependency: no parser to keep current, and the body streams straight to
// disk, so a 4 GB installer never lands in memory.
//
// Binds loopback by default; set HOST to expose it. There is no
// authentication, so it assumes a network you trust.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';

// Resolved, because safe() compares against this string: a relative
// REPO_ROOT would never match an absolute resolved path, and every
// request would fail the containment check.
const ROOT = path.resolve(process.env.REPO_ROOT || path.join(process.cwd(), 'files'));
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(import.meta.dirname, 'public');

// Branding is configuration, not code: one binary, any deployment.
const TITLE = process.env.REPO_TITLE || 'Pigeonhole';
const SUBTITLE = process.env.REPO_SUBTITLE || 'Drop files in. Take files out.';

// --- path safety -----------------------------------------------------------
// Everything the client sends is untrusted. Resolve it and confirm the result
// is still inside ROOT: `..`, absolute paths and symlink-shaped names all
// collapse here rather than somewhere further in.
function safe(rel) {
  const full = path.resolve(ROOT, '.' + path.posix.resolve('/', rel || '/'));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

// A single path component, for rename and mkdir. No separators, no dot-names.
function safeName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  if (!n || n === '.' || n === '..') return null;
  if (n.includes('/') || n.includes('\\') || n.includes('\0')) return null;
  if (n.length > 200) return null;
  return n;
}

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
                        'content-length': Buffer.byteLength(s) });
  res.end(s);
};

async function readBody(req, limit) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit = 64 * 1024) {
  return JSON.parse((await readBody(req, limit)).toString('utf8') || '{}');
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.pdf': 'application/pdf',
};

// --- handlers --------------------------------------------------------------
async function list(dir) {
  const full = safe(dir);
  if (!full) return null;
  const entries = await fsp.readdir(full, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    let st;
    try { st = await fsp.stat(path.join(full, e.name)); } catch { continue; }
    out.push({
      name: e.name,
      dir: e.isDirectory(),
      size: e.isDirectory() ? null : st.size,
      mtime: st.mtimeMs,
    });
  }
  // Directories first, then name order — the arrangement a person scanning a
  // list expects, rather than whatever readdir happened to return.
  out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  return out;
}

// "file.tar.gz" -> ["file", ".tar.gz"], so a suffixed copy keeps the whole
// extension rather than becoming "file.tar (2).gz".
function splitName(name) {
  const m = name.match(/^(.+?)((?:\.tar)?\.[^.]+)$/);
  return m ? [m[1], m[2]] : [name, ''];
}

function freeName(dir, name) {
  const [base, ext] = splitName(name);
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

async function upload(req, res, rel, mode) {
  let full = safe(rel);
  if (!full || full === ROOT) return json(res, 400, { error: 'bad path' });
  let name = path.basename(full);
  if (!safeName(name)) return json(res, 400, { error: 'bad filename' });

  await fsp.mkdir(path.dirname(full), { recursive: true });

  // Refuse rather than silently overwrite. The client asks and retries with
  // an explicit mode; a file manager that replaces without asking is the one
  // that loses somebody's work.
  if (fs.existsSync(full) && mode !== 'replace' && mode !== 'keep') {
    req.resume();                       // drain, or the socket hangs
    return json(res, 409, { error: 'exists', name });
  }
  if (fs.existsSync(full) && mode === 'keep') {
    name = freeName(path.dirname(full), name);
    full = path.join(path.dirname(full), name);
  }

  // Write to a temporary name and rename on success. An interrupted upload
  // then leaves nothing behind, instead of a truncated installer that looks
  // complete until someone runs it.
  const tmp = full + '.part';
  try {
    await pipeline(req, fs.createWriteStream(tmp));
    await fsp.rename(tmp, full);
    const st = await fsp.stat(full);
    json(res, 200, { ok: true, name, size: st.size });
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    json(res, 500, { error: String(err.message || err) });
  }
}

async function download(res, rel) {
  const full = safe(rel);
  if (!full) return json(res, 400, { error: 'bad path' });
  let st;
  try { st = await fsp.stat(full); } catch { return json(res, 404, { error: 'not found' }); }
  if (st.isDirectory()) return json(res, 400, { error: 'is a directory' });
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': st.size,
    'content-disposition': `attachment; filename="${path.basename(full).replace(/"/g, '')}"`,
  });
  await pipeline(fs.createReadStream(full), res);
}

// --- zip -------------------------------------------------------------------
// Folders and multi-file selections download as one zip, written by hand
// rather than by a library. The archive streams: each entry is deflated as it
// is read and its CRC and sizes follow in a data descriptor, so nothing is
// buffered or staged on disk and the download starts at once. ZIP64 fields
// appear only where a size or offset needs them, which keeps small archives
// readable by the oldest unzip and lets large ones pass 4 GB.

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
// zlib.crc32 is native but only from Node 20.15 / 22.2.
const crc32 = zlib.crc32 || ((buf, crc = 0) => {
  let c = ~crc;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return ~c >>> 0;
});

const U32 = 0xFFFFFFFF;

function dosTime(ms) {
  const d = new Date(Math.max(ms, 315532800000));      // zip time starts at 1980
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Everything under the chosen items, as { full, name, dir, st }. Skips what
// the listing hides (dot-names), unfinished uploads (.part), and symlinks, so
// a link can neither pull in files from outside ROOT nor loop forever.
async function collect(full, name, out) {
  let st;
  try { st = await fsp.lstat(full); } catch { return; }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    out.push({ full, name: name + '/', dir: true, st });
    let entries;
    try { entries = await fsp.readdir(full); } catch { return; }
    entries.sort((a, b) => a.localeCompare(b));
    for (const e of entries) {
      if (e.startsWith('.') || e.endsWith('.part')) continue;
      await collect(path.join(full, e), name + '/' + e, out);
    }
  } else if (st.isFile()) {
    out.push({ full, name, dir: false, st });
  }
}

async function zip(req, res, rels, filename) {
  const items = [];
  for (const rel of rels) {
    const full = safe(rel);
    if (!full || full === ROOT) return json(res, 400, { error: 'bad path' });
    await collect(full, path.basename(full), items);
  }
  if (!items.length) return json(res, 404, { error: 'nothing to download' });

  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });

  // A closed tab must stop the work, not leave it deflating into nowhere.
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const { signal } = ac;

  let offset = 0;
  const put = async (buf) => {
    offset += buf.length;
    if (!res.write(buf)) await once(res, 'drain', { signal });
  };

  const central = [];
  for (const it of items) {
    if (signal.aborted) return;
    const name = Buffer.from(it.name, 'utf8');
    const { time, date } = dosTime(it.st.mtimeMs);
    const start = offset;
    // Decided up front, since the local header is already sent by the time
    // the real sizes are known. The margin covers deflate's worst-case growth
    // on data that does not compress.
    const big = !it.dir && it.st.size >= U32 * 0.99;
    const flags = 0x0800 | (it.dir ? 0 : 0x0008);      // UTF-8 names; descriptor
    const method = it.dir ? 0 : 8;

    const extra = big ? Buffer.alloc(20) : Buffer.alloc(0);
    if (big) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(16, 2); }
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(big ? 45 : 20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(big ? U32 : 0, 18);
    lh.writeUInt32LE(big ? U32 : 0, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(extra.length, 28);
    await put(Buffer.concat([lh, name, extra]));

    let crc = 0, usize = 0, csize = 0;
    if (!it.dir) {
      try {
        await pipeline(
          fs.createReadStream(it.full),
          async function* (src) {
            for await (const c of src) { crc = crc32(c, crc); usize += c.length; yield c; }
          },
          // Level 1: most of what goes through here (installers, archives,
          // media) is already compressed, and on a LAN the deflate would
          // otherwise be slower than the wire.
          zlib.createDeflateRaw({ level: 1 }),
          async function (src) {
            for await (const c of src) { csize += c.length; await put(c); }
          },
          { signal },
        );
      } catch (err) {
        // Headers are gone, so there is no status left to send. Cutting the
        // connection makes the browser report a failed download instead of
        // saving a truncated zip that looks complete.
        res.destroy(err);
        return;
      }
      const dd = Buffer.alloc(big ? 24 : 16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      if (big) { dd.writeBigUInt64LE(BigInt(csize), 8); dd.writeBigUInt64LE(BigInt(usize), 16); }
      else { dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(usize, 12); }
      await put(dd);
    }
    central.push({ name, time, date, flags, method, crc, usize, csize, start, big, dir: it.dir });
  }

  const cdStart = offset;
  for (const e of central) {
    const z = [];
    if (e.usize >= U32) z.push(e.usize);
    if (e.csize >= U32) z.push(e.csize);
    if (e.start >= U32) z.push(e.start);
    const extra = z.length ? Buffer.alloc(4 + z.length * 8) : Buffer.alloc(0);
    if (z.length) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(z.length * 8, 2);
      z.forEach((v, i) => extra.writeBigUInt64LE(BigInt(v), 4 + i * 8));
    }
    const need = e.big || z.length ? 45 : 20;
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 45, 4);                  // made by: unix
    ch.writeUInt16LE(need, 6);
    ch.writeUInt16LE(e.flags, 8);
    ch.writeUInt16LE(e.method, 10);
    ch.writeUInt16LE(e.time, 12);
    ch.writeUInt16LE(e.date, 14);
    ch.writeUInt32LE(e.crc, 16);
    ch.writeUInt32LE(Math.min(e.csize, U32), 20);
    ch.writeUInt32LE(Math.min(e.usize, U32), 24);
    ch.writeUInt16LE(e.name.length, 28);
    ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt32LE(e.dir ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38);
    ch.writeUInt32LE(Math.min(e.start, U32), 42);
    await put(Buffer.concat([ch, e.name, extra]));
  }
  const cdSize = offset - cdStart;

  const n = central.length;
  if (n >= 0xFFFF || cdStart >= U32 || cdSize >= U32) {
    const z64At = offset;
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE((3 << 8) | 45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(n), 24);
    rec.writeBigUInt64LE(BigInt(n), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(z64At), 8);
    loc.writeUInt32LE(1, 16);
    await put(Buffer.concat([rec, loc]));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(n, 0xFFFF), 8);
  end.writeUInt16LE(Math.min(n, 0xFFFF), 10);
  end.writeUInt32LE(Math.min(cdSize, U32), 12);
  end.writeUInt32LE(Math.min(cdStart, U32), 16);
  await put(end);
  res.end();
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.resolve(PUBLIC, '.' + rel);
  if (!full.startsWith(PUBLIC)) return json(res, 400, { error: 'bad path' });
  try {
    const data = await fsp.readFile(full);
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

// --- server ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  try {
    if (req.method === 'GET' && p === '/api/config') {
      return json(res, 200, { title: TITLE, subtitle: SUBTITLE, root: path.basename(ROOT) });
    }

    if (req.method === 'GET' && p === '/api/exists') {
      const full = safe(url.searchParams.get('path') || '');
      if (!full || full === ROOT) return json(res, 400, { error: 'bad path' });
      return json(res, 200, { exists: fs.existsSync(full) });
    }

    if (req.method === 'GET' && p === '/api/list') {
      const items = await list(url.searchParams.get('dir') || '/');
      return items ? json(res, 200, { items }) : json(res, 400, { error: 'bad path' });
    }

    if (req.method === 'PUT' && p.startsWith('/api/upload/')) {
      return await upload(req, res, p.slice('/api/upload'.length),
                          url.searchParams.get('mode'));
    }

    if (req.method === 'GET' && p.startsWith('/api/download/')) {
      return await download(res, p.slice('/api/download'.length));
    }

    // A form POST rather than fetch, so the browser runs the download itself:
    // its own progress, its own save dialog, and no archive held in page memory.
    if (req.method === 'POST' && p === '/api/zip') {
      const form = new URLSearchParams((await readBody(req, 4 * 1024 * 1024)).toString('utf8'));
      const paths = form.getAll('path');
      if (!paths.length) return json(res, 400, { error: 'nothing selected' });
      const dir = form.get('dir') || '/';
      // One folder is named after itself; a selection after the folder it came from.
      const base = paths.length === 1 ? path.posix.basename(paths[0])
        : (dir === '/' ? path.basename(ROOT) : path.posix.basename(dir));
      return await zip(req, res, paths, (base || 'download') + '.zip');
    }

    if (req.method === 'POST' && p === '/api/delete') {
      const { target } = await readJson(req);
      const full = safe(target);
      if (!full || full === ROOT) return json(res, 400, { error: 'bad path' });
      await fsp.rm(full, { recursive: true, force: true });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/rename') {
      const { target, name } = await readJson(req);
      const full = safe(target);
      const clean = safeName(name);
      if (!full || full === ROOT) return json(res, 400, { error: 'bad path' });
      if (!clean) return json(res, 400, { error: 'a name cannot contain / or \\' });
      const dest = path.join(path.dirname(full), clean);
      if (fs.existsSync(dest)) return json(res, 409, { error: 'that name is taken' });
      await fsp.rename(full, dest);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/mkdir') {
      const { dir, name } = await readJson(req);
      const base = safe(dir || '/');
      const clean = safeName(name);
      if (!base) return json(res, 400, { error: 'bad path' });
      if (!clean) return json(res, 400, { error: 'a folder name cannot contain / or \\' });
      await fsp.mkdir(path.join(base, clean), { recursive: false });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET') return await serveStatic(res, p);
    json(res, 405, { error: 'method not allowed' });
  } catch (err) {
    json(res, 500, { error: String(err.message || err) });
  }
});

fs.mkdirSync(ROOT, { recursive: true });

// A .part file can only be an upload that did not finish, and nothing is in
// flight at startup, so anything here is debris from a previous run.
try {
  for (const f of fs.readdirSync(ROOT, { recursive: true })) {
    if (typeof f === 'string' && f.endsWith('.part')) {
      fs.rmSync(path.join(ROOT, f), { force: true });
      console.log(`removed stale partial upload: ${f}`);
    }
  }
} catch {}

server.listen(PORT, HOST, () => {
  console.log(`${TITLE} — serving ${ROOT} on http://${HOST}:${PORT}`);
});

// Finish what is in flight before exiting. Without this, a restart during a
// large upload drops the connection and leaves a .part behind — and an
// updater that restarts services is exactly the thing most likely to do it.
let closing = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (closing) return process.exit(1);   // second signal: go now
    closing = true;
    console.log(`${sig} — finishing in-flight requests`);
    server.close(() => { console.log('drained, exiting'); process.exit(0); });
  });
}
