// Rosefn CLI - simplest possible SSR + static server

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { pathToFileURL, fileURLToPath } from 'url';
import { buildProject, scanRoseFiles, scanComponentFiles, scriptOf, extractExports, loadPlugins, RoseError, errorInfo, type RouteInfo } from '../compiler/index.js';
import { getHtmlShell, getClientSource, getStyles, shellOpen, clientScriptTag, securityHeaders, mintNonce, setBundleMode } from './shell.js';
import { AI_PROMPT } from './prompt.js';
import { Readable } from 'stream';
import { createEdgeHandler } from './edge.js';
import type * as ts from 'typescript';

type Encoding = 'br' | 'gzip' | 'deflate';

function pickEncoding(req: any): Encoding | null {
  const ae: string = req.headers['accept-encoding'] || '';
  if (ae.includes('br')) return 'br';
  if (ae.includes('gzip')) return 'gzip';
  if (ae.includes('deflate')) return 'deflate';
  return null;
}

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
  const enc = devMode ? null : pickEncoding(req);
  if (enc) {
    res.setHeader('Content-Encoding', enc);
    res.end(compress(enc, html));
  } else {
    res.end(html);
  }
}

function writeWebHeaders(web: any, res: any): void {
  const cookies = web.headers.getSetCookie?.() ?? [];
  web.headers.forEach((v: string, k: string) => {
    if (cookies.length && k.toLowerCase() === 'set-cookie') return;
    res.setHeader(k, v);
  });
  if (cookies.length) res.setHeader('set-cookie', cookies);
}

async function sendWebResponse(web: any, res: any): Promise<void> {
  writeWebHeaders(web, res);
  res.statusCode = web.status;
  res.end(Buffer.from(await web.arrayBuffer()));
}

// Send a rendered page document - through onResponse first .
async function sendPage(req: any, res: any, ssrModule: any, hookCtx: any, page: any, routePath: string): Promise<void> {
  let status = page.status ?? 200;
  if (page.redirect) {
    const body = `<!DOCTYPE html><title>Redirecting</title><p>Redirecting to <a href="${page.redirect}">${page.redirect}</a>.</p>`;
    let headers: Record<string, any> = pageHeaders(ssrModule, routePath, '');
    if (hookCtx) {
      const out = await ssrModule.runResponseHooks(hookCtx, new Response(body, {
        status,
        headers: { 'content-type': 'text/html; charset=utf-8', location: page.redirect, ...headers },
      }));
      status = out.status;
      headers = webHeadersToNode(out);
    }
    headers.location = page.redirect;
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Location', page.redirect);
    for (const [k, v] of Object.entries(headers)) if (k !== 'location') res.setHeader(k, v);
    res.end(body);
    return;
  }
  const nonce = nonceFor(ssrModule, routePath);
  let html = getHtmlShell(page.html, page.state, page.head, page.csr !== false, page.lang, page.dir, nonce, page.shell !== false);
  let headers: Record<string, any> = pageHeaders(ssrModule, routePath, nonce);
  if (hookCtx) {
    const out = await ssrModule.runResponseHooks(hookCtx, new Response(html, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    }));
    status = out.status;
    headers = webHeadersToNode(out);
    html = out.bodyUsed ? html : await out.text();
  }
  sendHtml(req, res, status, html, headers);
}

const fileCache = new Map<string, { mtimeMs: number; raw: Buffer; br: Buffer; gzip: Buffer; etag: string }>();

const __portArg = process.argv.find((a) => a === '--port' || a.startsWith('--port='));
if (__portArg) {
  const __v = __portArg.includes('=') ? __portArg.slice('--port='.length) : process.argv[process.argv.indexOf(__portArg) + 1];
  if (__v && Number(__v) > 0) process.env.PORT = __v;
}

const SRC_DIR = process.argv[3] && !process.argv[3].startsWith('-') ? path.resolve(process.argv[3]) : process.cwd();
const OUT_DIR = path.join(process.cwd(), 'dist');
const PORT = Number(process.env.PORT) || 3000;

// Import dist/server.js, cached until the file changes on disk. Preview and serve never rebuild, so they import dist/server.js itself.
let serverModule: any = null;
let serverMtime = -1;
let serverVersion = 0;

function loadDotEnv(dir: string): void {
  try {
    const raw = fs.readFileSync(path.join(dir, '.env'), 'utf-8');
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
  } catch {  }
}
loadDotEnv(process.cwd());

async function loadServer(): Promise<any> {
  const file = path.join(OUT_DIR, 'server.js');
  const mtimeMs = fs.statSync(file).mtimeMs;
  if (!serverModule || mtimeMs !== serverMtime) {
    serverMtime = mtimeMs;
    serverVersion++;
    let target = file;
    if (devMode) {
      target = path.join(OUT_DIR, '.build', `server-${serverVersion}.mjs`);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(file, target);
    }
    serverModule = await import(pathToFileURL(target).href);
  }
  return serverModule;
}

