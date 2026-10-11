(globalThis as any).__ROSEFN_SKIP_MINIFY = true;

import http from 'node:http';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { createEdgeHandler } from './edge.ts';
import { onShutdown, runShutdownHooks } from './shutdown.ts';
import { requestOrigin } from './origin.ts';

const dist = fileURLToPath(new URL('./', import.meta.url));
const port = Number(process.env.PORT || 8080);
let handle: ((request: Request) => Promise<Response>) | null = null;
let mod: any = null;
let warmList: string[] = [];

const requestAls = new AsyncLocalStorage<Record<string, unknown>>();

/** Run `fn` with a private per-request context bag. */
function runIsolated<T>(fn: () => T): T {
  return requestAls.run({}, fn);
}

// Extra roots searched for baked assets, after `dist` itself.
let extraRoots: string[] | null = null;
function resolveStaticRoots(): string[] {
  if (extraRoots) return extraRoots;
  const seen = new Set<string>([dist]);
  const add = (p: string) => {
    if (p && !seen.has(p)) seen.add(p);
  };
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    add(path.join(dist, '..'));
    add(path.join(dist, '..', '..'));
    add(path.resolve(dist, '..', 'public'));
    add(path.resolve(dist, '..', 'xoboe'));
  }
  add(path.join(dist, 'xoboe'));
  add(path.resolve(dist, '..', 'xoboe'));
  add(path.resolve(process.cwd(), 'xoboe'));
  extraRoots = [...seen];
  return extraRoots;
}

// A request path that must never reach the dynamic render.
function isBakedAssetPath(pathname: string): boolean {
  return (
    pathname.startsWith('/public/') ||
    pathname.startsWith('/icons/') ||
    pathname.startsWith('/vendor/') ||
    pathname === '/favicon.ico'
  );
}

const earlyHintLinks: string[] = (() => {
  try {
    const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    const links: string[] = [];
    for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
      const v = `<${m[1]}>; rel=preload; as=script`;
      if (!links.includes(v)) links.push(v);
    }
    for (const m of html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)) {
      const href = /href="([^"]+)"/.exec(m[0])?.[1];
      if (href) { const v = `<${href}>; rel=preload; as=style`; if (!links.includes(v)) links.push(v); }
    }
    for (const m of html.matchAll(/<link[^>]+href="([^"]+)"[^>]+rel="stylesheet"[^>]*>/g)) {
      const v = `<${m[1]}>; rel=preload; as=style`;
      if (!links.includes(v)) links.push(v);
    }
    return links;
  } catch { return []; }
})();

const ready = createEdgeHandler(dist).then(async (h) => {
  handle = h;
  try {
    mod = await import(new URL('./server.js', import.meta.url).href);
    warmList = ['/', ...((mod.dynamicRoutes as string[]) || []).filter((r: string) => !r.includes(':'))];
    mod.invalidateRenderCache?.();
  } catch { /* warm list stays just the home route */ }
  mod?.installContextStore?.({
    getStore: () => requestAls.getStore(),
    run: (store: Record<string, unknown>, fn: () => unknown) => requestAls.run(store, fn),
  });
  return h;
});

const shouldWarm = !process.env.VERCEL;
if (shouldWarm) ready.then(async (h) => {
  for (const r of warmList) {
    try {
      const res = await runIsolated(() => h(new Request('http://localhost' + r)));
      const buf = await res.arrayBuffer();
      const suspect = res.status === 200 && res.headers.get('content-type')?.includes('text/html') && buf.byteLength < 2048;
      console.log('[rosefn] warm', r, 'status=' + res.status, 'bytes=' + buf.byteLength, suspect ? 'SUSPECT-EMPTY' : '');
    } catch (e) {
      console.error('[rosefn] warm', r, 'FAILED:', (e as Error)?.stack ?? e);
    }
  }
}).catch((e) => console.error('[rosefn] warm loop aborted:', (e as Error)?.stack ?? e));

const hotCache = new Map<string, { raw: Buffer; br: Buffer; gzip: Buffer; headers: Record<string, string>; etag: string; fetchedAt: number; refreshing?: boolean }>();
const HOT_TTL = 10_000;

