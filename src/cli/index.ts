/**
 * rosefn CLI - simplest possible SSR + static server
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { createRequire } from 'module';
import { pathToFileURL, fileURLToPath } from 'url';
import { buildProject, scanRoseFiles, scriptOf, type RouteInfo } from '../compiler/index.js';
import { getHtmlShell, getClientSource, shellOpen, clientScriptTag, securityHeaders, setBundleMode } from './shell.js';
// Type-only: erased by esbuild/tsx, so the published CLI stays a ~100 KB
// bundle with no TypeScript dependency. `rosefn check` loads the PROJECT's
// own typescript at runtime instead.
import type * as ts from 'typescript';

// --- wire performance: compression + conditional caching (stdlib only) ---
// The Go binary already compresses; the Node server must match it or the
// headline "1 request / 6.89 KB gzip" holds on only one of the two servers.
type Encoding = 'br' | 'gzip' | 'deflate';

function pickEncoding(req: any): Encoding | null {
  const ae: string = req.headers['accept-encoding'] || '';
  // Trade-off: substring match, no q-value parsing - every browser that sends
  // br also accepts gzip, and br > gzip > deflate is the quality order.
  if (ae.includes('br')) return 'br';
  if (ae.includes('gzip')) return 'gzip';
  if (ae.includes('deflate')) return 'deflate';
  return null;
}

// Brotli's default quality (11) spends ~108 ms of CPU on a 32 KB document;
// quality 5 does the same document in ~2.4 ms for 9% more bytes (measured,
// Node 22). A dynamic response is compressed per request and nobody caches
// it, so that CPU is pure latency: 45x slower to save 8% of bytes that are
// already 170x smaller than the same page built the usual way. The static path keeps
// quality 11 - see the file cache below, where those bytes are paid for once
// and then served from memory, and they ARE the headline number.
// Trade-off: one constant, shared by the buffered and the streaming paths.
const brotliFast = { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 };

function compress(enc: Encoding, data: string | Buffer): Buffer {
  if (enc === 'br') return zlib.brotliCompressSync(data, { params: brotliFast });
  if (enc === 'gzip') return zlib.gzipSync(data);
  return zlib.deflateSync(data);
}

function createCompressor(enc: Encoding): zlib.Gzip | zlib.Deflate | zlib.BrotliCompress {
  if (enc === 'br') return zlib.createBrotliCompress({ params: brotliFast });
  if (enc === 'gzip') return zlib.createGzip();
  return zlib.createDeflate();
}

/** Send a full HTML document, compressed when the client accepts it. */
function sendHtml(req: any, res: any, status: number, html: string, extraHeaders?: Record<string, string>): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Vary', 'Accept-Encoding');
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  // A weak ETag over the rendered bytes: revalidation answers a bodiless
  // 304 for dynamic renders too (a middleware makes every page route
  // dynamic, and its repeat visits must not re-transfer the document).
  // Trade-off: FNV-1a in hex - no crypto import for a cache validator.
  let hash = 0x811c9dc5;
  for (let i = 0; i < html.length; i++) {
    hash ^= html.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  const etag = `W/"${html.length}-${hash.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.setHeader('ETag', etag);
  const enc = pickEncoding(req);
  if (enc) {
    res.setHeader('Content-Encoding', enc);
    res.end(compress(enc, html));
  } else {
    res.end(html);
  }
}

// Copy a Web-standard Response's headers onto the Node response. set-cookie
// is the one header that may legally repeat, and res.setHeader overwrites -
// so gather the list through getSetCookie() (undici keeps them separate) and
// set it whole. One session cookie never hits this; a handler that rotates a
// token and clears the old one does.
function writeWebHeaders(web: any, res: any): void {
  const cookies = web.headers.getSetCookie?.() ?? [];
  web.headers.forEach((v: string, k: string) => {
    if (cookies.length && k.toLowerCase() === 'set-cookie') return;
    res.setHeader(k, v);
  });
  if (cookies.length) res.setHeader('set-cookie', cookies);
}

// A middleware's short-circuit: a Web-standard Response (status, headers,
// body) written straight to the Node response - a redirect, an auth wall,
// a rewrite. trade-off: uncompressed, like every framework's middleware
// response (they are tiny: a 302 has no body at all).
async function sendWebResponse(web: any, res: any): Promise<void> {
  writeWebHeaders(web, res);
  res.statusCode = web.status;
  res.end(Buffer.from(await web.arrayBuffer()));
}

// Static files: raw + both compressed forms cached per mtime (dev rebuilds
// change mtime; preview never does). trade-off: unbounded map - fine for a
// dev/preview server's handful of files; swap for an LRU if it ever isn't.
const fileCache = new Map<string, { mtimeMs: number; raw: Buffer; br: Buffer; gzip: Buffer; etag: string }>();

// (the "the framework is real" gate): the CLI builds ANY project,
// not just this repo's demo. `rosefn build [dir]` - the dir defaults to the
// cwd, so inside a project a bare `rosefn build` is all there is. The
// project's rosefn.config.js is read from that same dir (plugins).
// Trade-off: the output still lands in ./dist of the directory the command
// runs from (the repo's Go binary embeds <repo>/dist, and a project's own
// dist belongs beside the command you ran) - `cd` into the project, or pass
// its path and collect dist/ from here.
const SRC_DIR = process.argv[3] ? path.resolve(process.argv[3]) : process.cwd();
const OUT_DIR = path.join(process.cwd(), 'dist');
// PORT env override (default 3000): lets a preview server run beside a dev
// server on the same machine - the e2e ISR test does exactly that.
const PORT = Number(process.env.PORT) || 3000;

/**
 * Import dist/server.js, cached until the file changes on disk.
 *
 * The dev server rebuilds it on file changes, so a plain import() would
 * serve the cached (stale) module - re-import when mtime moves. But the
 * import must NOT be per-request: server state (stores mutated by server
 * actions) lives in that module, and a fresh import per request would
 * reset it on every hit, so an action's effect would vanish immediately.
 */
let serverModule: any = null;
let serverMtime = -1;
let serverVersion = 0;

async function loadServer(): Promise<any> {
  const file = path.join(OUT_DIR, 'server.js');
  const mtimeMs = fs.statSync(file).mtimeMs;
  if (!serverModule || mtimeMs !== serverMtime) {
    serverMtime = mtimeMs;
    serverVersion++;
    serverModule = await import(pathToFileURL(file).href + '?v=' + serverVersion);
  }
  return serverModule;
}

async function build(): Promise<void> {
 // The build reports the bundle mode ('inline' | 'split') so the
  // shell follows it for every document, header and streaming tag it emits
  const { routes, bundle } = await buildProject(SRC_DIR, OUT_DIR);
  // The previous build's prerendered output must not survive: a route that
  // stopped being static (it started reading getContext() or $store())
  // would otherwise leave its old baked document - and brotli sibling -
  // behind, and the Go binary embeds dist/ verbatim, so it would serve
  // that frozen file forever. Runs after the bundles are rewritten (an
  // in-flight dev request never sees a missing server.js) and before
  // prerender writes the new set.
  await clearPrerendered(OUT_DIR);
  setBundleMode(bundle);
  const skipped = await prerender(routes);
  // The broken-route manifest: the server reads it to pick the buffered path
  // for these routes, so their real 500 status survives (a flushed response
  // cannot change its status). Runtime-only breakage is not in here - it
  // degrades to the error page body under a 200, documented in the README.
  await fs.promises.writeFile(path.join(OUT_DIR, 'broken.json'), JSON.stringify(skipped));
 // Per-route response headers for the Go binary, which
  // has no compiler: it reads this file and merges the entries over its
  // own responses. `default` carries the strict CSP (hashed over the exact
  // inlined bundle + bootstrap bytes - the Go binary cannot recompute it,
  // it has no esbuild); the routes carry each route's exported headers.
  const ssrModule = await loadServer();
  await fs.promises.writeFile(path.join(OUT_DIR, 'headers.json'), JSON.stringify({
    default: securityHeaders(getClientSource()),
    routes: ssrModule.routeHeaders ?? [],
  }));
 // Precompressed brotli siblings (dist/<file>.br) for the
  // Go single binary. The binary embeds dist/ verbatim, so they ride along
  // and are served with zero per-request compression CPU - and the bytes
  // are exactly what the Node server compresses per file in memory, so
  // both servers deliver the same wire size.
  await writeBrotli(OUT_DIR);
}

/**
 * Write dist/<file>.br next to every compressible text file. trade-off:
 * extension allowlist + zlib's default quality - a 30 KB document
 * compresses in ~10 ms at build time, once, forever.
 */
const BROTLI_EXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt']);
async function writeBrotli(dir: string): Promise<void> {
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await writeBrotli(p);
      continue;
    }
    if (!BROTLI_EXT.has(path.extname(e.name).toLowerCase())) continue;
    await fs.promises.writeFile(p + '.br', zlib.brotliCompressSync(await fs.promises.readFile(p)));
  }
}

/**
 * Delete the prerendered output of a previous build: HTML documents and
 * baked API bodies, with their brotli siblings. Everything else in dist/
 * (the bundles, styles) was just rewritten by buildProject.
 *
 * Trade-off: Windows hands out transient EPERM/EBUSY when an antivirus or
 * the search indexer holds a just-written file, so a couple of retries
 * per file - a build that fails because a scanner blinked is the worst
 * kind of flake.
 */
async function clearPrerendered(dir: string): Promise<void> {
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await clearPrerendered(p);
      continue;
    }
    if (!/\.(?:html|json)(?:\.br)?$/.test(e.name)) continue;
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rm(p, { force: true });
        break;
      } catch (err) {
        if (attempt >= 2 || !/EPERM|EBUSY|EACCES/.test(String(err))) throw err;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
  }
}

/**
 * Prerender every static route to dist/<route>/index.html at build time.
 * Those files are served straight from disk: zero server work, instant TTFB.
 * Dynamic routes with an exported `params` map (e.g. blog posts) are
 * enumerated and prerendered per value; params without `params` keep
 * rendering on demand. A route exporting `revalidate = N` is baked like
 * any other and then kept fresh by the preview server's stale-while-
 * revalidate pass (ISR).
 */
async function prerender(routes: RouteInfo[]): Promise<string[]> {
  const ssrModule = await loadServer();
  const skipped: string[] = [];
  const write = async (routePath: string) => {
    // a synthetic cookie-less request: the middleware runs at build time
    // too, and a route it short-circuits (an auth wall, a maintenance
    // rewrite) simply is not static - it keeps rendering per request on
    // the servers, and no gated or rewritten content is ever baked into
    // the static deploy (the Go binary cannot run the middleware)
    const mw = await ssrModule.runMiddleware({ method: 'GET', url: routePath, headers: {} });
    if (mw) {
      console.error(`prerender skipped for ${routePath}: the middleware short-circuits at build time`);
      skipped.push(routePath);
      return;
    }
    const page = await ssrModule.renderPage(routePath);
    if (page.status === 500) {
      // The route's render failed and the error page rendered instead. Do
      // NOT bake that into a static file: a static server can only answer
      // 200, so the route keeps rendering on demand and stays a real 500.
      console.error(`prerender skipped for ${routePath}: render failed, the error page rendered`);
      skipped.push(routePath);
      return;
    }
    const routeDir = routePath === '/' ? OUT_DIR : path.join(OUT_DIR, routePath.slice(1));
    await fs.promises.mkdir(routeDir, { recursive: true });
 // csr = false routes bake a JS-free document: the file
    // on disk carries no bundle and no state script, so a visitor who lands
    // on it runs zero JavaScript.
    await fs.promises.writeFile(path.join(routeDir, 'index.html'), getHtmlShell(page.html, page.state, page.head, page.csr !== false));
    console.log(`prerendered ${routePath} -> ${path.relative(process.cwd(), path.join(routeDir, 'index.html'))}`);
  };

  for (const info of routes) {
    // routes that read the request context (getContext()) or a shared store
    // ($store()) are dynamic by construction: the bag is per-request and the
    // store is per-process, so a baked file would freeze one answer. They
    // keep rendering on demand (and the servers know them from the server
    // bundle's dynamicRoutes).
    if ((ssrModule.dynamicRoutes as string[]).includes(info.routePath)) {
      console.log(`dynamic route ${info.routePath}: per-request state (getContext/$store), rendered on demand`);
      continue;
    }
    if (info.paramNames.length === 0) {
      try {
        await write(info.routePath);
      } catch (err) {
        // One broken route (e.g. throwing $data) must not fail the whole build;
        // it simply keeps rendering on demand.
        console.error(`prerender skipped for ${info.routePath}: ${err instanceof Error ? err.message : err}`);
        skipped.push(info.routePath);
      }
      continue;
    }
    // dynamic route: enumerate the exported params map, if any. The maps are
    // re-exported by the server bundle (routeParams) - the component modules
    // are build-time intermediates and never ship in the deploy dir.
    try {
      const paramsExport = (ssrModule.routeParams as Record<string, unknown>)?.[info.routePath];
      const raw = typeof paramsExport === 'function' ? await (paramsExport as () => unknown)() : paramsExport;
      const paths = enumerateParams(info.pattern, info.paramNames, (raw ?? {}) as Record<string, unknown>);
      for (const p of paths) await write(p);
      if (paths.length === 0) console.log(`dynamic route ${info.routePath}: no params export, rendered on demand`);
    } catch (err) {
      console.error(`prerender skipped for ${info.routePath}: ${err instanceof Error ? err.message : err}`);
      skipped.push(info.routePath);
    }
  }

  // API routes that opt in (export const prerender = true) bake their GET
  // body into dist/api/<route>.json: the Go single binary then serves the
  // read-only API with zero Node. Non-2xx or non-GET-safe routes simply
  // don't bake - they stay live on the Node/edge server.
  const apiPrerender = (ssrModule.apiPrerender as Record<string, boolean>) ?? {};
  for (const [routePath, on] of Object.entries(apiPrerender)) {
    if (!on) continue;
    try {
      const res = await ssrModule.handleApi('GET', routePath, new Request('http://localhost' + routePath));
      if (res.status !== 200) {
        console.error(`api prerender skipped for ${routePath}: GET answered ${res.status}`);
        continue;
      }
      const body = await res.text();
      const outFile = path.join(OUT_DIR, routePath.slice(1) + '.json');
      await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
      await fs.promises.writeFile(outFile, body);
      console.log(`prerendered api ${routePath} -> ${path.relative(process.cwd(), outFile)}`);
    } catch (err) {
      console.error(`api prerender skipped for ${routePath}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return skipped;
}

