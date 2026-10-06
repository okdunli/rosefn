/**
 * rosefn CLI - simplest possible SSR + static server
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { createRequire } from 'module';
import { pathToFileURL, fileURLToPath } from 'url';
import { buildProject, scanRoseFiles, scanComponentFiles, scriptOf, extractExports, loadPlugins, type RouteInfo } from '../compiler/index.js';
import { getHtmlShell, getClientSource, getStyles, shellOpen, clientScriptTag, securityHeaders, mintNonce, setBundleMode } from './shell.js';
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

/**
 * Send a rendered page document - through onResponse first . The
 * hook sees the status, headers and body exactly as they will go on the
 * wire and may replace them, so the ETag inside sendHtml is then computed
 * over the bytes actually sent. One helper for the POST-action path and the
 * buffered GET path: same hook, same order, no drift between them.
 */
async function sendPage(req: any, res: any, ssrModule: any, hookCtx: any, page: any, routePath: string): Promise<void> {
  let status = page.status ?? 200;
 // page.lang/page.dir are the locale the render used: the document's
 // <html> attributes follow the route's [lang] segment. nonce: '' for
  // every hashed route, so the document is byte-identical to before.
  const nonce = nonceFor(ssrModule, routePath);
  // a nonce route is dynamic by construction (the compiler put it in
  // dynamicRoutes), so it always lands here or in the stream below - never on
  // the baked-file path, where a fresh nonce per response is impossible
  let html = getHtmlShell(page.html, page.state, page.head, page.csr !== false, page.lang, page.dir, nonce);
  let headers: Record<string, any> = pageHeaders(ssrModule, routePath, nonce);
  if (hookCtx) {
    // P0-3: the document's content-type travels WITH the Response. The WHATWG
    // constructor fills in text/plain when it is missing, and a hook that
    // bails on non-HTML responses (the standard shape) then skips every
    // page - so it is stated here, before the hook ever sees the object.
    const out = await ssrModule.runResponseHooks(hookCtx, new Response(html, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    }));
    status = out.status;
    headers = webHeadersToNode(out);
    // P0-4: a hook that READ the body and returned the same Response cannot
    // have it read again (TypeError: body already used) - and that throw
    // used to surface as a 9-byte 404 from the outer catch. The bytes the
    // hook consumed are the ones it chose to keep, so send those.
    html = out.bodyUsed ? html : await out.text();
  }
  sendHtml(req, res, status, html, headers);
}

// Static files: raw + both compressed forms cached per mtime (dev rebuilds
// change mtime; preview never does). trade-off: unbounded map - fine for a
// dev/preview server's handful of files; swap for an LRU if it ever isn't.
const fileCache = new Map<string, { mtimeMs: number; raw: Buffer; br: Buffer; gzip: Buffer; etag: string }>();

// P0-0 (bug report): `--port N` (or `--port=N`), the same override the PORT
// env gives, as an argument - "rosefn dev --port 4000" is what a developer
// with two projects open actually types. Parsed BEFORE the constants below
// read the env, and BEFORE SRC_DIR, so a flag is never mistaken for the
// project directory.
const __portArg = process.argv.find((a) => a === '--port' || a.startsWith('--port='));
if (__portArg) {
  const __v = __portArg.includes('=') ? __portArg.slice('--port='.length) : process.argv[process.argv.indexOf(__portArg) + 1];
  if (__v && Number(__v) > 0) process.env.PORT = __v;
}

