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
import net from 'node:net';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Resolved, because safe() compares against this string: a relative
// REPO_ROOT would never match an absolute resolved path, and every
// request would fail the containment check.
const ROOT = path.resolve(process.env.REPO_ROOT || path.join(process.cwd(), 'files'));
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(import.meta.dirname, 'public');
// Settings changed from the page live here, not in ROOT: that is what people
// browse, zip and hand out, and a scanner address has no business in it.
const SETTINGS_FILE = path.resolve(process.env.SETTINGS_FILE
  || path.join(import.meta.dirname, 'settings.json'));

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

// --- settings --------------------------------------------------------------
// One small JSON file, read once and rewritten whole. Validated on the way in
// and again on the way out of disk, so a hand-edited file cannot put the
// scanner client into a state the page could not have produced.
const ICAP_DEFAULTS = {
  enabled: false, host: '', port: 1344, service: 'omsscan',
  timeout: 120,          // seconds without hearing from the ICAP server
  failClosed: true,      // refuse the upload when it cannot be scanned
};

function cleanIcap(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { ...ICAP_DEFAULTS };
  const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };

  if ('host' in r) {
    const host = String(r.host ?? '').trim();
    // A hostname, IPv4 or IPv6 literal. No scheme, port or path: those have
    // their own fields, and a pasted icap:// URL should say so, not half-work.
    if (host && !/^[A-Za-z0-9._:-]{1,253}$/.test(host)) bad('Host must be a name or IP address, without icap:// or a port');
    out.host = host;
  }
  if ('port' in r) {
    const port = Number(r.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) bad('Port must be a number from 1 to 65535');
    out.port = port;
  }
  if ('service' in r) {
    const service = String(r.service ?? '').trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(service)) bad('Service must be one word of letters, digits, . _ or -');
    out.service = service;
  }
  if ('timeout' in r) {
    const t = Number(r.timeout);
    if (!Number.isInteger(t) || t < 5 || t > 3600) bad('Timeout must be 5 to 3600 seconds');
    out.timeout = t;
  }
  if ('failClosed' in r) out.failClosed = r.failClosed === true;
  if ('enabled' in r) out.enabled = r.enabled === true;
  if (out.enabled && !out.host) bad('Enter the ICAP server before turning scanning on');
  return out;
}

let settings = { icap: { ...ICAP_DEFAULTS } };
try {
  settings.icap = cleanIcap(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).icap);
} catch (err) {
  if (err.code !== 'ENOENT') console.log(`ignoring ${SETTINGS_FILE}: ${err.message}`);
}

async function saveSettings(next) {
  // Temp and rename, as with uploads: a crash mid-write must not leave half a
  // JSON file that silently turns scanning off at the next start.
  const tmp = SETTINGS_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  await fsp.rename(tmp, SETTINGS_FILE);
  settings = next;
}

// --- ICAP ------------------------------------------------------------------
// A minimal RFC 3507 client: one REQMOD per file, the file sent as the body of
// a PUT so the scanner sees a name and the bytes. It streams from disk in
// chunks, so a large file is never held in memory, and it stops reading the
// reply at the end of the ICAP headers, because a block page follows them and
// nothing here needs it.

// What the scanner says about its own health rather than about the file.
// These are not verdicts: whether they stop an upload is the failClosed choice.
const SCANNER_FAULT = /licen[sc]e|unavailable|not available|not ready|failed to scan|scan fail|timed? ?out|no engine|error/i;

function readIcapHead(text) {
  const [status, ...lines] = text.split('\r\n');
  const code = Number(status.split(' ')[1]);
  const h = {};
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return { code, status, h };
}

function judge({ code, status, h }) {
  if (code === 204) return { verdict: 'clean' };
  if (code !== 200 && code !== 201) return { verdict: 'error', detail: status || 'unreadable ICAP reply' };

  // For a request modification, being answered with a *response* means the
  // scanner refused to pass the request on: the file is blocked.
  const refused = /^blocked$/i.test(h['x-response-info'] || '') || /res-hdr=/.test(h.encapsulated || '');
  if (!refused) return { verdict: 'clean' };

  const reason = h['x-response-desc'] || 'blocked by the scanner';
  const found = h['x-infection-found'] || h['x-violations-found'] || h['x-virus-id'] || '';
  const threat = (found.match(/Threat=([^;]+)/i) || [])[1]?.trim() || (found && !found.includes('=') ? found : '');
  if (SCANNER_FAULT.test(reason) && !threat) return { verdict: 'error', detail: reason };
  return { verdict: 'blocked', reason, threat };
}