/** Cartesian product of the params map -> concrete URL paths for the pattern. */
function enumerateParams(pattern: string, names: string[], raw: Record<string, unknown>): string[] {
  let combos: string[][] = [[]];
  for (const name of names) {
    const values = (Array.isArray(raw[name]) ? raw[name] : []).map((v) => String(v));
    combos = combos.flatMap((c) => values.map((v) => [...c, v]));
  }
  return combos.map((values) => {
    let i = 0;
    return pattern
      .split('/')
      .map((seg) => (seg.startsWith(':') ? encodeURIComponent(values[i++]) : seg))
      .join('/');
  });
}

// Extensions the static branch serves without touching the router: assets
// keep their fast path even when a middleware exists (a middleware guards
// pages, not files).
const ASSET_EXT = new Set(['.js', '.css', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.woff', '.woff2', '.txt', '.xml']);

// Response headers for a page document: the strict CSP
// (hashed over the exact inlined bundle + bootstrap bytes, so no
// 'unsafe-inline' is needed for scripts) plus the route's own exported
// headers, which win. Keys are lower-cased first: HTTP header names are
// case-insensitive, and an overridden header must not survive under a
// second spelling. The same data ships to the Go binary as
// dist/headers.json at build time.
function pageHeaders(ssrModule: any, pathname: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(securityHeaders(getClientSource()))) headers[k.toLowerCase()] = v;
  const own = ssrModule.headersFor?.(pathname) as Record<string, string> | null | undefined;
  if (own) for (const [k, v] of Object.entries(own)) headers[k.toLowerCase()] = v;
  return headers;
}

// ISR background pass: re-render a stale baked route and
// swap its file, while the triggering request was already answered from
// disk (stale-while-revalidate). One pass per file at a time - a burst of
// requests during staleness must not stampede - and the cached raw +
// compressed bytes are dropped so the next request reads the new file. A
// failed revalidation keeps the last good file (the same resilience as the
// build). trade-off: no queue, no metrics - one render per stale window;
// and the swap is a plain writeFile, not tmp+rename - a request landing in
// the microsecond of the write could read a partial file, the same race any
// static-file rewrite has; add the rename dance when it ever matters.
const isrBusy = new Set<string>();
function revalidateInBackground(routePath: string, filePath: string): void {
  if (isrBusy.has(filePath)) return;
  isrBusy.add(filePath);
  void (async () => {
    try {
      const ssrModule = await loadServer();
      const page = await ssrModule.renderPage(routePath);
      if (page.status === 200) {
 // the swap must honor the route's csr decision: a
        // zero-JS route revalidated here stays zero-JS, or the first stale
        // window would silently inline the bundle into its baked file
        await fs.promises.writeFile(filePath, getHtmlShell(page.html, page.state, page.head, page.csr !== false));
        fileCache.delete(filePath);
        console.log(`Rosefn: revalidated ${routePath} in the background`);
      }
    } catch (err) {
      console.error('Rosefn: background revalidation failed for', routePath, err instanceof Error ? err.message : err);
    } finally {
      isrBusy.delete(filePath);
    }
  })();
}

// --- production server posture --------------------------------------
//
// "Can run a real app" is a threshold, not a nice-to-have: a body any
// anonymous client can make you buffer until you die, a request that stalls
// holding a worker forever, a cross-site POST riding the victim's cookies,
// and a SIGTERM that drops every in-flight request are all disqualifying.

/** A request body is bounded. 1 MB holds any form and any JSON API call a
 * site this size makes; a deployment that needs more sets it explicitly. */
const MAX_BODY = Number(process.env.ROSEFN_MAX_BODY) || 1024 * 1024;

/**
 * Collect a request body, refusing anything past MAX_BODY with a 413. The
 * refusal stops buffering immediately, so a client streaming 10 GB gets one
 * small response instead of a 10 GB buffer.
 */
function readBody(req: any, res: any, onDone: (body: any) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let refused = false;
  req.on('data', (c: Buffer) => {
    if (refused) return;
    size += c.length;
    if (size > MAX_BODY) {
      refused = true;
      res.statusCode = 413;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`Payload too large (limit ${MAX_BODY} bytes)`);
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => { if (!refused) onDone(Buffer.concat(chunks)); });
  // an aborted upload must not throw an unhandled 'error' and take the
  // process down with it
  req.on('error', () => {});
}

/**
 * CSRF: a state-changing request that did not come from this site is
 * refused before anything else runs. Browsers stamp every cross-origin POST
 * with an Origin header, so the check is free for real browsers; a client
 * that sends neither Origin nor Sec-Fetch-Site (curl, a health check, the
 * test suites) is not attackable by CSRF - the attack rides the victim's
 * cookies in a browser - so it passes. Returns the refusal, or null.
 */
function crossSiteWrite(req: any): { status: number; body: string } | null {
  const m = req.method;
  if (m !== 'POST' && m !== 'PUT' && m !== 'PATCH' && m !== 'DELETE') return null;
  const origin = req.headers.origin;
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return { status: 403, body: 'Cross-site request blocked (unparsable Origin header)' };
    }
    return host === req.headers.host ? null : { status: 403, body: 'Cross-site request blocked (Origin does not match Host)' };
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
    return { status: 403, body: `Cross-site request blocked (sec-fetch-site: ${site})` };
  }
  return null;
}