/**
 * One access line per request on stdout - the same greppable shape the CLI's
 * `rosefn serve` writes, so one grep works across every rosefn server.
 *
 * prod-server had NO access log at all: the platform request log showed a
 * status and a duration, and the server itself said nothing, so a blank first
 * visit was reported repeatedly with nothing to read. Every response exit in
 * the http handler calls this, which makes a log export readable line by line
 * against what the render actually produced.
 */
function writeAccessLine(req: any, res: any, bytes: number): void {
  console.log(`${new Date().toISOString().slice(0, 19)}Z ${req.method} ${req.url} ${res.statusCode} ${bytes}B`);
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

async function refetchHot(pathname: string, cookieHeader: string): Promise<void> {
  const headers: Record<string, string> = { 'user-agent': 'rosefn-hot' };
  if (cookieHeader) headers.cookie = cookieHeader;
  const response = await runIsolated(() => handle!(new Request('http://localhost' + pathname, { headers })));
  const csp = response.headers.get('content-security-policy') || '';
  const key = pathname + '|' + fnv(cookieHeader);
  if (response.status !== 200 || csp.includes('nonce-')) {
    hotCache.delete(key);
    return;
  }
  const head: Record<string, string> = {};
  response.headers.forEach((v, k) => { if (k !== 'content-length' && k !== 'date' && k !== 'content-encoding') head[k] = v; });
  const raw = Buffer.from(await response.arrayBuffer());
  const compressed = raw.length > 1024;
  hotCache.set(key, {
    raw,
    br: compressed ? zlib.brotliCompressSync(raw) : raw,
    gzip: compressed ? zlib.gzipSync(raw, { level: 9 }) : raw,
    compressed,
    headers: head,
    etag: `W/"${raw.length}-${fnv(cookieHeader)}"`,
    fetchedAt: Date.now(),
  });
}

function warmHot(pathname: string, cookieHeader: string): void {
  refetchHot(pathname, cookieHeader)
    .catch(() => {
      const e = hotCache.get(pathname + '|' + fnv(cookieHeader));
      if (e) { e.refreshing = false; e.fetchedAt = Date.now() - HOT_TTL + 2000; }
    })
    .finally(() => {
      const e = hotCache.get(pathname + '|' + fnv(cookieHeader));
      if (e) e.refreshing = false;
    });
}

function tryHot(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (req.method !== 'GET') return false;
  const q = req.url || '/';
  const qm = q.indexOf('?');
  if (qm >= 0) return false;
  const cookieHeader = String(req.headers.cookie || '');
  const key = q + '|' + fnv(cookieHeader);
  const entry = hotCache.get(key);
  if (!entry) return false;
  const age = Date.now() - entry.fetchedAt;
  if (age > HOT_TTL && !entry.refreshing) {
    entry.refreshing = true;
    warmHot(q, cookieHeader);
  }
  res.statusCode = 200;
  for (const k in entry.headers) res.setHeader(k, entry.headers[k]);
  res.setHeader('ETag', entry.etag);
  if (req.headers['if-none-match'] === entry.etag) {
    res.statusCode = 304;
    res.end();
    writeAccessLine(req, res, 0);
    return true;
  }
  const compressed = (entry as any).compressed !== false;
  const accept = String(req.headers['accept-encoding'] || '');
  const enc = compressed ? (/br\b/i.test(accept) ? 'br' : /gzip\b/i.test(accept) ? 'gzip' : null) : null;
  if (enc) {
    res.setHeader('Content-Encoding', enc);
    const body = enc === 'br' ? entry.br : entry.gzip;
    res.end(body);
    writeAccessLine(req, res, body.length);
  } else {
    res.end(entry.raw);
    writeAccessLine(req, res, entry.raw.length);
  }
  return true;
}

function fillHot(pathname: string, cookieHeader: string, response: Response): void {
  const csp = response.headers.get('content-security-policy') || '';
  if (response.status !== 200 || csp.includes('nonce-')) return;
  const head: Record<string, string> = {};
  response.headers.forEach((v, k) => { if (k !== 'content-length' && k !== 'date' && k !== 'content-encoding') head[k] = v; });
  response.arrayBuffer().then((ab) => {
    const raw = Buffer.from(ab);
    hotCache.set(pathname + '|' + fnv(cookieHeader), {
      raw,
      compressed: raw.length > 1024,
      br: raw.length > 1024 ? zlib.brotliCompressSync(raw) : raw,
      gzip: raw.length > 1024 ? zlib.gzipSync(raw, { level: 9 }) : raw,
      headers: head,
      etag: `W/"${raw.length}-${fnv(cookieHeader)}"`,
      fetchedAt: Date.now(),
    });
  }).catch(() => {});
}

const fileCache = new Map<string, { raw: Buffer; br: Buffer; gzip: Buffer; etag: string; mtimeMs: number }>();
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
};