// (the "the framework is real" gate): the CLI builds ANY project,
// not just this repo's demo. `rosefn build [dir]` - the dir defaults to the
// cwd, so inside a project a bare `rosefn build` is all there is. The
// project's rosefn.config.js is read from that same dir (plugins).
// Trade-off: the output still lands in ./dist of the directory the command
// runs from (the repo's Go binary embeds <repo>/dist, and a project's own
// dist belongs beside the command you ran) - `cd` into the project, or pass
// its path and collect dist/ from here.
// A leading `-` is a flag (--port), not a directory.
const SRC_DIR = process.argv[3] && !process.argv[3].startsWith('-') ? path.resolve(process.argv[3]) : process.cwd();
// The deploy dir is ./dist of the directory the command ran from - a
// documented contract (test-cli.mjs asserts it): building a project that is
// not the cwd still drops its output beside the caller, the way every
// static-site generator does.
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
 // What this build actually costs on the wire, per route. Runs
  // after writeBrotli so the br column is the file the Go binary serves.
  await analyze(OUT_DIR, (ssrModule.dynamicRoutes as string[] | undefined) ?? []);
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
 * The build analysis. The zero-JS report says
 * WHICH routes ship no runtime; this says what every route costs on the
 * wire, measured from the files this build just wrote - never from a number
 * quoted from memory. Brotli is the `.br` sibling the build already wrote
 * (the exact bytes the Go binary serves); gzip is computed here because the
 * Node server compresses per request and gzip is the fallback every proxy
 * eventually falls back to. Dynamic routes are not baked, so they are
 * LISTED, not measured: their numbers come from `npm run benchmark`, which
 * renders them live against `rosefn serve`.
 */
async function analyze(outDir: string, dynamic: string[]): Promise<void> {
  const rows: Array<{ route: string; raw: number; gzip: number; br: number; js: boolean }> = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        await walk(path.join(dir, e.name), `${prefix}/${e.name}`);
        continue;
      }
      if (!e.name.endsWith('.html')) continue;
      const file = path.join(dir, e.name);
      const raw = await fs.promises.readFile(file);
      const brFile = `${file}.br`;
      rows.push({
        route: prefix || '/',
        raw: raw.length,
        gzip: zlib.gzipSync(raw, { level: 9 }).length,
        br: fs.existsSync(brFile) ? (await fs.promises.stat(brFile)).size : 0,
        js: /<script type="module"/.test(raw.toString('utf8')),
      });
    }
  };
  await walk(outDir, '');
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  const lines = ['Rosefn build analysis (measured from dist/; br = the precompressed bytes the Go binary serves):'];
  for (const r of rows.sort((a, b) => (a.route < b.route ? -1 : 1))) {
    lines.push(`  ${r.route.padEnd(16)}${kb(r.raw).padStart(9)} raw ${kb(r.gzip).padStart(8)} gzip ${kb(r.br).padStart(8)} br   ${r.js ? 'bundle inlined' : 'zero-JS'}`);
  }
  const client = path.join(outDir, 'client.js');
  if (fs.existsSync(client)) {
    const raw = await fs.promises.readFile(client);
    lines.push(`  shared bundle  ${kb(raw.length).padStart(9)} raw ${kb(zlib.gzipSync(raw, { level: 9 }).length).padStart(8)} gzip ${kb(fs.existsSync(`${client}.br`) ? (await fs.promises.stat(`${client}.br`)).size : 0).padStart(8)} br   inlined into every interactive document`);
  }
  if (dynamic.length > 0) {
    lines.push(`  dynamic (rendered per request, measured live by \`npm run benchmark\`): ${dynamic.join(' ')}`);
  }
  for (const l of lines) console.log(l);
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
async function clearPrerendered(dir: string, depth = 0): Promise<void> {
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
 // Dist/locales/ holds the runtime locale packs the build just
    // wrote (i18n.preload's leftovers) - they are .json files like any
    // prerendered body, but they are build output, not a baked route, and
    // deleting them would leave a packed locale permanently unrenderable
    // on the client. A route literally named "locales" collides with this
    // directory and is not prerenderable; the compiler reserves the path.
    if (depth === 0 && e.name === 'locales' && e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await clearPrerendered(p, depth + 1);
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
    // P0-1: a baked document has no request and therefore no query - say so
    // explicitly, so a query from the previous render can never leak in.
    ssrModule.setQuery?.({});
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
    await fs.promises.writeFile(path.join(routeDir, 'index.html'), getHtmlShell(page.html, page.state, page.head, page.csr !== false, page.lang, page.dir));
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
// dist/headers.json at build time. `nonce` switches this one
// response to the nonce policy, which the caller must also stamp on the
// document's script tag - the two are generated together here or not at all.
function pageHeaders(ssrModule: any, pathname: string, nonce = ''): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(securityHeaders(getClientSource(), nonce))) headers[k.toLowerCase()] = v;
  const own = ssrModule.headersFor?.(pathname) as Record<string, string> | null | undefined;
  if (own) for (const [k, v] of Object.entries(own)) headers[k.toLowerCase()] = v;
  return headers;
}