/**
 * One access line per request on stdout - the same greppable shape the Go
 * binary writes (`ts method path status bytes duration`), with the worker id
 * in front when several workers share one stdout. Logged on the response's
 * finish, so a streamed route is recorded when it is actually done.
 */
function withAccessLog(handler: (req: any, res: any) => void, tag?: string): (req: any, res: any) => void {
  return (req, res) => {
    const started = process.hrtime.bigint();
    let bytes = 0;
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    res.write = (chunk: any, ...rest: any[]) => { if (chunk) bytes += Buffer.byteLength(chunk); return write(chunk, ...rest); };
    res.end = (chunk: any, ...rest: any[]) => { if (chunk) bytes += Buffer.byteLength(chunk); return end(chunk, ...rest); };
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const dur = ms >= 1 ? `${ms.toFixed(3)}ms` : `${(ms * 1000).toFixed(0)}us`;
      console.log(`${new Date().toISOString().slice(0, 19)}Z${tag ? ` [${tag}]` : ''} ${req.method} ${req.url} ${res.statusCode} ${bytes}B ${dur}`);
    });
    handler(req, res);
  };
}

function serveStatic(dir: string, isr = false): (req: any, res: any) => void {
  return (req, res) => {
    // The origin guard runs before everything else - middleware, api
    // dispatch, the static lookup - because a cross-site write must not
    // reach any of them.
    const blocked = crossSiteWrite(req);
    if (blocked) {
      res.statusCode = blocked.status;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(blocked.body);
      return;
    }
    // Everything below needs the server module (API dispatch, POST actions,
    // SSR), so load it once up front: the import is cached until dist/server.js
    // changes on disk, and the promise makes the static path wait for it.
    loadServer().then(async (ssrModule: any) => {
      // Middleware (pages/_middleware.rose) runs exactly once per request,
      // before anything else: a returned Response short-circuits the whole
      // request (a redirect, an auth wall), and its getContext() bag seeds
      // the render that follows. Page POSTs skip this pass - their branch
      // below runs it with the parsed FormData so the middleware can read
      // form fields; api POSTs take this pass (method + url + headers is
      // what auth needs).
      const apiPath0 = pathnameOf(req.url);
      const isPagePost = req.method === 'POST' && !ssrModule.isApi(apiPath0);
      if (!isPagePost && ssrModule.middleware) {
        const mw = await ssrModule.runMiddleware(req);
        if (mw) {
          await sendWebResponse(mw, res);
          return;
        }
      }
      // API routes (pages/api/*.rose) dispatch FIRST: the /api namespace
      // answers JSON, never the static shell or an HTML page - an API client
      // must never receive the SPA fallback. The handler gets a Web-standard
      // Request (the same object the edge adapter passes), so handler code is
      // identical on both servers. trade-off: no compression here - JSON API
      // bodies are small, and there is nothing worth compressing.
      const apiPath = pathnameOf(req.url);
      if (ssrModule.isApi(apiPath)) {
        readBody(req, res, async (body) => {
          try {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(req.headers)) {
              if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
            }
            const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
              method: req.method || 'GET',
              headers,
              body: body.length > 0 ? body : undefined,
            });
            const apiRes = await ssrModule.handleApi(req.method || 'GET', apiPath, request);
            writeWebHeaders(apiRes, res);
            res.statusCode = apiRes.status;
            res.end(Buffer.from(await apiRes.arrayBuffer()));
          } catch {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end('{"error":"api handler failed"}');
          }
        });
        return;
      }

      // POST: run the matched route's server action (progressive-enhancement
      // form). This must precede the static lookup: prerendered files exist on
      // disk and would otherwise answer the POST without running the action.
      if (req.method === 'POST') {
        readBody(req, res, async (body) => {
          try {
            const form = await new Response(body, {
              headers: { 'content-type': req.headers['content-type'] || 'application/x-www-form-urlencoded' },
            }).formData();
            // the middleware pass for page POSTs: it rides with the parsed
            // FormData so it can read form fields, and its context seeds the
            // action + render below
            if (ssrModule.middleware) {
              const mw = await ssrModule.runMiddleware(req, form);
              if (mw) {
                await sendWebResponse(mw, res);
                return;
              }
            }
            const page = await ssrModule.renderPage(req.url || '/', form);
            sendHtml(req, res, page.status ?? 200, getHtmlShell(page.html, page.state, page.head, page.csr !== false), pageHeaders(ssrModule, pathnameOf(req.url || '/')));
          } catch {
            res.statusCode = 400;
            res.end('Bad request');
          }
        });
        return;
      }

      let safe = path.normalize(req.url || '/').replace(/^(\.\.(\/)?)+/, '');
      if (safe === '\\' || safe === '/') safe = '/';
      let filePath = path.join(dir, safe);

      // Directory -> index.html (prerendered routes live at /<route>/index.html)
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }

 // Build-time precompression siblings (dist/<file>.br,
      // read by the Go binary) are internal artifacts. A direct request for
      // one answers the real file - never raw brotli bytes mislabeled as the
      // page. A real asset that merely ends .br/.gz (no base file) is served
      // as itself.
      if (/\.(?:br|gz)$/i.test(safe)) {
        const base = filePath.replace(/\.(?:br|gz)$/i, '');
        if (fs.existsSync(base)) filePath = base;
      }

      // Serve real files directly - compressed + conditionally cached, so a
      // repeat visit costs a 304 instead of the full document. Assets always
      // take this path. A page route skips it when its component reads the
      // request context (getContext()): the bag is per-request, and a
      // prerendered file on disk was rendered once at build time - so those
      // routes render on demand instead. Public routes are unaffected: they
      // keep the file cache, the ETag/304, and streaming.
      const isAsset = ASSET_EXT.has(path.extname(safe).toLowerCase());
      const isDynamic = !isAsset && (ssrModule.dynamicRoutes as string[] | undefined)?.includes(pathnameOf(req.url));
      if (!isDynamic && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const st = fs.statSync(filePath);
 // ISR: a route exporting `revalidate = N` keeps its
        // baked file for N seconds. Once stale, THIS request is still served
        // from disk - stale-while-revalidate: instant TTFB, never a wait,
        // never an error page - while a background pass re-renders and swaps
        // the file for the next visitor. Only the preview server opts in
        // (isr=true): dev rebuilds on change, and the edge adapter renders
        // live, so neither has a baked file to keep fresh. The window also
        // decides the response's Cache-Control: a document the server swaps
        // every N seconds must not tell a browser to hold it for an hour.
        const rev = isAsset ? undefined : ((ssrModule.revalidate as { pattern: string; seconds: number }[]) || [])
          .find((r) => ssrModule.matchRoute(r.pattern, pathnameOf(req.url)));
        if (isr && rev && Date.now() - st.mtimeMs > rev.seconds * 1000) {
          revalidateInBackground(pathnameOf(req.url), filePath);
        }
        let entry = fileCache.get(filePath);
        if (!entry || entry.mtimeMs !== st.mtimeMs) {
          const raw = fs.readFileSync(filePath);
          entry = {
            mtimeMs: st.mtimeMs,
            raw,
            br: zlib.brotliCompressSync(raw),
            gzip: zlib.gzipSync(raw),
            etag: `W/"${st.size}-${st.mtimeMs}"`,
          };
          fileCache.set(filePath, entry);
        }
        const ext = path.extname(filePath);
        const types: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
        };
        res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
        // An ISR route's file is swapped every `revalidate` seconds, so the
        // cache must not outlive the window: revalidate every visit (a
        // bodiless 304 when nothing changed) while allowing the browser to
        // paint the stale document during that revalidation - the same
        // stale-while-revalidate contract the server keeps, told to the
        // browser. Everything else (assets, non-ISR pages) keeps the hour.
        res.setHeader('Cache-Control', rev ? `public, max-age=0, stale-while-revalidate=${rev.seconds}` : 'public, max-age=3600');
        res.setHeader('ETag', entry.etag);
        res.setHeader('Vary', 'Accept-Encoding');
 // Per-route response headers: a prerendered
        // document carries the same policy the live render would send -
        // the strict CSP plus the route's own exported headers.
        if (ext === '.html') {
          for (const [k, v] of Object.entries(pageHeaders(ssrModule, pathnameOf(req.url)))) res.setHeader(k, v);
        }
        if (req.headers['if-none-match'] === entry.etag) {
          res.statusCode = 304;
          res.end();
          return;
        }
        const enc = pickEncoding(req);
        res.statusCode = 200;
        if (enc) {
          res.setHeader('Content-Encoding', enc);
          res.end(enc === 'br' ? entry.br : enc === 'gzip' ? entry.gzip : compress('deflate', entry.raw));
        } else {
          res.end(entry.raw);
        }
        return;
      }

      // Otherwise render the route via SSR (dynamic routes, 404s, and every
      // page route when a middleware exists: its per-request context must be
      // live, and a prerendered file on disk was rendered once at build
      // time). Streamed by default: the static shell flushes before the
      // render completes, so the first byte leaves in microseconds instead
      // of after every $data resolves - still exactly one request,
      // compressed on the wire. canStream pre-checks the route table (the
      // edge adapter does the same), so the 200 can be committed before the
      // render; routes known-broken at build time (dist/broken.json) take
      // the buffered path instead: their 500 status cannot survive a flush
      // (headers cannot be unsent). csr = false routes also buffer: a
      // streamed no-JS document would carry the shell's default <title>,
      // because the route head is applied client-side at boot and there is
 // no client .
      let broken = new Set<string>();
      try {
        broken = new Set(JSON.parse(fs.readFileSync(path.join(dir, 'broken.json'), 'utf-8')));
      } catch { /* no manifest: nothing known-broken */ }
      const safe2 = req.url || '/';
      if (!broken.has(safe2) && ssrModule.canStream(safe2) && !ssrModule.isNoJs(safe2)) {
        const enc = pickEncoding(req);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Vary', 'Accept-Encoding');
        for (const [k, v] of Object.entries(pageHeaders(ssrModule, pathnameOf(safe2)))) res.setHeader(k, v);
        let write: (chunk: string) => void;
        let done: () => void;
        if (enc) {
          res.setHeader('Content-Encoding', enc);
          const compressor = createCompressor(enc);
          compressor.pipe(res);
          // The shell must reach the socket NOW. Without a flush zlib emits
          // nothing until end(), so the "streamed" route's first byte would
          // arrive after the whole render - measured: 0 bytes before end(),
          // which made /sign's TTFB its slowest $data instead of ~0.
          // Z_FULL_FLUSH, not Z_SYNC_FLUSH: on Node 22 a sync flush poisons
          // the brotli stream (every later write ends in
          // ERR_BROTLI_COMPRESSION_FAILED - reproduced in isolation), while a
          // full flush emits the shell at ~10 ms and completes cleanly. The
          // cost is one empty block boundary, which quality 5 barely notices.
          let flushed = false;
          write = (chunk) => {
            compressor.write(chunk);
            if (!flushed) {
              flushed = true;
              compressor.flush(zlib.constants.Z_FULL_FLUSH);
            }
          };
          // pipe() forwards data but not errors, and an unhandled 'error'
          // event kills the worker. A compressor fault must cost one socket,
          // not the process: destroy it and let the client retry.
          compressor.on('error', () => res.destroy());
          done = () => compressor.end();
        } else {
          write = (chunk) => res.write(chunk);
          done = () => res.end();
        }
        await ssrModule.renderPageStream(safe2, write, shellOpen(), clientScriptTag(getClientSource()));
        done();
        return;
      }
      // buffered: POST actions, unmatched routes (404), known-broken routes
 // (500), and csr = false routes (a no-JS document must
      // not stream - the route's <head> is only known after the render, and
      // there is no client to apply it at boot)
      const page = await ssrModule.renderPage(safe2);
      sendHtml(req, res, page.status ?? 200, getHtmlShell(page.html, page.state, page.head, page.csr !== false), pageHeaders(ssrModule, pathnameOf(safe2)));
    }).catch(() => {
      res.statusCode = 404;
      res.end('Not found');
    });
  };
}

