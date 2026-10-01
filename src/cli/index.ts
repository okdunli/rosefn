/**
 * rosefn CLI - simplest possible SSR + static server
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { pathToFileURL } from 'url';
import { buildProject, type RouteInfo } from '../compiler/index.js';
import { getHtmlShell, getClientSource, shellOpen, clientScriptTag, securityHeaders, setBundleMode } from './shell.js';

// --- wire performance: compression + conditional caching (stdlib only) ---
// The Go binary already compresses; the Node server must match it or the
// headline "1 request / 6.89 KB gzip" holds on only one of the two servers.
type Encoding = 'br' | 'gzip' | 'deflate';

function pickEncoding(req: any): Encoding | null {
  const ae: string = req.headers['accept-encoding'] || '';
  // ponytail: substring match, no q-value parsing - every browser that sends
  // br also accepts gzip, and br > gzip > deflate is the quality order.
  if (ae.includes('br')) return 'br';
  if (ae.includes('gzip')) return 'gzip';
  if (ae.includes('deflate')) return 'deflate';
  return null;
}

function compress(enc: Encoding, data: string | Buffer): Buffer {
  if (enc === 'br') return zlib.brotliCompressSync(data);
  if (enc === 'gzip') return zlib.gzipSync(data);
  return zlib.deflateSync(data);
}

function createCompressor(enc: Encoding): zlib.Gzip | zlib.Deflate | zlib.BrotliCompress {
  if (enc === 'br') return zlib.createBrotliCompress();
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
  // ponytail: FNV-1a in hex - no crypto import for a cache validator.
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

// A middleware's short-circuit: a Web-standard Response (status, headers,
// body) written straight to the Node response - a redirect, an auth wall,
// a rewrite. ponytail: uncompressed, like every framework's middleware
// response (they are tiny: a 302 has no body at all).
async function sendWebResponse(web: any, res: any): Promise<void> {
  web.headers.forEach((v: string, k: string) => res.setHeader(k, v));
  res.statusCode = web.status;
  res.end(Buffer.from(await web.arrayBuffer()));
}

// Static files: raw + both compressed forms cached per mtime (dev rebuilds
// change mtime; preview never does). ponytail: unbounded map - fine for a
// dev/preview server's handful of files; swap for an LRU if it ever isn't.
const fileCache = new Map<string, { mtimeMs: number; raw: Buffer; br: Buffer; gzip: Buffer; etag: string }>();

const ROOT = process.cwd();
const EXAMPLE_DIR = path.join(ROOT, 'example');
const OUT_DIR = path.join(ROOT, 'dist');
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
  // P0 §1: the build reports the bundle mode ('inline' | 'split') so the
  // shell follows it for every document, header and streaming tag it emits
  const { routes, bundle } = await buildProject(EXAMPLE_DIR, OUT_DIR);
  setBundleMode(bundle);
  const skipped = await prerender(routes);
  // The broken-route manifest: the server reads it to pick the buffered path
  // for these routes, so their real 500 status survives (a flushed response
  // cannot change its status). Runtime-only breakage is not in here - it
  // degrades to the error page body under a 200, documented in the README.
  await fs.promises.writeFile(path.join(OUT_DIR, 'broken.json'), JSON.stringify(skipped));
  // Per-route response headers (innovation #26) for the Go binary, which
  // has no compiler: it reads this file and merges the entries over its
  // own responses. `default` carries the strict CSP (hashed over the exact
  // inlined bundle + bootstrap bytes - the Go binary cannot recompute it,
  // it has no esbuild); the routes carry each route's exported headers.
  const ssrModule = await loadServer();
  await fs.promises.writeFile(path.join(OUT_DIR, 'headers.json'), JSON.stringify({
    default: securityHeaders(getClientSource()),
    routes: ssrModule.routeHeaders ?? [],
  }));
  // Innovation #28: precompressed brotli siblings (dist/<file>.br) for the
  // Go single binary. The binary embeds dist/ verbatim, so they ride along
  // and are served with zero per-request compression CPU - and the bytes
  // are exactly what the Node server compresses per file in memory, so
  // both servers deliver the same wire size.
  await writeBrotli(OUT_DIR);
}

/**
 * Write dist/<file>.br next to every compressible text file. ponytail:
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
 * Prerender every static route to dist/<route>/index.html at build time.
 * Those files are served straight from disk: zero server work, instant TTFB.
 * Dynamic routes with an exported `params` map (e.g. blog posts) are
 * enumerated and prerendered per value; params without `params` keep
 * rendering on demand. A route exporting `revalidate = N` is baked like
 * any other and then kept fresh by the preview server's stale-while-
 * revalidate pass (ISR, innovation #24).
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
    // csr = false routes bake a JS-free document (innovation #25): the file
    // on disk carries no bundle and no state script, so a visitor who lands
    // on it runs zero JavaScript.
    await fs.promises.writeFile(path.join(routeDir, 'index.html'), getHtmlShell(page.html, page.state, page.head, page.csr !== false));
    console.log(`prerendered ${routePath} -> ${path.relative(ROOT, path.join(routeDir, 'index.html'))}`);
  };

  for (const info of routes) {
    // routes that read the request context are dynamic by construction:
    // the bag is per-request, so a baked file would freeze one request's
    // answer. They keep rendering on demand (and the servers know them from
    // the server bundle's dynamicRoutes).
    if ((ssrModule.dynamicRoutes as string[]).includes(info.routePath)) {
      console.log(`dynamic route ${info.routePath}: reads the request context, rendered on demand`);
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
      console.log(`prerendered api ${routePath} -> ${path.relative(ROOT, outFile)}`);
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

// Response headers for a page document (innovation #26): the strict CSP
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

// ISR background pass (innovation #24): re-render a stale baked route and
// swap its file, while the triggering request was already answered from
// disk (stale-while-revalidate). One pass per file at a time - a burst of
// requests during staleness must not stampede - and the cached raw +
// compressed bytes are dropped so the next request reads the new file. A
// failed revalidation keeps the last good file (the same resilience as the
// build). ponytail: no queue, no metrics - one render per stale window;
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
        // the swap must honor the route's csr decision (innovation #29): a
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

function serveStatic(dir: string, isr = false): (req: any, res: any) => void {
  return (req, res) => {
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
      // identical on both servers. ponytail: no compression here - JSON API
      // bodies are small, and Next.js/Express don't compress them either.
      const apiPath = pathnameOf(req.url);
      if (ssrModule.isApi(apiPath)) {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          try {
            const body = Buffer.concat(chunks);
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
            apiRes.headers.forEach((v: string, k: string) => res.setHeader(k, v));
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
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          try {
            const body = Buffer.concat(chunks);
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

      // Build-time precompression siblings (innovation #28: dist/<file>.br,
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
        // ISR (innovation #24): a route exporting `revalidate = N` keeps its
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
        // Per-route response headers (innovation #26): a prerendered
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
      // no client (innovation #25).
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
          write = (chunk) => compressor.write(chunk);
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
      // (500), and csr = false routes (innovation #25: a no-JS document must
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

/** The version from package.json - one source of truth, no constant to drift. */
function version(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
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
  fs.watch(EXAMPLE_DIR, { recursive: true }, () => {
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
  // from disk (innovation #24). Dev passes nothing (it rebuilds on change).
  const server = http.createServer(serveStatic(OUT_DIR, true));

  server.listen(PORT, () => {
    console.log(`🌹 Rosefn v${version()} preview at http://localhost:` + PORT);
  });
}

const cmd = process.argv[2];
if (cmd === 'dev') dev();
else if (cmd === 'build') build();
else if (cmd === 'preview') preview();
else console.log('Usage: rosefn dev|build|preview');