/**
 * The nonce for one response, or '' when the route keeps the hashed policy
 * . Only the routes that exported `csp = { nonce: true }` ask for one,
 * so every other document is byte-for-byte what it was.
 */
function nonceFor(ssrModule: any, pathname: string): string {
  return ssrModule.cspNonce?.(pathname) ? mintNonce() : '';
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
      // P0-1: the background pass has no request either - an empty query, so
      // the swapped file never carries another visitor's search terms.
      ssrModule.setQuery?.({});
      const page = await ssrModule.renderPage(routePath);
      if (page.status === 200) {
 // the swap must honor the route's csr decision: a
        // zero-JS route revalidated here stays zero-JS, or the first stale
        // window would silently inline the bundle into its baked file
        await fs.promises.writeFile(filePath, getHtmlShell(page.html, page.state, page.head, page.csr !== false, page.lang, page.dir));
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

/**
 * The context a runtime plugin hook receives. Node's
 * IncomingMessage is not a Web Request and a hook must not care which server
 * it runs on, so the CLI builds the same object the edge adapter already
 * has. Built only when the project declares a runtime hook (the server
 * bundle exports the flags) - the hot path never pays for the feature.
 *
 * The body is deliberately not attached: the servers read it lazily, and
 * buffering it for every request would cost the fast path. A hook that needs
 * the submitted form uses pages/_middleware.rose, which already rides with
 * the parsed FormData.
 */
async function hookContext(req: any): Promise<{
  request: Request;
  url: URL;
  method: string;
  pathname: string;
  state: Record<string, unknown>;
}> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
    method: req.method || 'GET',
    headers,
  });
  const url = new URL(request.url);
  return { request, url, method: request.method, pathname: url.pathname, state: {} };
}