/** Strip the query string: routing matches the pathname, handlers read the full URL. */
function pathnameOf(url: string | undefined): string {
  try {
    return new URL(url || '/', 'http://localhost').pathname;
  } catch {
    return (url || '/').split('?')[0];
  }
}

/**
 * The version from package.json - one source of truth, no constant to drift.
 * Resolved from THIS module (not the cwd): the banner names the framework's
 * version even when it builds somebody else's project. Two layouts answer:
 * in the repo this module sits at src/cli/, in the published package the CLI
 * is bundled to dist-cli/ with the sources beside it - so try both.
 */
function version(): string {
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      const v = JSON.parse(fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')).version;
      if (v) return v;
    } catch { /* not this layout */ }
  }
  return '0.0.0';
}

async function dev(): Promise<void> {
  console.log(`🌹 Rosefn v${version()} dev server starting...`);
  try {
    await build();
  } catch (err) {
    // A broken .rose file must not prevent the server from starting; the
    // watcher below rebuilds as soon as the file is fixed.
    console.error('Initial build failed (server still running):', err instanceof Error ? err.message : err);
  }

  let timeout: any;
  fs.watch(SRC_DIR, { recursive: true }, () => {
    clearTimeout(timeout);
    timeout = setTimeout(async () => {
      try {
        console.log('Rebuilding...');
        await build();
      } catch (err) {
        // Never let a user-code error kill the dev server.
        console.error('Build failed (server still running):', err instanceof Error ? err.message : err);
      }
    }, 200);
  });

  const http = await import('http');
  const server = http.createServer(serveStatic(OUT_DIR));

  server.listen(PORT, () => {
    console.log('🌹 http://localhost:' + PORT);
  });
}