async function build(): Promise<void> {
  const { routes, bundle } = await buildProject(SRC_DIR, OUT_DIR);
  await clearPrerendered(OUT_DIR);
  setBundleMode(bundle);
  const skipped = await prerender(routes);
  await fs.promises.writeFile(path.join(OUT_DIR, 'broken.json'), JSON.stringify(skipped));
  const ssrModule = await loadServer();
  await fs.promises.writeFile(path.join(OUT_DIR, 'headers.json'), JSON.stringify({
    default: securityHeaders(getClientSource()),
    routes: ssrModule.routeHeaders ?? [],
  }));
  await writeBrotli(OUT_DIR);
  await analyze(OUT_DIR, (ssrModule.dynamicRoutes as string[] | undefined) ?? []);

  if (argv.includes('--static')) {
    const dyn = (ssrModule.dynamicRoutes as string[] | undefined) ?? [];
    const unbakedApi = Object.entries((ssrModule.apiPrerender ?? {}) as Record<string, boolean>)
      .filter(([, baked]) => !baked)
      .map(([routePath]) => routePath);
    const paramless = routes
      .filter((r) => r.paramNames.length > 0 && !((ssrModule.routeParams ?? {}) as Record<string, unknown>)[r.routePath])
      .map((r) => r.routePath);
    const problems = [...new Set([...dyn, ...unbakedApi, ...paramless, ...skipped])];
    if (problems.length > 0) {
      console.error('Rosefn: --static export refused - these routes need a server:');
      for (const p of problems) console.error(`  ${p}`);
      console.error('(getContext()/$store()/$query(), csp.nonce, buffer = true, an unbaked /api route, a param route with no export const params, or a route the middleware walled)');
      console.error('drop --static to build the normal dist (the dynamic half renders on demand on Node/edge)');
      process.exit(1);
    }
    console.log('Rosefn: static export verified - every route is a baked file, no server needed');
  }
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
    const mw = await ssrModule.runMiddleware({ method: 'GET', url: routePath, headers: {} });
    if (mw) {
      console.error(`prerender skipped for ${routePath}: the middleware short-circuits at build time`);
      skipped.push(routePath);
      return;
    }
    ssrModule.setQuery?.({});
    const page = await ssrModule.renderPage(routePath);
    if (page.status === 500) {
      console.error(`prerender skipped for ${routePath}: render failed, the error page rendered`);
      skipped.push(routePath);
      return;
    }
    const routeDir = routePath === '/' ? OUT_DIR : path.join(OUT_DIR, routePath.slice(1));
    await fs.promises.mkdir(routeDir, { recursive: true });
    await fs.promises.writeFile(path.join(routeDir, 'index.html'), getHtmlShell(page.html, page.state, page.head, page.csr !== false, page.lang, page.dir, '', page.shell !== false));
    console.log(`prerendered ${routePath} -> ${path.relative(process.cwd(), path.join(routeDir, 'index.html'))}`);
  };

  for (const info of routes) {
    if (((ssrModule.prerenderSkipRoutes as string[]) ?? []).includes(info.routePath)) {
      console.log(`dynamic route ${info.routePath}: per-request state (getContext/$store), rendered on demand`);
      continue;
    }
    if (info.paramNames.length === 0) {
      try {
        await write(info.routePath);
      } catch (err) {
        console.error(`prerender skipped for ${info.routePath}: ${err instanceof Error ? err.message : err}`);
        skipped.push(info.routePath);
      }
      continue;
    }
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
      .map((seg) => {
        if (seg.startsWith(':')) return encodeURIComponent(values[i++]);
        if (seg.startsWith('*')) return values[i++].split('/').map(encodeURIComponent).join('/');
        return seg;
      })
      .join('/');
  });
}