// source: { size, stream() }. Resolves, never rejects: every failure is an
// 'error' verdict with something a person can act on.
async function icapScan(source, name, cfg) {
  const sock = net.connect({ host: cfg.host, port: cfg.port });
  sock.setTimeout(cfg.timeout * 1000);
  const ac = new AbortController();
  let finish;
  const answer = new Promise((resolve) => { finish = resolve; });
  const fault = (detail) => finish({ verdict: 'error', detail });

  let head = Buffer.alloc(0);
  sock.on('data', (c) => {
    head = Buffer.concat([head, c]);
    const end = head.indexOf('\r\n\r\n');
    if (end !== -1) finish(judge(readIcapHead(head.subarray(0, end).toString('latin1'))));
    else if (head.length > 64 * 1024) fault('unreadable ICAP reply');
  });
  sock.on('timeout', () => fault(`no answer from ${cfg.host}:${cfg.port} in ${cfg.timeout}s`));
  sock.on('error', (e) => fault(e.code === 'ECONNREFUSED' ? `${cfg.host}:${cfg.port} refused the connection`
    : e.code === 'ENOTFOUND' ? `cannot resolve ${cfg.host}` : e.message));
  sock.on('close', () => fault('the ICAP server closed the connection'));

  (async () => {
    try {
      await once(sock, 'connect', { signal: ac.signal });
      const put = async (b) => { if (!sock.write(b)) await once(sock, 'drain', { signal: ac.signal }); };

      const http = `PUT /${encodeURIComponent(name)} HTTP/1.1\r\nHost: pigeonhole\r\n` +
        `Content-Disposition: attachment; filename="${name.replace(/[^\x20-\x7E]|["\\]/g, '_')}"\r\n` +
        `Content-Type: application/octet-stream\r\nContent-Length: ${source.size}\r\n\r\n`;
      await put(`REQMOD icap://${cfg.host}:${cfg.port}/${cfg.service} ICAP/1.0\r\n` +
        `Host: ${cfg.host}\r\nAllow: 204\r\n` +
        `Encapsulated: req-hdr=0, req-body=${Buffer.byteLength(http)}\r\n\r\n${http}`);

      for await (const c of source.stream()) {
        if (ac.signal.aborted) return;
        await put(`${c.length.toString(16)}\r\n`);
        await put(c);
        await put('\r\n');
      }
      await put('0\r\n\r\n');
    } catch {
      // A scanner that decides early (a block, say) may close while the body
      // is still going out. Its answer, if there is one, is already in hand.
    }
  })();

  const result = await answer;
  ac.abort();
  sock.destroy();
  return result;
}

const scanFile = async (full, name, cfg) =>
  icapScan({ size: (await fsp.stat(full)).size, stream: () => fs.createReadStream(full) }, name, cfg);

// What "Test connection" does: ask what the server is (OPTIONS), then push a
// few harmless bytes through a real scan. OPTIONS alone would report a server
// that answers but cannot scan, which is exactly the state worth catching.
async function icapTest(cfg) {
  const t0 = Date.now();
  const options = await new Promise((resolve) => {
    const sock = net.connect({ host: cfg.host, port: cfg.port });
    let buf = '';
    const end = (r) => { sock.destroy(); resolve(r); };
    sock.setTimeout(8000, () => end({ error: `no answer from ${cfg.host}:${cfg.port}` }));
    sock.on('error', (e) => end({ error: e.code === 'ECONNREFUSED' ? `${cfg.host}:${cfg.port} refused the connection`
      : e.code === 'ENOTFOUND' ? `cannot resolve ${cfg.host}` : e.message }));
    sock.on('connect', () => sock.write(`OPTIONS icap://${cfg.host}:${cfg.port}/${cfg.service} ICAP/1.0\r\nHost: ${cfg.host}\r\n\r\n`));
    sock.on('data', (c) => {
      buf += c.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        const { code, status, h } = readIcapHead(buf.slice(0, buf.indexOf('\r\n\r\n')));
        end(code === 200 ? { server: h.service || h['server'] || 'ICAP server', methods: h.methods || '' }
                         : { error: status });
      }
    });
    sock.on('close', () => end({ error: 'the ICAP server closed the connection' }));
  });
  if (options.error) return { ok: false, error: options.error };

  const sample = Buffer.from('pigeonhole connection test\n');
  const scan = await icapScan({ size: sample.length, stream: () => Readable.from([sample]) },
                              'pigeonhole-test.txt', { ...cfg, timeout: 20 });
  const ms = Date.now() - t0;
  if (scan.verdict === 'clean') return { ok: true, server: options.server, methods: options.methods, ms };
  return {
    ok: false, server: options.server, ms,
    error: scan.verdict === 'error' ? `${options.server} answers but cannot scan: ${scan.detail}`
      : `${options.server} blocked the test file: ${scan.reason}`,
  };
}

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
  // complete until someone runs it. Scanning slots in before the rename for
  // the same reason: a file under scrutiny is never visible under its name.
  const tmp = full + '.part';
  try {
    await pipeline(req, fs.createWriteStream(tmp));

    const cfg = settings.icap;
    let scan = 'off', note;
    if (cfg.enabled) {
      const r = await scanFile(tmp, name, cfg);
      if (r.verdict === 'blocked') {
        await fsp.rm(tmp, { force: true });
        return json(res, 422, { error: 'blocked', reason: r.reason, threat: r.threat, name });
      }
      if (r.verdict === 'error') {
        if (cfg.failClosed) {
          await fsp.rm(tmp, { force: true });
          return json(res, 502, { error: 'scan failed', detail: r.detail, name });
        }
        scan = 'skipped'; note = r.detail;
      } else scan = 'clean';
    }

    await fsp.rename(tmp, full);
    const st = await fsp.stat(full);
    json(res, 200, { ok: true, name, size: st.size, scan, note });
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

    if (req.method === 'GET' && p === '/api/settings') {
      return json(res, 200, settings);
    }

    if (req.method === 'PUT' && p === '/api/settings') {
      const body = await readJson(req);
      const next = { ...settings, icap: cleanIcap({ ...settings.icap, ...body.icap }) };
      await saveSettings(next);
      return json(res, 200, settings);
    }

    // Tries the values on the page, not the saved ones, so a server can be
    // checked before it is committed to.
    if (req.method === 'POST' && p === '/api/settings/icap-test') {
      const body = await readJson(req);
      const cfg = cleanIcap({ ...body, enabled: false });
      if (!cfg.host) return json(res, 400, { error: 'Enter the ICAP server first' });
      return json(res, 200, await icapTest(cfg));
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
    json(res, err.status || (err instanceof SyntaxError ? 400 : 500),
         { error: String(err.message || err) });
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