async function preview(): Promise<void> {
  await build();
  const http = await import('http');
  // isr=true: routes exporting `revalidate = N` are served stale-then-swapped
 // from disk . Dev passes nothing (it rebuilds on change).
  const server = http.createServer(serveStatic(OUT_DIR, true));

  server.listen(PORT, () => {
    console.log(`🌹 Rosefn v${version()} preview at http://localhost:` + PORT);
  });
}

/**
 * `rosefn serve` runs what `build` produced - no rebuild, no
 * watcher, production semantics (a preview that re-rendered on the fly
 * could serve a half-written file). Multi-core through the stdlib cluster:
 * the primary supervises and serves no traffic, the workers serve; every
 * request is logged; SIGTERM drains in-flight work and exits.
 *
 * Boundaries, stated plainly:
 *  - each worker is its own process with its own dist/server.js module.
 *    Module-scope state is therefore per-worker, which is what $store()
 * fixes: writes broadcast through the primary, reads stay
 *    local-synchronous. ISR revalidation may run in more than one worker
 *    for one route: the guard is per-worker and the cost is one duplicate
 *    render.
 *  - the signal-driven drain is POSIX behavior. On Windows a kill() is
 *    abrupt by the platform's design, so the worker instead exits on the
 *    primary's death (the disconnect handler below) - a killed primary must
 *    never leave orphans holding the port.
 */