const ASSET_EXT = new Set(['.js', '.css', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.woff', '.woff2', '.txt', '.xml']);

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

const isrBusy = new Set<string>();
function revalidateInBackground(routePath: string, filePath: string): void {
  if (isrBusy.has(filePath)) return;
  isrBusy.add(filePath);
  void (async () => {
    try {
      const ssrModule = await loadServer();
      ssrModule.setQuery?.({});
      const page = await ssrModule.renderPage(routePath);
      if (page.status === 200) {
        await fs.promises.writeFile(filePath, getHtmlShell(page.html, page.state, page.head, page.csr !== false, page.lang, page.dir, '', page.shell !== false));
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

const DEV_BRIDGE = `<script>(function(){var es=new EventSource('/__rosefn_reload');es.onmessage=function(m){if(m.data!=='rebuild')return;es.close();var s=window.__rosefn?window.__rosefn.state():null;if(s)fetch('/__rosefn_state',{method:'POST',body:s,headers:{'content-type':'application/json'}}).catch(function(){});setTimeout(function(){location.reload()},40)}})()</script>`;
let devResume: string | null = null;
const devClients = new Set<any>();
let devMode = false;

function devReload(req: any, res: any): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': ok\n\n');
  devClients.add(res);
  req.on('close', () => devClients.delete(res));
}

function devSaveState(req: any, res: any): void {
  let body = '';
  req.on('data', (c: any) => {
    body += c;
    if (body.length > 1e6) req.destroy();
  });
  req.on('end', () => {
    try {
      JSON.parse(body);
      devResume = body;
    } catch { /* a corrupt snapshot is dropped: the next render is simply fresh */ }
    res.writeHead(204).end();
  });
}

/** Push the rebuild signal to every open dev tab. */
function devNotify(): void {
  for (const res of devClients) {
    try {
      res.write('data: rebuild\n\n');
    } catch {
      devClients.delete(res);
    }
  }
}

let devBuild: Promise<void> | null = null;
let devBuildPending = false;

function startDevBuild(): Promise<void> {
  if (!devBuild) {
    devBuild = (async () => {
      try {
        console.log('Rebuilding...');
        await build();
        devNotify();
      } catch (err) {
        console.error('Build failed (server still running):', err instanceof Error ? err.message : String(err));
      } finally {
        devBuild = null;
        devBuildPending = false;
      }
    })();
  }
  return devBuild;
}

/** Q2: the promise to await before routing, or null when nothing is building. */
function settleDevBuild(): Promise<void> | null {
  if (!devMode || (!devBuild && !devBuildPending)) return null;
  return startDevBuild();
}

// Wrap a dev response so every HTML document carries the bridge (and the resumed state, once).
let invalidateHook: (() => void) | null = null;

function devWrap(inner: (req: any, res: any) => void): (req: any, res: any) => void {
  devMode = true;
  return (req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/__rosefn_reload')) return devReload(req, res);
    if (url.startsWith('/__rosefn_state') && req.method === 'POST') return devSaveState(req, res);
    let injected = false;
    const seed = devResume;
    devResume = null;
    const isHtml = () => String(res.getHeader('content-type') || '').includes('text/html');
    const inject = (chunk: any): any => {
      if (injected || !isHtml()) return chunk;
      const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const at = s.indexOf('<head>');
      if (at < 0) return chunk;
      injected = true;
      const resume = seed ? `<script>window.__rosefn_resume=${seed.replace(/<\/script>/g, '')}</script>` : '';
      const out = s.slice(0, at + 6) + resume + DEV_BRIDGE + s.slice(at + 6);
      return Buffer.isBuffer(chunk) ? Buffer.from(out, 'utf8') : out;
    };
    const write = res.write.bind(res);
    res.write = (chunk: any, ...rest: any[]) => write(inject(chunk), ...rest);
    const end = res.end.bind(res);
    res.end = (chunk: any, ...rest: any[]) => {
      if (!res.headersSent && isHtml()) res.removeHeader('Content-Security-Policy');
      end(chunk === undefined || chunk === null ? chunk : inject(chunk), ...rest);
    };
    inner(req, res);
  };
}

function serveStatic(dir: string, isr = false, dev = false): (req: any, res: any) => void {
  return (req, res) => {
    const blocked = crossSiteWrite(req);
    if (blocked) {
      res.statusCode = blocked.status;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(blocked.body);
      return;
    }
    if (req.method === 'POST' && (req.url || '').startsWith('/__rosefn/revalidate')) {
      const token = process.env.ROSEFN_REVALIDATE_TOKEN || '';
      if (!token) { res.statusCode = 404; res.end(); return; }
      if (req.headers['x-rosefn-token'] !== token) {
        res.statusCode = 403; res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'invalid token' })); return;
      }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          if (invalidateHook) invalidateHook();
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ revalidated: true, scope: payload.all ? 'all' : 'paths' }));
        } catch (e: any) {
          res.statusCode = 400; res.end(JSON.stringify({ error: String(e).slice(0, 120) }));
        }
      });
      return;
    }
    const want = pathnameOf(req.url || '/');
    const canonical = want.replace(/\/+$/, '') || '/';
    if (canonical !== want) {
      let search = '';
      try { search = new URL(req.url || '/', 'http://localhost').search; } catch {  }
      const to = canonical + search;
      res.statusCode = 308;
      res.setHeader('Location', to);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!DOCTYPE html><title>Redirecting</title><p>Redirecting to <a href="${to}">${to}</a>.</p>`);
      return;
    }
    const settled = settleDevBuild();
    const ready = settled ? settled.then(() => loadServer()) : loadServer();
    ready.then(async (ssrModule: any) => {
      const hookCtx = ssrModule.hasRequestHooks === true || ssrModule.hasResponseHooks === true
        ? await hookContext(req)
        : null;
      if (hookCtx) {
        const short = await ssrModule.runRequestHooks(hookCtx);
        if (short) {
          await sendWebResponse(await ssrModule.runResponseHooks(hookCtx, short), res);
          return;
        }
      }
      const apiPath0 = pathnameOf(req.url);
      const isPagePost = req.method === 'POST' && !ssrModule.isApi(apiPath0);
      if (!isPagePost && ssrModule.middleware) {
        const mw = await ssrModule.runMiddleware(req);
        if (mw) {
          await sendWebResponse(hookCtx ? await ssrModule.runResponseHooks(hookCtx, mw) : mw, res);
          return;
        }
      }
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
            ssrModule.setQuery?.(queryOf(req.url));
            if ((req.method || 'GET') !== 'GET') ssrModule.invalidateRenderCache?.();
            let apiRes = await ssrModule.handleApi(req.method || 'GET', apiPath, request);
            if (hookCtx) apiRes = await ssrModule.runResponseHooks(hookCtx, apiRes);
            writeWebHeaders(apiRes, res);
            res.statusCode = apiRes.status;
            res.end(Buffer.from(await apiRes.arrayBuffer()));
          } catch (err) {
            console.error(`Rosefn: ${req.method} ${req.url} api handler failed:`, err instanceof Error ? err.stack ?? err.message : String(err));
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end('{"error":"api handler failed"}');
          }
        });
        return;
      }

      if (req.method === 'POST') {
        readBody(req, res, async (body) => {
          try {
            const form = await new Response(body, {
              headers: { 'content-type': req.headers['content-type'] || 'application/x-www-form-urlencoded' },
            }).formData();
            if (ssrModule.middleware) {
              const mw = await ssrModule.runMiddleware(req, form);
              if (mw) {
                await sendWebResponse(hookCtx ? await ssrModule.runResponseHooks(hookCtx, mw) : mw, res);
                return;
              }
            }
            ssrModule.setQuery?.(queryOf(req.url));
            ssrModule.invalidateRenderCache?.();
            const page = await ssrModule.renderPage(pathnameOf(req.url || '/'), form);
            await sendPage(req, res, ssrModule, hookCtx, page, pathnameOf(req.url || '/'));
          } catch (err) {
            console.error(`Rosefn: POST ${pathnameOf(req.url || '/')} failed:`, err instanceof Error ? err.stack : err);
            if (!res.headersSent) {
              res.statusCode = 400;
              res.end('Bad request');
            }
          }
        });
        return;
      }

      let safe = path.normalize(pathnameOf(req.url || '/')).replace(/^(\.\.(\/)?)+/, '');
      if (safe === '\\' || safe === '/') safe = '/';
      let filePath = path.join(dir, safe);

      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }

      if (/\.(?:br|gz)$/i.test(safe)) {
        const base = filePath.replace(/\.(?:br|gz)$/i, '');
        if (fs.existsSync(base)) filePath = base;
      }

      const isAsset = ASSET_EXT.has(path.extname(safe).toLowerCase());
      const isDynamic = !isAsset && (ssrModule.dynamicRoutes as string[] | undefined)?.includes(pathnameOf(req.url));
      if (!isDynamic && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const st = fs.statSync(filePath);
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
        const fileHeaders: Record<string, string> = {
          'Content-Type': types[ext] || 'application/octet-stream',
          'Cache-Control': devMode ? 'no-cache' : rev ? `public, max-age=0, stale-while-revalidate=${rev.seconds}` : 'public, max-age=3600',
          'ETag': entry.etag,
          'Vary': 'Accept-Encoding',
        };
        if (ext === '.html') Object.assign(fileHeaders, pageHeaders(ssrModule, pathnameOf(req.url)));
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
        const enc = devMode ? null : pickEncoding(req);
        res.statusCode = status;
        if (enc) {
          res.setHeader('Content-Encoding', enc);
          res.end(enc === 'br' ? entry.br : enc === 'gzip' ? entry.gzip : compress('deflate', entry.raw));
        } else {
          res.end(entry.raw);
        }
        return;
      }

      let broken = new Set<string>();
      try {
        broken = new Set(JSON.parse(fs.readFileSync(path.join(dir, 'broken.json'), 'utf-8')));
      } catch { /* no manifest: nothing known-broken */ }
      const safe2 = pathnameOf(req.url || '/');
      ssrModule.setQuery?.(queryOf(req.url));
      if (!dev && !broken.has(safe2) && !ssrModule.isBuffered?.(safe2) && ssrModule.canStream(safe2) && !ssrModule.isNoJs(safe2)) {
        const enc = pickEncoding(req);
        let status = 200;
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
          let flushed = false;
          write = (chunk) => {
            compressor.write(chunk);
            if (!flushed) {
              flushed = true;
              compressor.flush(zlib.constants.Z_FULL_FLUSH);
            }
          };
          compressor.on('error', () => res.destroy());
          done = () => compressor.end();
        } else {
          write = (chunk) => res.write(chunk);
          done = () => res.end();
        }
        const doc = ssrModule.docAttrs(safe2);
        await ssrModule.renderPageStream(safe2, write, shellOpen(getStyles(), doc.lang, doc.dir, !ssrModule.shellOff(safe2)), clientScriptTag(getClientSource(), nonce));
        done();
        return;
      }
      const hasQuery = (req.url || '').includes('?');
      const page = req.method === 'GET' && !hasQuery && ssrModule.renderPageCached
        ? await ssrModule.renderPageCached(safe2, String(req.headers.cookie || ''))
        : await ssrModule.renderPage(safe2);
      await sendPage(req, res, ssrModule, hookCtx, page, safe2);
    }).catch((err: unknown) => {
      console.error(`Rosefn: ${req.method} ${req.url} failed:`, err instanceof Error ? err.stack ?? err.message : err);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const devErr = err as { file?: string; line?: number | string; hint?: string };
      let devDetail = '';
      if (process.env.ROSEFN_DEV === '1' && err) {
        const stack = err instanceof Error ? (err.stack || '').split('\n').slice(1, 7).join('\n') : '';
        devDetail =
          '<div style="margin:24px auto;max-width:860px;font:13px/1.6 ui-monospace,monospace;background:#1b1b1f;color:#e6e6ea;border:1px solid #3a3a42;border-radius:10px;padding:20px 24px;text-align:left;white-space:pre-wrap;word-break:break-word">' +
          '<div style="font:600 15px/1.4 system-ui,sans-serif;color:#ff8b8b">Render failed: ' + escapeHtml(req.url || '') + '</div>' +
          '<div style="margin:10px 0 0;color:#ffd479">' + escapeHtml(err instanceof Error ? err.message : err) + '</div>' +
          (devErr.file ? '<div style="margin:6px 0 0;color:#9ad1ff">' + escapeHtml(devErr.file) + (devErr.line != null ? ':' + devErr.line : '') + '</div>' : '') +
          (devErr.hint ? '<div style="margin:10px 0 0;color:#9fe8b0">Fix: ' + escapeHtml(devErr.hint) + '</div>' : '') +
          (stack ? '<pre style="margin:12px 0 0;color:#8f8f9a">' + escapeHtml(stack) + '</pre>' : '') +
          '</div>';
      }
      res.end('<h1>500</h1><p>Something went wrong rendering this page.</p>' + devDetail);
    });
  };
}

/** HTML-escape for the dev error overlay (F10). */
function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch] as string));
}

/** Strip the query string: routing matches the pathname, handlers read the full URL. */
function pathnameOf(url: string | undefined): string {  try {
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
 * The FRAMEWORK's version - one source of truth, no constant to drift.
 *
 * Three layouts answer, in order:
 *  1. src/FRAMEWORK_VERSION, a one-line stamp that ships beside the CLI
 *     source. It is the only candidate that survives EMBEDDING: a real app
 *     copies the framework's src/ into its own tree, where the nearest
 *     package.json is the APP's - which is how a banner ended up naming the
 *     app's version as the framework's for weeks, with no way to tell which
 *     framework build was actually running.
 *  2. the package.json two directories up (this repo: the framework's own),
 *  3. the one beside the bundle (the published package: dist-cli/ + src/).
 * A test asserts the stamp equals package.json, so the two cannot drift.
 */
function version(): string {
  for (const rel of ['../FRAMEWORK_VERSION', '../../FRAMEWORK_VERSION', '../../package.json', '../package.json']) {
    try {
      const raw = fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');
      const v = rel.endsWith('FRAMEWORK_VERSION') ? raw.trim() : JSON.parse(raw).version;
      if (v) return v;
    } catch { /* not this layout */ }
  }
  return '0.0.0';
}

/**
 * The PROJECT's version, when it is a different package from the framework.
 * A project that embeds the CLI source (the way a real app does) has its own
 * package.json, and a banner that named only that one left the operator
 * unable to tell which FRAMEWORK build was actually running - the two
 * versions advanced independently for weeks. The banner now names both:
 * "Rosefn v0.4.0 - project: my-app v0.1.1". Absent (running inside the
 * framework repo itself, or a directory with no package.json) -> nothing.
 */
function projectTag(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    if (!pkg.version || pkg.name === 'rosefn') return '';
    return ` - project: ${pkg.name} v${pkg.version}`;
  } catch {
    return '';
  }
}

async function dev(): Promise<void> {
  devMode = true;
  process.env.ROSEFN_DEV = '1';
  console.log(`🌹 Rosefn v${version()}${projectTag()} dev server starting...`);
  try {
    await build();
  } catch (err) {
    console.error('Initial build failed (server still running):', err instanceof Error ? err.message : err);
  }

  let timeout: any;
  fs.watch(SRC_DIR, { recursive: true }, () => {
    devBuildPending = true;
    clearTimeout(timeout);
    timeout = setTimeout(() => { void startDevBuild(); }, 200);
  });

  const http = await import('http');
  const server = http.createServer(devWrap(serveStatic(OUT_DIR, false, true)));

  listenFree(server, PORT, (port) => {
    console.log('🌹 http://localhost:' + port);
  });
}

async function preview(): Promise<void> {
  await build();
  const http = await import('http');
  const server = http.createServer(serveStatic(OUT_DIR, true));

  listenFree(server, PORT, (port) => {
    console.log(`🌹 Rosefn v${version()}${projectTag()} preview at http://localhost:${port}`);
  });
}