/** A Web Response's headers as a Node header record, set-cookie kept whole. */
function webHeadersToNode(web: any): Record<string, any> {
  const out: Record<string, any> = {};
  const cookies = web.headers.getSetCookie?.() ?? [];
  web.headers.forEach((v: string, k: string) => {
    if (cookies.length && k.toLowerCase() === 'set-cookie') return;
    out[k] = v;
  });
  if (cookies.length) out['set-cookie'] = cookies;
  return out;
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
 // Runtime hooks: onRequest runs after the origin guard and
      // BEFORE middleware and routing, and may short-circuit the request
      // with its own Response (an auth wall, a rate limit, a maintenance
      // page). The context is built only when a hook exists.
      const hookCtx = ssrModule.hasRequestHooks === true || ssrModule.hasResponseHooks === true
        ? await hookContext(req)
        : null;
      if (hookCtx) {
        const short = await ssrModule.runRequestHooks(hookCtx);
        if (short) {
          // the short-circuit rides through onResponse like every other
          // response, so a header-adding hook sees it too
          await sendWebResponse(await ssrModule.runResponseHooks(hookCtx, short), res);
          return;
        }
      }
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
          await sendWebResponse(hookCtx ? await ssrModule.runResponseHooks(hookCtx, mw) : mw, res);
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
            // P0-1: an api handler reads the query from its Request's URL
            // (the full one, query included) - and through $query() for the
            // same uniform access a page render has.
            ssrModule.setQuery?.(queryOf(req.url));
            let apiRes = await ssrModule.handleApi(req.method || 'GET', apiPath, request);
            if (hookCtx) apiRes = await ssrModule.runResponseHooks(hookCtx, apiRes);
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
                await sendWebResponse(hookCtx ? await ssrModule.runResponseHooks(hookCtx, mw) : mw, res);
                return;
              }
            }
            // P0-1: the POST is routed by pathname too, and its query (if the
            // form was posted to /search?ref=x) reaches the render through
            // $query() like every other path.
            ssrModule.setQuery?.(queryOf(req.url));
            const page = await ssrModule.renderPage(pathnameOf(req.url || '/'), form);
            await sendPage(req, res, ssrModule, hookCtx, page, pathnameOf(req.url || '/'));
          } catch (err) {
            // A silent "Bad request" is how a framework bug hides: the stack
            // goes to stderr (the same rule the GET path follows), and the
            // response stays a 400 for a malformed body - the one cause a
            // client can act on.
            console.error(`Rosefn: POST ${pathnameOf(req.url || '/')} failed:`, err instanceof Error ? err.stack : err);
            if (!res.headersSent) {
              res.statusCode = 400;
              res.end('Bad request');
            }
          }
        });
        return;
      }

      // P0-1: routing matches the PATHNAME. The query string rides along to
      // the handlers ($query(), the api Request) but never into a route
      // pattern - `/blog?page=2` is the route `/blog` with a query, not a
      // route literally named "blog?page=2" (which matched nothing and
      // answered 404).
      let safe = path.normalize(pathnameOf(req.url || '/')).replace(/^(\.\.(\/)?)+/, '');
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
            // A file's compressed forms are computed ONCE and then served
            // from this cache forever, so both are spent at max quality:
            // brotli 11 (the default) and gzip level 9 (not the default 6,
            // which leaves ~50 bytes on the wire for nothing). The dynamic
            // path below still compresses per request and keeps the cheap
            // levels - see compress()/createCompressor().
            br: zlib.brotliCompressSync(raw),
            gzip: zlib.gzipSync(raw, { level: 9 }),
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
        // An ISR route's file is swapped every `revalidate` seconds, so the
        // cache must not outlive the window: revalidate every visit (a
        // bodiless 304 when nothing changed) while allowing the browser to
        // paint the stale document during that revalidation - the same
        // stale-while-revalidate contract the server keeps, told to the
        // browser. Everything else (assets, non-ISR pages) keeps the hour.
        const fileHeaders: Record<string, string> = {
          'Content-Type': types[ext] || 'application/octet-stream',
          'Cache-Control': rev ? `public, max-age=0, stale-while-revalidate=${rev.seconds}` : 'public, max-age=3600',
          'ETag': entry.etag,
          'Vary': 'Accept-Encoding',
        };
 // Per-route response headers: a prerendered
        // document carries the same policy the live render would send -
        // the strict CSP plus the route's own exported headers.
        if (ext === '.html') Object.assign(fileHeaders, pageHeaders(ssrModule, pathnameOf(req.url)));
 // OnResponse on the file path too, so a header-adding
        // plugin sees EVERY response and not just the rendered ones. Bodyless
        // like the stream - the bytes are the cached file's, which is what
        // makes this path fast; the status and headers are the hook's to
        // change. Runs only when the project declares a hook, so the
        // zero-hook fast path is byte-for-byte what it was.
        let status = 200;
        if (hookCtx) {
          const out = await ssrModule.runResponseHooks(hookCtx, new Response(null, { status, headers: fileHeaders }));
          status = out.status;
          for (const [k, v] of Object.entries(webHeadersToNode(out))) res.setHeader(k, v);
        } else {
          for (const [k, v] of Object.entries(fileHeaders)) res.setHeader(k, v);
        }
        if (req.headers['if-none-match'] === entry.etag) {
          res.statusCode = 304;
          res.end();
          return;
        }
        const enc = pickEncoding(req);
        res.statusCode = status;
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
      // P0-1: the pathname, never the raw url - see the static branch above.
      // The query reaches the render through $query() (setQuery below), which
      // is what a search or a paginated list reads.
      const safe2 = pathnameOf(req.url || '/');
      // P0-1: the query is per request and belongs to the render, not the
      // route - set once, before either path below reads $query().
      ssrModule.setQuery?.(queryOf(req.url));
      // P0-2: `buffer = true` routes take the buffered path even when they
      // could stream - the response hooks then see the whole document and a
      // failed render keeps its real status. The app decides, per route.
      if (!broken.has(safe2) && !ssrModule.isBuffered?.(safe2) && ssrModule.canStream(safe2) && !ssrModule.isNoJs(safe2)) {
        const enc = pickEncoding(req);
 // onResponse runs BEFORE the first flush, while the status
        // and headers can still change: the hook is handed a bodyless Response
        // carrying them, and whatever it returns is applied. Its body is
        // ignored - the stream produces the body, and a document already on
        // the wire cannot be replaced - which is the honest limit of a
        // streamed response, not a missing feature.
        let status = 200;
 // The nonce is minted before the first flush, because a
        // streamed response cannot change its headers afterwards - and the
        // document's script tag is written into that same stream, so both
        // halves carry this one value.
        const nonce = nonceFor(ssrModule, safe2);
        let headers: Record<string, any> = pageHeaders(ssrModule, safe2, nonce);
        if (hookCtx) {
          const out = await ssrModule.runResponseHooks(hookCtx, new Response(null, { status, headers }));
          status = out.status;
          headers = webHeadersToNode(out);
        }
        res.statusCode = status;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Vary', 'Accept-Encoding');
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
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
 // The streamed shell opens before the render, so its <html
        // lang>/<dir> come from the pathname (the server bundle's docAttrs)
        const doc = ssrModule.docAttrs(safe2);
        await ssrModule.renderPageStream(safe2, write, shellOpen(getStyles(), doc.lang, doc.dir), clientScriptTag(getClientSource(), nonce));
        done();
        return;
      }
      // buffered: POST actions, unmatched routes (404), known-broken routes
 // (500), and csr = false routes (a no-JS document must
      // not stream - the route's <head> is only known after the render, and
      // there is no client to apply it at boot)
      const page = await ssrModule.renderPage(safe2);
      await sendPage(req, res, ssrModule, hookCtx, page, safe2);
    }).catch((err: unknown) => {
      // P0-4: a failure in the pipeline is a 500 with the reason on stderr,
      // never a 9-byte 404 - "Not found" for a route that exists and threw
      // is the single hardest bug to diagnose in production. The stack goes
      // to stderr (the access log owns stdout) and the client gets a real
      // status it can alert on.
      console.error(`Rosefn: ${req.method} ${req.url} failed:`, err instanceof Error ? err.stack ?? err.message : err);
      if (res.headersSent) {
        // a stream already left: the status is committed, so the only honest
        // move is to drop the socket and let the client retry
        res.destroy();
        return;
      }
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<h1>500</h1><p>Something went wrong rendering this page.</p>');
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
 * The parsed query string of a URL (?page=2&q=x -> {page:'2',q:'x'}), for
 * $query() (P0-1). First value wins per key, the way every server-side
 * framework reads a repeated parameter.
 */
function queryOf(url: string | undefined): Record<string, string> {
  const q: Record<string, string> = {};
  try {
    new URL(url || '/', 'http://localhost').searchParams.forEach((v, k) => { if (!(k in q)) q[k] = v; });
  } catch { /* an unparsable url carries no query */ }
  return q;
}

/**
 * P0-0 (bug report): listen on `port`, hopping to the next free one when it
 * is taken instead of crashing with EADDRINUSE. Two projects on one machine
 * (or a dev server that did not exit cleanly) is the everyday case, and a
 * stack trace plus a dead process is the worst possible answer to it: the
 * banner names the port actually used, so the URL is never a guess.
 *
 * The hop is bounded (20 tries) and every other error is fatal - silently
 * retrying a real fault would hide it.
 */
function listenFree(server: any, port: number, onReady: (port: number) => void): void {
  const attempt = (p: number): void => {
    const onError = (err: any) => {
      server.removeListener('error', onError);
      if (err && err.code === 'EADDRINUSE' && p - port < 20) {
        console.log(`🌹 port ${p} is in use - trying ${p + 1}`);
        attempt(p + 1);
        return;
      }
      console.error(`Rosefn: cannot listen on port ${p}:`, err instanceof Error ? err.message : err);
      process.exit(1);
    };
    server.once('error', onError);
    server.listen(p, () => {
      server.removeListener('error', onError);
      onReady(p);
    });
  };
  attempt(port);
}

/**
 * P0-0 (bug report): the first free port at or after `from`, probed with a
 * throwaway socket. The cluster's primary needs this because the workers must
 * all land on the SAME port - letting each of them hop on its own would put
 * them on different ports and split the traffic between them. Racy by nature
 * (a port can be taken between the probe and the workers' listen); the
 * workers' own listenFree fallback covers that last step.
 */
async function freePort(from: number): Promise<number> {
  const net = await import('node:net');
  for (let p = from; p < from + 20; p++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(p, () => probe.close(() => resolve(true)));
    });
    if (free) return p;
  }
  return from;
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

  // P0-0: an occupied port hops to the next free one (and says so) instead of
  // killing the server with EADDRINUSE.
  listenFree(server, PORT, (port) => {
    console.log('🌹 http://localhost:' + port);
  });
}