async function serve(): Promise<void> {
  if (!fs.existsSync(path.join(OUT_DIR, 'server.js'))) {
    console.error(`Rosefn: ${OUT_DIR} has no server.js - run rosefn build first`);
    process.exit(1);
  }
  // .default: node:cluster is an `export =` module, so the dynamic import
  // hands back the namespace with the real module on `.default`
  const cluster = (await import('node:cluster')).default as any;
  // Round-robin the accepts between workers. The default leaves the handout
  // to the operating system, and on Windows that hands nearly every
  // connection to whichever worker happens to accept first - one core does
  // all the work on a multi-core box, exactly what the cluster exists to
  // prevent. The primary does the balancing, so it costs the workers
  // nothing.
  cluster.schedulingPolicy = cluster.SCHED_RR;
  const os = await import('node:os');
  const workers = Math.max(1, Number(process.env.ROSEFN_WORKERS) || os.cpus().length);
  const PORT = Number(process.env.PORT) || 3000;
  if (cluster.isPrimary) {
    for (let i = 0; i < workers; i++) cluster.fork();
 // The store relay. A worker broadcasts every $store write here;
    // the primary forwards each patch to every OTHER worker (the writer
    // already holds the value locally - the patch is for its siblings), so
    // shared state survives the cluster instead of living in one worker.
    cluster.on('message', (worker: any, msg: any) => {
      if (!msg || msg.type !== 'rosefn:store') return;
      for (const w of Object.values<any>(cluster.workers ?? {})) {
        if (w && w.id !== worker.id) w.send(msg);
      }
    });
    let live = workers;
    const stop = () => {
      for (const w of Object.values<any>(cluster.workers ?? {})) w.kill();
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    cluster.on('exit', () => { if (--live <= 0) process.exit(0); });
    console.log(`🌹 Rosefn v${version()} serve: ${workers} worker${workers > 1 ? 's' : ''} on http://localhost:${PORT} (cluster, bounded bodies, graceful shutdown, access log on stdout)`);
    return;
  }
  // worker
  // the primary's death is the worker's death: no orphan holding the port
  process.on('disconnect', () => process.exit(0));
  const http = await import('node:http');
  const server = http.createServer(withAccessLog(serveStatic(OUT_DIR, true), `w${process.pid}`));
  // A client that stalls mid-request is dropped instead of holding a worker;
  // idle keep-alive sockets close so a drained worker can actually exit.
  server.requestTimeout = 30_000;
  server.headersTimeout = 65_000; // must exceed requestTimeout
  server.keepAliveTimeout = 5_000;
  server.listen(PORT, () => console.log(`🌹 Rosefn worker ${process.pid} listening on http://localhost:${PORT}`));
  const stop = () => {
    server.close(() => process.exit(0)); // finish what is in flight
    server.closeIdleConnections?.();      // drop the idle keep-alive sockets
    setTimeout(() => process.exit(0), 5000).unref(); // a stuck one must not hold the worker
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/**
 * `rosefn new <name>` - a starting project. The smallest thing that builds
 * and runs and shows the syntax: one page (state, {#if}, {#each}, a scoped
 * style), one README naming the three commands. Not a second demo app - the
 * point is that a new developer's first `rosefn build` works in seconds.
 *
 * Trade-off: three files, written from strings. No template engine, no
 * dependency, no `npm install` run on the developer's behalf (they may use
 * pnpm/yarn/bun, and a surprise install is worse than a printed command).
 */
async function scaffold(): Promise<void> {
  const name = process.argv[3];
  if (!name || name.startsWith('-')) {
    console.log('Usage: rosefn new <name>   (creates <name>/ with a page that builds)');
    return;
  }
  const dir = path.resolve(name);
  if (fs.existsSync(dir)) {
    console.error(`Rosefn: ${dir} already exists - pick another name`);
    process.exit(1);
  }
  const pages = path.join(dir, 'src', 'pages');
  fs.mkdirSync(pages, { recursive: true });

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: path.basename(dir),
    private: true,
    type: 'module',
    scripts: {
      dev: 'rosefn dev',
      build: 'rosefn build',
      preview: 'rosefn preview',
      serve: 'rosefn serve',
      check: 'rosefn check',
    },
    dependencies: { rosefn: `^${version()}` },
    // TypeScript is a first-class citizen: .rose scripts are typed, and
    // `npm run check` type-checks every one of them with THIS project's
    // TypeScript (the framework never drags its own copy in).
    devDependencies: { typescript: '^5.6.0' },
  }, null, 2) + '\n');

  // The ambient globals a .rose script can call ($state, $data, $t, ...),
  // pulled in from the installed package: editors and tsc both see them.
  fs.writeFileSync(path.join(dir, 'rosefn-env.d.ts'), `/// <reference types="rosefn" />\n`);
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    // the env file first (it is what makes the globals visible), then any
    // .ts the project grows - .rose scripts are checked by `npm run check`
    include: ['rosefn-env.d.ts', 'src/**/*.ts'],
  }, null, 2) + '\n');

  fs.writeFileSync(path.join(pages, 'index.rose'), `<script>
  // One file per route: markup, script and styles together.
  // The script block is TypeScript - interfaces, annotations, generics and
  // casts all compile, and \`npm run check\` type-checks them.
  interface Item { label: string }

  let count = $state(0);
  let items = $state<string[]>(['zero hydration', 'one request', 'no build config']);
  let showList = $state(true);

  function increment() { $setState('count', count() + 1); }
  function toggleList() { $setState('showList', !showList()); }
  // typed server data: the body runs per request on the server (and ships
  // to the client, where it re-runs on a client-side navigation)
  let first: Item = $data((): Item => ({ label: items()[0] ?? 'nothing yet' }));
</script>

<h1>🌹 Rosefn</h1>
<p>Count: <strong>{count()}</strong> - first item: {first().label}</p>
<button on:click={increment}>Increment</button>
<button on:click={toggleList}>{showList() ? 'Hide' : 'Show'} the list</button>

{#if showList()}
<ul>
  {#each items() as item}
    <li>{item}</li>
  {/each}
</ul>
{/if}

<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; }
  button { padding: 0.5rem 1rem; margin-right: 0.5rem; }
</style>
`);

  fs.writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}