try {
  const raw = fs.readFileSync(new URL('../.env', import.meta.url), 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
} catch { /* no .env: fine */ }
const REVALIDATE_TOKEN = process.env.ROSEFN_REVALIDATE_TOKEN || '';
let revalidateMod: any = null;

function handleRevalidate(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (req.method !== 'POST' || !req.url!.startsWith('/__rosefn/revalidate')) return false;
  if (!REVALIDATE_TOKEN) { res.statusCode = 404; res.end(); return true; }
  if (req.headers['x-rosefn-token'] !== REVALIDATE_TOKEN) {
    res.statusCode = 403; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'invalid token' })); return true;
  }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    try {
      if (!revalidateMod) revalidateMod = mod;
      const payload = JSON.parse(body || '{}');
      if (payload.all) {
        revalidateMod.invalidateRenderCache();
        res.end(JSON.stringify({ revalidated: true, scope: 'all' }));
      } else {
        let n = 0;
        for (const p of payload.paths || []) n += revalidateMod.invalidatePath(String(p));
        res.end(JSON.stringify({ revalidated: true, paths: (payload.paths || []).length, dropped: n }));
      }
    } catch (e: any) {
      res.statusCode = 400; res.end(JSON.stringify({ error: String(e).slice(0, 120) }));
    }
  });
  return true;
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, rawUrl: string): boolean {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL('http://localhost' + rawUrl).pathname);
  } catch {
    return false;
  }
  if (pathname.includes('\0') || pathname.includes('..')) return false;
  const ext = path.extname(pathname).toLowerCase();
  if (!TYPES[ext]) return false;
  let filePath = '';
  let st: fs.Stats | null = null;
  for (const root of resolveStaticRoots()) {
    const candidate = path.join(root, pathname);
    if (!candidate.startsWith(root)) continue;
    try {
      const s = fs.statSync(candidate);
      if (!s.isFile()) continue;
      filePath = candidate;
      st = s;
      break;
    } catch {
      // not under this root; try the next one
    }
  }
  if (!st) return false;
  let entry = fileCache.get(filePath);
  if (!entry || entry.mtimeMs !== st.mtimeMs) {
    const raw = fs.readFileSync(filePath);
    entry = {
      raw,
      compressed: raw.length > 1024,
    br: raw.length > 1024 ? zlib.brotliCompressSync(raw) : raw,
      gzip: raw.length > 1024 ? zlib.gzipSync(raw, { level: 9 }) : raw,
      etag: `W/"${st.size}-${st.mtimeMs}"`,
      mtimeMs: st.mtimeMs,
    };
    fileCache.set(filePath, entry);
    if (fileCache.size > 500) fileCache.delete(fileCache.keys().next().value as string);
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', TYPES[ext]);
  res.setHeader('ETag', entry.etag);
  res.setHeader('Vary', 'Accept-Encoding');
  const isEntryDoc = pathname === '/' || pathname.endsWith('/') || TYPES[ext].startsWith('text/html');
  res.setHeader('Cache-Control', isEntryDoc ? 'public, max-age=0, must-revalidate' : 'public, max-age=3600');
  if (req.headers['if-none-match'] === entry.etag) {
    res.statusCode = 304;
    res.end();
    writeAccessLine(req, res, 0);
    return true;
  }
  const compressed = (entry as any).compressed !== false;
  const accept = String(req.headers['accept-encoding'] || '');
  const enc = compressed ? (/br\b/i.test(accept) ? 'br' : /gzip\b/i.test(accept) ? 'gzip' : null) : null;
  if (enc) {
    res.setHeader('Content-Encoding', enc);
    const body = enc === 'br' ? entry.br : entry.gzip;
    res.end(body);
    writeAccessLine(req, res, body.length);
  } else {
    res.end(entry.raw);
    writeAccessLine(req, res, entry.raw.length);
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    await ready;
    if (handleRevalidate(req, res)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      hotCache.clear();
      const fn = (mod as any).invalidateRenderCache;
      if (typeof fn === 'function') fn();
    }
    if (hotCache.size > 0 && tryHot(req, res)) return;
    if (req.method === 'GET' && !req.headers.cookie && hotCache.size === 0) {
      for (const r of warmList) warmHot(r, '');
    }
    if (hotCache.size > 0 && tryHot(req, res)) return;
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (serveStatic(req, res, req.url || '/')) return;
      let p = '/';
      try {
        p = decodeURIComponent(new URL('http://localhost' + (req.url || '/')).pathname);
      } catch {
        p = req.url || '/';
      }
      p = p.split('?')[0]!;
      if (isBakedAssetPath(p)) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.end('not found');
        writeAccessLine(req, res, 0);
        return;
      }
    }
    const url = requestOrigin(req, port) + (req.url || '/');
    const init: RequestInit = { method: req.method, headers: req.headers as any };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      (init as any).body = Readable.toWeb(req) as any;
      (init as any).duplex = 'half';
    }
    const cookieHeader = String(req.headers.cookie || '');
    if (earlyHintLinks.length && req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')) {
      try { res.writeEarlyHints({ link: earlyHintLinks }); } catch { /* client gone: the render still finishes */ }
    }
    const replayable = req.method === 'GET' || req.method === 'HEAD';
    let response: Response;
    try {
      response = await runIsolated(() => handle!(new Request(url, init)));
    } catch (err) {
      if (!replayable) throw err;
      console.warn('[rosefn] render failed, retrying once:', (err as Error)?.message ?? err);
      await new Promise((r) => setTimeout(r, 200));
      response = await runIsolated(() => handle!(new Request(url, init)));
    }
    if (req.method === 'GET') fillHot(req.url || '/', cookieHeader, response.clone());
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    const htmlDoc = (response.headers.get('content-type') ?? '').startsWith('text/html');
    const accept = String(req.headers['accept-encoding'] ?? '');
    if (response.body && htmlDoc && (accept.includes('br') || accept.includes('gzip'))) {
      const raw = Buffer.from(await response.arrayBuffer());
      const etag = 'W/"' + createHash('sha1').update(raw).digest('base64url').slice(0, 24) + '"';
      if (req.method === 'GET' && req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        res.end();
        writeAccessLine(req, res, 0);
        return;
      }
      res.setHeader('ETag', etag);
      const compressed = accept.includes('br')
        ? zlib.brotliCompressSync(raw)
        : zlib.gzipSync(raw);
      res.setHeader('Content-Encoding', accept.includes('br') ? 'br' : 'gzip');
      res.setHeader('Content-Length', String(compressed.length));
      res.end(compressed);
      writeAccessLine(req, res, compressed.length);
    } else if (response.body) {
      const raw = Buffer.from(await response.arrayBuffer());
      res.end(raw);
      writeAccessLine(req, res, raw.length);
    } else {
      res.end();
      writeAccessLine(req, res, 0);
    }
  } catch (err) {
    console.error('[rosefn] request failed:', (err as Error)?.stack ?? err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    }
    res.end('server error');
    writeAccessLine(req, res, 13);
  }
});

if (!process.env.VERCEL) {
  server.listen(port, () => {
    console.log(`🌹 rosefn prod server on http://localhost:${port}`);
  });

  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref?.();
    server.close(() => {
      void runShutdownHooks(signal).finally(() => {
        clearTimeout(force);
        process.exit(0);
      });
    });
    server.closeIdleConnections?.();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

export default server;

export { onShutdown, runShutdownHooks };

void mod?.invalidateRenderCache;