async function preview(): Promise<void> {
  await build();
  const http = await import('http');
  // isr=true: routes exporting `revalidate = N` are served stale-then-swapped
 // from disk . Dev passes nothing (it rebuilds on change).
  const server = http.createServer(serveStatic(OUT_DIR, true));

  // P0-0: same hop as the dev server - a preview that cannot bind its port
  // moves to the next one and prints it.
  listenFree(server, PORT, (port) => {
    console.log(`🌹 Rosefn v${version()} preview at http://localhost:` + port);
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
  if (cluster.isPrimary) {
    // P0-0 (bug report): ONE port for the whole cluster, chosen once by the
    // primary and handed to every worker through the environment. A worker
    // that cannot bind its port hops on its own (listenFree below), but if
    // each of them hopped independently the cluster would end up spread over
    // several ports with the traffic split between them - so the decision
    // belongs here, and the banner names the port actually used.
    const port = await freePort(Number(process.env.PORT) || 3000);
    for (let i = 0; i < workers; i++) cluster.fork({ PORT: String(port) });
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
    console.log(`🌹 Rosefn v${version()} serve: ${workers} worker${workers > 1 ? 's' : ''} on http://localhost:${port} (cluster, bounded bodies, graceful shutdown, access log on stdout)`);
    return;
  }
  // worker
  // the primary's death is the worker's death: no orphan holding the port
  process.on('disconnect', () => process.exit(0));
 // OnServe / onShutdown - the worker's lifecycle. A plugin that
  // owns a resource (a connection pool, a warm cache) opens it here and
  // closes it in the drain, instead of leaking one pool per deploy. Node
  // only: an edge runtime owns the lifecycle and has no worker start to
  // hook. Loaded from the PROJECT's config (SRC_DIR), not from dist/ - the
  // config is not deployed.
  let servicePlugins: any[] = [];
  try {
    servicePlugins = (await loadPlugins(SRC_DIR)).filter((p) => p && p.onServe);
  } catch (err) {
    console.error('Rosefn: rosefn.config.js failed to load for the serve hooks:', err instanceof Error ? err.message : err);
  }
  const http = await import('node:http');
  const server = http.createServer(withAccessLog(serveStatic(OUT_DIR, true), `w${process.pid}`));
  // A client that stalls mid-request is dropped instead of holding a worker;
  // idle keep-alive sockets close so a drained worker can actually exit.
  server.requestTimeout = 30_000;
  server.headersTimeout = 65_000; // must exceed requestTimeout
  server.keepAliveTimeout = 5_000;
  // P0-0: the worker binds the port the primary chose; if that one was taken
  // in the meantime it hops instead of dying with an unhandled 'error' (the
  // cluster's failure mode before this existed).
  listenFree(server, PORT, async (port) => {
    console.log(`🌹 Rosefn worker ${process.pid} listening on http://localhost:${port}`);
    for (const p of servicePlugins) {
      try {
        await p.onServe({ port, workers });
      } catch (err) {
        console.error('Rosefn: plugin', p.name, 'onServe failed:', err instanceof Error ? err.message : err);
      }
    }
  });
  const stop = () => {
    // onShutdown first: close what onServe opened, then drain. A throwing
    // hook must not stop the drain - the process still exits on the timer.
    for (const p of servicePlugins) {
      if (!p.onShutdown) continue;
      try {
        void Promise.resolve(p.onShutdown()).catch((err: unknown) => {
          console.error('Rosefn: plugin', p.name, 'onShutdown failed:', err instanceof Error ? err.message : err);
        });
      } catch (err) {
        console.error('Rosefn: plugin', p.name, 'onShutdown failed:', err instanceof Error ? err.message : err);
      }
    }
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
  const files = [...(await scanRoseFiles(SRC_DIR)), ...(await scanComponentFiles(SRC_DIR))];
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

 // An imported component's binding IS its render function (the
  // compiler rewrites `import Card from '...Card.rose'` to
  // `import { render as Card }`), and TypeScript cannot resolve a `.rose`
  // specifier on its own: its resolver only tries `<name>.rose.d.ts`-style
  // paths for an unknown extension (measured in typescript.js), so every
  // `.rose` import target gets a synthesized declaration module registered at
  // exactly that path. The props come from the SAME extractExports parse the
  // compiler uses, so a wrong prop type at the call site is a type error and
  // the two can never drift. The component's own script keeps its virtual
  // entry untouched - line numbers stay exact.
  const propType = (def: string | null): string => {
    if (!def) return 'unknown';                       // `export let x;`
    if (/^['"`]/.test(def)) return 'string';
    if (/^-?\d+(\.\d+)?$/.test(def)) return 'number';
    if (/^(true|false)$/.test(def)) return 'boolean';
    return 'unknown';                                 // null, a call, an object: the honest answer
  };
  const ROSE_IMPORT_RE = /['"](\.[^'"]+\.rose)['"]/g;
  const declared = new Set<string>();
  for (const file of [...virtual.keys()]) {
    const script = scriptOf(await fs.promises.readFile(file, 'utf-8').catch(() => ''));
    if (!script) continue;
    for (const spec of script.matchAll(ROSE_IMPORT_RE)) {
      const target = norm(path.resolve(path.dirname(file), spec[1]));
      if (target === file || declared.has(target)) continue;
      const targetSource = await fs.promises.readFile(target, 'utf-8').catch(() => null);
      if (targetSource === null) continue; // the build reports a missing import loudly; the checker stays out of its way
      const props = extractExports(scriptOf(targetSource) ?? '').props;
      virtual.set(`${target}.d.ts`, [
        `declare function render(closes: unknown[], children: string, __props: { ${props.map((p) => `${p.name}?: ${propType(p.def)}`).join('; ')} }, __slots?: Record<string, unknown>): string;`,
        'export default render;',
        '',
      ].join('\n'));
      declared.add(target);
    }
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