A Rosefn project. One file per route in \`src/pages/\`.

\`\`\`bash
npm install     # pulls the rosefn package (and typescript, for checking)
npm run dev     # dev server with hot rebuild: http://localhost:3000
npm run build   # compiles to dist/
npm run serve   # production runner (cluster, access log, graceful shutdown)
npm run check   # type-checks every .rose script
\`\`\`

Add a route by adding a file: \`src/pages/about.rose\` serves \`/about\`.
\`src/pages/_layout.rose\` wraps every route, \`src/pages/_middleware.rose\`
runs before every request, \`src/pages/api/*.rose\` answers JSON.
Full syntax: the README of the rosefn package.
`);

  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\ndist/\n');

  console.log(`🌹 Created ${dir}`);
  console.log(`   src/pages/index.rose  - a typed page that builds and runs`);
  console.log(`   rosefn-env.d.ts + tsconfig.json - the script globals, typed`);
  console.log(`\n   cd ${name}`);
  console.log(`   npm install && npm run dev`);
  console.log(`   npm run check    # type-checks every .rose script`);
}

/**
 * `rosefn check [dir]` - type-check every .rose script with the
 * PROJECT's own TypeScript.
 *
 * esbuild strips types without checking them, so a wrong argument type or a
 * typo in an interface is invisible at build time: the build succeeds and the
 * bug ships. This closes that hole - it extracts the exact block the compiler
 * embeds (scriptOf, one regex, one truth), pads it so line and column numbers
 * still point at the .rose file, and runs the project's TypeScript over all
 * of them in one program, with rosefn's own globals in scope.
 *
 * No TypeScript in the project is a hard error: a check that cannot run must
 * never pass silently. trade-off: no temp files, no tsconfig parsing - an
 * in-memory compiler host and fixed strict options, documented.
 */