async function serve(): Promise<void> {
  if (!fs.existsSync(path.join(OUT_DIR, 'server.js'))) {
    console.error(`Rosefn: ${OUT_DIR} has no server.js - run rosefn build first`);
    process.exit(1);
  }
  const cluster = (await import('node:cluster')).default as any;
  cluster.schedulingPolicy = cluster.SCHED_RR;
  const os = await import('node:os');
  const workers = Math.max(1, Number(process.env.ROSEFN_WORKERS) || os.cpus().length);
  if (cluster.isPrimary) {
    const port = await freePort(Number(process.env.PORT) || 3000);
    for (let i = 0; i < workers; i++) cluster.fork({ PORT: String(port) });
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
    console.log(`🌹 Rosefn v${version()}${projectTag()} serve: ${workers} worker${workers > 1 ? 's' : ''} on http://localhost:${port} (cluster, bounded bodies, graceful shutdown, access log on stdout)`);
    return;
  }
  process.on('disconnect', () => process.exit(0));
  let servicePlugins: any[] = [];
  try {
    servicePlugins = (await loadPlugins(SRC_DIR)).filter((p) => p && p.onServe);
  } catch (err) {
    console.error('Rosefn: rosefn.config.js failed to load for the serve hooks:', err instanceof Error ? err.message : String(err));
  }
  const storeBridge = {
    install: (send: ((name: string, value: unknown) => void) | null) => {
      try { serverModule?.__installStoreTransport?.(send); } catch { /* a stale dist: no bridge, no crash */ }
    },
    deliver: (name: string, value: unknown) => {
      try { serverModule?.__deliverStorePatch?.(name, value); } catch {  }
    },
  };
  try {
    const hooksMod = await loadServer();
    invalidateHook = () => { try { hooksMod.invalidateRenderCache(); } catch {  } };
  } catch (err) {
    console.error('Rosefn: dist/server.js failed to load for the serve hooks:', err instanceof Error ? err.message : String(err));
  }
  const http = await import('node:http');
  const edgeReady = createEdgeHandler(OUT_DIR);
  edgeReady.then(async (handle) => {
    await ready;
    for (const r of (serverModule?.dynamicRoutes as string[] | undefined) || []) {
      if (r.includes(':')) continue;
      try {
        const res = await handle(new Request('http://localhost' + r));
        await res.arrayBuffer();
      } catch { /* a warm-up failure just means that route renders cold */ }
    }
  }).catch(() => {});
  const baseHandler = withAccessLog(serveStatic(OUT_DIR, true), `w${process.pid}`);
  const earlyHintLinks: string[] = (() => {
    try {
      const html = fs.readFileSync(path.join(OUT_DIR, 'index.html'), 'utf8');
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
  let dynRouteSet: Set<string> | null = null;
  const dynRoutesOf = (): Set<string> => {
    const list = (serverModule?.dynamicRoutes as string[] | undefined) || [];
    if (!dynRouteSet || dynRouteSet.size !== list.length) dynRouteSet = new Set(list);
    return dynRouteSet;
  };
  const server = http.createServer(async (req: any, res: any) => {
    try {
      if ((req.method === 'GET' || req.method === 'HEAD') && dynRoutesOf().has(pathnameOf(req.url || '/'))) {
        const handle = await edgeReady;
        if (earlyHintLinks.length && req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')) {
          try { res.writeEarlyHints({ link: earlyHintLinks }); } catch { /* client gone: the render still finishes */ }
        }
        const url = 'http://' + (req.headers.host || `localhost:${PORT}`) + (req.url || '/');
        const response = await handle(new Request(url, { method: req.method, headers: req.headers }));
        res.statusCode = response.status;
        response.headers.forEach((v: string, k: string) => res.setHeader(k, v));
        const htmlDoc = (response.headers.get('content-type') ?? '').startsWith('text/html');
        const enc = htmlDoc && req.method === 'GET' ? pickEncoding(req) : null;
        if (response.body && enc) {
          const raw = Buffer.from(await response.arrayBuffer());
          const etag = 'W/"' + createHash('sha1').update(raw).digest('base64url').slice(0, 24) + '"';
          if (req.headers['if-none-match'] === etag) {
            res.statusCode = 304;
            res.end();
            return;
          }
          const body = compress(enc, raw);
          res.setHeader('ETag', etag);
          res.setHeader('Content-Encoding', enc);
          res.setHeader('Content-Length', String(body.length));
          res.end(body);
          return;
        }
        if (response.body) {
          Readable.fromWeb(response.body as any).pipe(res);
        } else {
          res.end();
        }
        return;
      }
    } catch { /* any edge hiccup falls through to the proven pipeline */ }
    baseHandler(req, res);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 5_000;
  listenFree(server, PORT, async (port) => {
    console.log(`🌹 Rosefn worker ${process.pid} listening on http://localhost:${port}`);
    for (const p of servicePlugins) {
      try {
        await p.onServe({ port, workers, store: storeBridge });
      } catch (err) {
        console.error('Rosefn: plugin', p.name, 'onServe failed:', err instanceof Error ? err.message : String(err));
      }
    }
  });
  const stop = () => {
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
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}


function templatesDir(): string | null {
  for (const rel of ['../../templates', '../templates']) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** The TypeScript-ready files every scaffolded project gets: the ambient
 *  globals (editors and tsc both see them) and a strict tsconfig. */
function writeTypeScriptReady(dir: string): void {
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
    include: ['rosefn-env.d.ts', 'src/**/*.ts'],
  }, null, 2) + '\n');
}


function copyTemplate(dir: string, name: string, display: string): void {
  const base = templatesDir();
  const shipped = base ? path.resolve(base, name) : '';
  const src = fs.existsSync(shipped) ? shipped : path.resolve(name);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    const available = base ? fs.readdirSync(base).join(', ') : '(none found)';
    console.error(`Rosefn: no template '${name}' - available: ${available} (or pass a path to any project directory)`);
    process.exit(1);
  }
  fs.cpSync(src, dir, {
    recursive: true,
    filter: (s) => !/(^|[\\/])(node_modules|dist|\.git)([\\/]|$)/.test(s),
  });
  const pkgFile = path.join(dir, 'package.json');
  if (fs.existsSync(pkgFile)) {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    pkg.name = path.basename(dir);
    if (pkg.dependencies?.rosefn) pkg.dependencies.rosefn = `^${version()}`;
    pkg.devDependencies = { ...pkg.devDependencies, typescript: '^5.6.0' };
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  }
  writeTypeScriptReady(dir);
  console.log(`🌹 rosefn new: ${display}/ from the '${path.basename(src)}' template`);
  console.log(`\n   cd ${display}`);
  console.log(`   npm install && npm run dev`);
  console.log(`   npm run build    # then deploy dist/`);
}

/**
 * `rosefn new <name>` - a starting project. The smallest thing that builds
 * and runs and shows the syntax: one page (state, {#if}, {#each}, a scoped
 * style), one README naming the three commands. Not a second demo app - the
 * point is that a new developer's first `rosefn build` works in seconds.
 *
 * `rosefn new <name> --template <t>` - the
 * official templates (blog, api, admin, site) copied verbatim, with the
 * dependency rewritten to the published package. A name that is not a
 * shipped template is resolved as a PATH, so any project directory works as
 * a template (a team's own starter, a checkout's examples/).
 *
 * Trade-off: three files, written from strings. No template engine, no
 * dependency, no `npm install` run on the developer's behalf (they may use
 * pnpm/yarn/bun, and a surprise install is worse than a printed command).
 */
async function scaffold(): Promise<void> {
  const args = argv.slice(1);
  const tplIdx = args.indexOf('--template');
  const template = tplIdx >= 0 ? args[tplIdx + 1] : null;
  const name = args.find((a, i) => !a.startsWith('-') && i !== (tplIdx >= 0 ? tplIdx + 1 : -1));
  if (!name || (tplIdx >= 0 && !template)) {
    const available = templatesDir() ? fs.readdirSync(templatesDir()!).join(', ') : 'blog, api, admin, site';
    console.log(`Usage: rosefn new <name> [--template <name>]   (creates <name>/ with a page that builds; --template copies an official template - ${available} - or any project directory)`);
    return;
  }
  const dir = path.resolve(name);
  if (fs.existsSync(dir)) {
    console.error(`Rosefn: ${dir} already exists - pick another name`);
    process.exit(1);
  }

  if (template) {
    copyTemplate(dir, template, name);
    return;
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
    devDependencies: { typescript: '^5.6.0' },
  }, null, 2) + '\n');

  writeTypeScriptReady(dir);

  fs.writeFileSync(path.join(pages, 'index.rose'), `<script>
  
  interface Item { label: string }

  let count = $state(0);
  let items = $state<string[]>(['zero hydration', 'one request', 'no build config']);
  let showList = $state(true);

  function increment() { $setState('count', count() + 1); }
  function toggleList() { $setState('showList', !showList()); }
  
  
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

  let tsMod: typeof ts;
  try {
    const req = createRequire(pathToFileURL(path.join(SRC_DIR, 'package.json')));
    tsMod = await import(pathToFileURL(req.resolve('typescript')).href) as typeof ts;
  } catch {
    console.error(`Rosefn: type checking needs typescript in this project - npm i -D typescript`);
    process.exit(1);
  }

  const nextTo = (rel: string[]) => rel.map((r) => fileURLToPath(new URL(r, import.meta.url))).find((p) => fs.existsSync(p));
  const typesFile = nextTo(['../types/rosefn.d.ts', '../src/types/rosefn.d.ts']);
  if (!typesFile) {
    console.error('Rosefn: the type definitions (src/types/rosefn.d.ts) were not found next to the compiler');
    process.exit(1);
  }
  const runtimeSource = nextTo(['../runtime/index.ts', '../src/runtime/index.ts']);

  const norm = (f: string) => path.resolve(f).replace(/\\/g, '/');
  const virtual = new Map<string, string>();
  let checked = 0;
  for (const file of files) {
    const source = await fs.promises.readFile(file, 'utf-8');
    const m = /<script>/.exec(source);
    const script = scriptOf(source);
    if (!script) continue;
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

  const propType = (def: string | null): string => {
    if (!def) return 'unknown';
    if (/^['"`]/.test(def)) return 'string';
    if (/^-?\d+(\.\d+)?$/.test(def)) return 'number';
    if (/^(true|false)$/.test(def)) return 'boolean';
    return 'unknown';
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
      if (targetSource === null) continue;
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
    allowNonTsExtensions: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
  };
  const host = tsMod.createCompilerHost(options);
  host.getCurrentDirectory = () => path.resolve(SRC_DIR);
  const realRead = host.readFile.bind(host);
  const realGet = host.getSourceFile.bind(host);
  host.readFile = (f) => virtual.get(norm(f)) ?? realRead(f);
  host.fileExists = (f) => virtual.has(norm(f)) || tsMod.sys.fileExists(f);
  host.getSourceFile = (f, version, onError, shouldCreate) => {
    const src = virtual.get(norm(f));
    return src ? tsMod.createSourceFile(f, src, version, true) : realGet(f, version, onError, shouldCreate);
  };

  const program = tsMod.createProgram([...virtual.keys(), typesFile], options, host);
  const diagnostics = tsMod.getPreEmitDiagnostics(program)
    .filter((d) => d.file && virtual.has(norm(d.file.fileName)));
  if (diagnostics.length === 0) {
    console.log(`Rosefn: ${checked} script${checked === 1 ? '' : 's'} type-checked, no errors`);
    return;
  }
  for (const d of diagnostics) {
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

const argv = process.argv.slice(2);
const cmd = argv[0];
const asJson = argv.includes('--json');

/** Print a failure the way its reader needs it. A RoseError is the
 *  developer's (or the agent's) to fix from its code alone; anything else
 *  keeps its stack, because it is not. Always exits non-zero: a build that
 *  says nothing and succeeds is the worst failure mode there is. */
function reportFailure(err: unknown): never {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: false, errors: [errorInfo(err)] })}\n`);
  } else if (err instanceof RoseError) {
    console.error(`Rosefn: ${err.message}`);
    if (err.hint) console.error(`  hint: ${err.hint}`);
    const at = err.file ? `${err.file}${err.line ? `:${err.line}` : ''}` : null;
    if (at) console.error(`  at ${at}`);
  } else {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  }
  process.exit(1);
}

if (cmd === 'dev') void dev().catch(reportFailure);
else if (cmd === 'build') void build().catch(reportFailure);
else if (cmd === 'preview') void preview().catch(reportFailure);
else if (cmd === 'serve') void serve().catch(reportFailure);
else if (cmd === 'new') void scaffold().catch(reportFailure);
else if (cmd === 'check') void check().catch(reportFailure);
else if (cmd === 'prompt') console.log(AI_PROMPT);
else console.log('Usage: rosefn dev|build|preview|serve|new|check|prompt [dir] [--json] [--static]   (dir defaults to the current directory; dist/ is written there; --json prints build failures as machine-readable JSON; --static verifies the build is deployable with no server at all; `new <name> [--template blog|api|admin|site]` scaffolds a project)');
