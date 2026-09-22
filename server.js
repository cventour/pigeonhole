#!/usr/bin/env node
// Pigeonhole — a small self-hosted file manager.
//
// Node standard library only. Uploads arrive as a raw PUT body rather than
// multipart/form-data, which removes the only reason this would need a
// dependency: no parser to keep current, and the body streams straight to
// disk, so a 4 GB installer never lands in memory.
//
// Listens on loopback. Caddy is the only thing that talks to it.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const ROOT = process.env.REPO_ROOT || path.join(process.cwd(), 'files');
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

async function readJson(req, limit = 64 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
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

async function upload(req, res, rel) {
  const full = safe(rel);
  if (!full || full === ROOT) return json(res, 400, { error: 'bad path' });
  const name = path.basename(full);
  if (!safeName(name)) return json(res, 400, { error: 'bad filename' });

  await fsp.mkdir(path.dirname(full), { recursive: true });

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

    if (req.method === 'GET' && p === '/api/list') {
      const items = await list(url.searchParams.get('dir') || '/');
      return items ? json(res, 200, { items }) : json(res, 400, { error: 'bad path' });
    }

    if (req.method === 'PUT' && p.startsWith('/api/upload/')) {
      return await upload(req, res, p.slice('/api/upload'.length));
    }

    if (req.method === 'GET' && p.startsWith('/api/download/')) {
      return await download(res, p.slice('/api/download'.length));
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
server.listen(PORT, HOST, () => {
  console.log(`${TITLE} — serving ${ROOT} on http://${HOST}:${PORT}`);
});