async function check(): Promise<void> {
  const files = await scanRoseFiles(SRC_DIR);
  if (files.length === 0) {
    console.error(`Rosefn: no .rose pages found under ${path.join(SRC_DIR, 'src', 'pages')} - run rosefn check from a project root, or pass one: rosefn check <dir>`);
    process.exit(1);
  }

  // The project's typescript, resolved FROM the project: the framework must
  // not drag its own copy into a user's install, and the version that
  // reports the errors should be the one the user's editor uses.
  let tsMod: typeof ts;
  try {
    const req = createRequire(pathToFileURL(path.join(SRC_DIR, 'package.json')));
    tsMod = await import(pathToFileURL(req.resolve('typescript')).href) as typeof ts;
  } catch {
    console.error(`Rosefn: type checking needs typescript in this project - npm i -D typescript`);
    process.exit(1);
  }

  // rosefn's ambient globals, resolved from the COMPILER's own location:
  // src/types/rosefn.d.ts is a sibling in the repo and two levels down in
  // the published package (same two layouts as the runtime entry).
  const nextTo = (rel: string[]) => rel.map((r) => fileURLToPath(new URL(r, import.meta.url))).find((p) => fs.existsSync(p));
  const typesFile = nextTo(['../types/rosefn.d.ts', '../src/types/rosefn.d.ts']);
  if (!typesFile) {
    console.error('Rosefn: the type definitions (src/types/rosefn.d.ts) were not found next to the compiler');
    process.exit(1);
  }
  // The runtime source, for scripts that import helpers from './runtime.js'
  // (the module the compiler generates beside the intermediates). Point that
  // import at the real source so it is checked against the actual signatures
  // instead of a copy that can drift.
  const runtimeSource = nextTo(['../runtime/index.ts', '../src/runtime/index.ts']);

  // Each script becomes a virtual file NAMED after its .rose file, padded so
  // a diagnostic's line/column are the .rose file's own: the <script> tag
  // sits on line L, so L-1 blank lines put the script's first line back on
  // line L. (The script capture starts with the newline right after the tag,
  // so its own line 1 is the rest of line L - the mapping is exact, tag on
  // line 1 included.)
  //
  // The map is keyed the way TS normalizes paths (absolute, forward slashes):
  // a raw `src\pages\index.rose` key never matches and the host silently
  // reads the REAL .rose file off disk, which parses as HTML and reports a
  // thousand nonsense errors (measured, not hypothetical).
  const norm = (f: string) => path.resolve(f).replace(/\\/g, '/');
  const virtual = new Map<string, string>();
  let checked = 0;
  for (const file of files) {
    const source = await fs.promises.readFile(file, 'utf-8');
    const m = /<script>/.exec(source);
    const script = scriptOf(source);
    if (!script) continue; // a pure-markup component has nothing to check
    const tagLine = source.slice(0, m!.index + '<script>'.length).split('\n').length;
    const wired = runtimeSource
      ? script.replace(/['"]\.\/runtime\.js['"]/g, JSON.stringify(runtimeSource.replace(/\\/g, '/')))
      : script;
    virtual.set(norm(file), '\n'.repeat(tagLine - 1) + wired);
    checked++;
  }
  if (checked === 0) {
    console.log('Rosefn: no .rose scripts to check');
    return;
  }

  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: tsMod.ScriptTarget.ES2022,
    module: tsMod.ModuleKind.ESNext,
    moduleResolution: tsMod.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    // the virtual files are named after the .rose files (so a diagnostic
    // points at the real path); without this TypeScript refuses them for
    // their extension before it ever asks the host for their content
    allowNonTsExtensions: true,
    // the rewired './runtime.js' import points at a real .ts source
    allowImportingTsExtensions: true,
    // `types` is deliberately NOT set: the project's own @types packages
    // (@types/node for node:sqlite, say) load automatically, the way they do
    // for the user's own .ts files. Errors inside them are filtered below.
    skipLibCheck: true,
  };
  const host = tsMod.createCompilerHost(options);
  // @types discovery starts at the project root, not the process cwd - the
  // command works from anywhere, like every other rosefn command.
  host.getCurrentDirectory = () => path.resolve(SRC_DIR);
  const realRead = host.readFile.bind(host);
  const realGet = host.getSourceFile.bind(host);
  host.readFile = (f) => virtual.get(norm(f)) ?? realRead(f);
  host.fileExists = (f) => virtual.has(norm(f)) || tsMod.sys.fileExists(f);
  host.getSourceFile = (f, version, onError, shouldCreate) => {
    const src = virtual.get(norm(f));
    return src ? tsMod.createSourceFile(f, src, version, true) : realGet(f, version, onError, shouldCreate);
  };

  // rosefn's ambient globals as a program root: a global .d.ts contributes
  // its declarations to every file in the program, so no per-file reference
  // directive is needed (and none could fit on line 1 without shifting the
  // line numbers the padding just restored).
  const program = tsMod.createProgram([...virtual.keys(), typesFile], options, host);
  // Only the project's own scripts: an error inside @types/node or inside
  // rosefn's runtime source is not the user's bug (skipLibCheck already
  // covers most of it, and a rewired import drags real files into the
  // program - their internals stay out of the report).
  const diagnostics = tsMod.getPreEmitDiagnostics(program)
    .filter((d) => d.file && virtual.has(norm(d.file.fileName)));
  if (diagnostics.length === 0) {
    console.log(`Rosefn: ${checked} script${checked === 1 ? '' : 's'} type-checked, no errors`);
    return;
  }
  for (const d of diagnostics) {
    // paths relative to the project root, the way tsc prints them
    const at = d.file ? tsMod.getLineAndCharacterOfPosition(d.file, d.start ?? 0) : null;
    const where = d.file && at
      ? `${path.relative(SRC_DIR, d.file.fileName)}(${at.line + 1},${at.character + 1})`
      : 'rosefn';
    const text = tsMod.flattenDiagnosticMessageText(d.messageText, '\n');
    const kind = d.category === 1 ? 'error' : 'warning';
    console.error(`${where}: ${kind} TS${d.code}: ${text}`);
  }
  const errors = diagnostics.filter((d) => d.category === 1).length;
  console.error(`Rosefn: ${errors} type error${errors === 1 ? '' : 's'} in ${checked} script${checked === 1 ? '' : 's'}`);
  process.exit(1);
}

const cmd = process.argv[2];
if (cmd === 'dev') dev();
else if (cmd === 'build') build();
else if (cmd === 'preview') preview();
else if (cmd === 'serve') serve();
else if (cmd === 'new') scaffold();
else if (cmd === 'check') check();
else console.log('Usage: rosefn dev|build|preview|serve|new|check [dir]   (dir defaults to the current directory; dist/ is written there)');
