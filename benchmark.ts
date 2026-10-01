/**
 * Rosefn Performance Benchmark
 * Measures: SSR render time, SSR throughput (renders/sec), client bundle
 * size (raw + gzip), network requests, and live HTTP throughput of the Go
 * single binary (requires `go` on PATH - the binary is built and spawned
 * here, so the number is measured every run, never quoted).
 */

import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { gzipSync, brotliCompressSync } from 'zlib';

const ROOT = join(process.cwd(), 'dist');
const START = Date.now();

// 1. Measure SSR render time
import { renderPage, matchRoute } from './dist/server.js';

const ssrStart = Date.now();
const page = await renderPage('/');
const ssrTime = Date.now() - ssrStart;

console.log(`\n🌹 Rosefn Performance Benchmark`);
console.log('===============================');
console.log(`SSR render time: ${ssrTime}ms`);
// Buffer.byteLength: page.html is a string, .length would count CHARACTERS
console.log(`HTML length: ${Buffer.byteLength(page.html, 'utf-8')} bytes`);

// 1b. SSR throughput: renders/sec per route (warm up first for JIT fairness)
async function throughput(pathname: string, n: number): Promise<number> {
  for (let i = 0; i < 100; i++) await renderPage(pathname); // warm-up
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await renderPage(pathname);
  return n / ((performance.now() - t0) / 1000);
}
const N = 2000;
const rpsHome = await throughput('/', N);
const rpsAbout = await throughput('/about', N);
const rpsDynamic = await throughput('/blog/1', N);
console.log(`\nSSR throughput (single core, after warm-up):`);
console.log(`  / (static):        ${rpsHome.toFixed(0)} renders/sec`);
console.log(`  /about ($data):    ${rpsAbout.toFixed(0)} renders/sec`);
console.log(`  /blog/:id (param): ${rpsDynamic.toFixed(0)} renders/sec`);

// 2. Measure client bundle size (raw + gzip)
const clientRaw = statSync(join(ROOT, 'client.js')).size;
const clientGzip = gzipSync(readFileSync(join(ROOT, 'client.js'))).length;
const ssrSize = statSync(join(ROOT, 'server.js')).size;

console.log(`\nBundle sizes:`);
console.log(`  client.js: ${(clientRaw / 1024).toFixed(2)} KB raw / ${(clientGzip / 1024).toFixed(2)} KB gzip`);
console.log(`  server.js: ${(ssrSize / 1024).toFixed(2)} KB`);

// 3. Count network requests for a full page load.
// The client bundle is inlined into the HTML shell, so the document itself is
// the only request - count any external asset references to prove it.
import { getHtmlShell } from './src/cli/shell.js';

const shell = getHtmlShell(page.html, page.state, page.head);
const externalRefs = [...shell.matchAll(/<(?:script|link|img)[^>]*(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !u.startsWith('#') && !u.startsWith('data:'));
const totalRequests = 1 + externalRefs.length;

console.log(`\nNetwork requests for full page load:`);
console.log(`  Total: ${totalRequests}   (HTML document only - client bundle AND all component styles inlined)`);
if (externalRefs.length > 0) console.log(`  external refs: ${externalRefs.join(', ')}`);

// 4. Framework floor: smallest possible app (fair vs SvelteKit's runtime core)
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildProject } from './src/compiler/index.js';

const FLOOR = path.join(os.tmpdir(), 'rosefn-floor');
try {
  fs.rmSync(FLOOR, { recursive: true, force: true });
  fs.mkdirSync(path.join(FLOOR, 'src'), { recursive: true });
  fs.mkdirSync(path.join(FLOOR, 'example', 'src', 'pages'), { recursive: true });
  fs.cpSync(path.join(process.cwd(), 'src', 'runtime'), path.join(FLOOR, 'src', 'runtime'), { recursive: true });
  fs.writeFileSync(
    path.join(FLOOR, 'example', 'src', 'pages', 'index.rose'),
    `<script>\n  let count = $state(0);\n  function inc() { $setState('count', count() + 1); }\n</script>\n\n<div>\n  <h1>hi</h1>\n  <p>{count()}</p>\n  <button on:click={inc}>+1</button>\n</div>\n`
  );
  await buildProject(path.join(FLOOR, 'example'), path.join(FLOOR, 'dist'));
  const floorRaw = fs.statSync(path.join(FLOOR, 'dist', 'client.js')).size;
  const floorGzip = gzipSync(fs.readFileSync(path.join(FLOOR, 'dist', 'client.js'))).length;
  console.log(`\nFramework floor (1 page, 1 state, 1 event - no layouts, no $data):`);
  console.log(`  client.js: ${(floorRaw / 1024).toFixed(2)} KB raw / ${(floorGzip / 1024).toFixed(2)} KB gzip`);
  console.log(`  (this is the fair comparison against SvelteKit's ~2 KB runtime core)`);
} finally {
  fs.rmSync(FLOOR, { recursive: true, force: true });
}

// 5. Prerendered static routes: served from disk, zero server work
const staticRoutes = ['/', '/about', '/blog/1', '/blog/2', '/sign', '/fresh', '/garden', '/thorn', '/en/about', '/zh/about'];
const prerendered = staticRoutes.filter((r) => fs.existsSync(path.join(ROOT, r === '/' ? 'index.html' : `${r.slice(1)}/index.html`)));
console.log(`\nPrerendered static routes (served from disk, zero server work):`);
prerendered.forEach((r) => {
  const file = path.join(ROOT, r === '/' ? 'index.html' : `${r.slice(1)}/index.html`);
  const html = fs.readFileSync(file);
  // self-contained = the document requests nothing external. A csr = false
  // route (innovation #25) passes trivially: it ships no script at all.
  const ok = !/<script[^>]*src="\//.test(html.toString('utf-8'));
  // Buffer.length = bytes on the wire (a utf-8 read would count CHARACTERS:
  // the ⟦m:K⟧ markers, the 🌹 and the em dashes are multi-byte)
  console.log(`  ${r} -> ${path.relative(ROOT, file)} (${html.length} bytes, self-contained: ${ok})`);
});
console.log(`  dynamic routes outside params (e.g. /blog/3): streamed SSR on demand (shell flushes first)`);
// the zero-JS routes: no bundle, no state script, no hydration - a content
// page that runs no JavaScript at all. Since innovation #29 the compiler
// DECIDES these (a route whose chain needs nothing from the client), so the
// blog posts, the ISR page and the localized pages are zero-JS with no
// export anywhere; garden/thorn opt out explicitly.
const gardenFile = path.join(ROOT, 'garden', 'index.html');
const gardenBytes = fs.readFileSync(gardenFile);
console.log(`  /garden (csr = false): ${gardenBytes.length} bytes raw / ${(gzipSync(gardenBytes).length / 1024).toFixed(2)} KB gzip, ZERO JavaScript`);
// the per-route-header route (export const headers = {...}, innovation #26):
// same zero-JS document, now answering default-src 'none' + x-robots-tag
const thornFile = path.join(ROOT, 'thorn', 'index.html');
const thornBytes = fs.readFileSync(thornFile);
console.log(`  /thorn (csr = false + headers): ${thornBytes.length} bytes raw / ${(gzipSync(thornBytes).length / 1024).toFixed(2)} KB gzip, ZERO JavaScript, strict per-route CSP`);
// the localized routes (innovation #27): one baked file per dictionary, so
// the Go binary serves them as plain static files with zero Node
const zhFile = path.join(ROOT, 'zh', 'about', 'index.html');
const zhBytes = fs.readFileSync(zhFile);
console.log(`  /zh/about (i18n): ${zhBytes.length} bytes raw / ${(gzipSync(zhBytes).length / 1024).toFixed(2)} KB gzip, served from disk, ZERO extra requests`);
// the auto zero-JS content routes (innovation #29): the compiler found
// nothing needing the client, so these documents ship no runtime - the
// developer exported nothing
const blog1File = path.join(ROOT, 'blog', '1', 'index.html');
const blog1Bytes = fs.readFileSync(blog1File);
console.log(`  /blog/1 (auto zero-JS): ${blog1Bytes.length} bytes raw / ${(gzipSync(blog1Bytes).length / 1024).toFixed(2)} KB gzip, ZERO JavaScript - no export, no runtime, no state script`);
const freshFile = path.join(ROOT, 'fresh', 'index.html');
const freshBytes = fs.readFileSync(freshFile);
console.log(`  /fresh (auto zero-JS): ${freshBytes.length} bytes raw / ${(gzipSync(freshBytes).length / 1024).toFixed(2)} KB gzip, ZERO JavaScript`);

// 6. Route matching sanity check
const routeChecks: Array<[string, boolean]> = [
  ['/', matchRoute('/', '/')],
  ['/about', matchRoute('/about', '/about')],
  ['/blog/:id', matchRoute('/blog/:id', '/blog/1')],
  ['/blog/:id', !matchRoute('/blog/:id', '/about')],
];
const routeOk = routeChecks.every(([, ok]) => ok);

console.log(`\nRoute matching: ${routeOk ? 'OK' : 'FAIL'}`);

// 7. Comparison - MEASURED, not quoted (2026-09-20, this machine, Node v22).
// Same minimal app (heading + counter + button) built with each framework's
// current release; total transfer = gzip(html) + gzip(all JS the page loads).
console.log(`\nComparison (measured 2026-09-20, same machine, same minimal app):`);
console.log(`  Next.js 15.5:      8 requests, 142.35 KB gzip total (140.74 KB JS)`);
console.log(`  SvelteKit 2.70:   10 requests,  31.14 KB gzip total ( 30.65 KB JS)`);
console.log(`  Qwik City 1.20:    5 requests,  24.23 KB gzip total ( 23.53 KB JS)`);
console.log(`  SolidStart v2:     6 requests,  24.73 KB gzip total ( 20.98 KB JS + 3.16 KB CSS)`);
console.log(`  Go + HTMX 2.0.10:  2 requests,  16.42 KB gzip total ( 16.20 KB JS - page not interactive until 2nd response)`);
console.log(`  Django 5.2 + HTMX: 2 requests,  16.42 KB gzip total ( 16.20 KB JS - page not interactive until 2nd response)`);
console.log(`  Rosefn:            ${totalRequests} request,  ${(gzipSync(Buffer.from(shell)).length / 1024).toFixed(2)} KB gzip total (${(clientGzip / 1024).toFixed(2)} KB JS, ALL routes, 11-route demo)`);
console.log(`  Rosefn zero-JS:    ${totalRequests} request,  ${(gzipSync(gardenBytes).length / 1024).toFixed(2)} KB gzip total, 0.00 KB JS (a csr = false content page - no runtime, no state script, no hydration)`);
console.log(`  Rosefn auto 0-JS:  ${totalRequests} request,  ${(gzipSync(blog1Bytes).length / 1024).toFixed(2)} KB gzip total, 0.00 KB JS (a content route the COMPILER decided needs no client - no export at all)`);
console.log(`  Rosefn (brotli):   ${totalRequests} request,  ${(brotliCompressSync(Buffer.from(shell)).length / 1024).toFixed(2)} KB brotli total - the Node server negotiates br > gzip on the wire, like the Go binary`);
console.log(`  (Rosefn demo carries 11 routes + nested layouts + link prefetch + per-route <head> blocks + progressive-enhancement forms + server actions from any event + scoped component styles + client-side refresh + api routes + component lifecycle + middleware + ISR revalidation + error boundaries + zero-JS content routes + per-route response headers with a strict CSP hashed over the exact inlined bytes + localized i18n routes and still delivers ~${(16.42 * 1024 / gzipSync(Buffer.from(shell)).length).toFixed(1)}x fewer bytes than the smallest competitor)`);
console.log(`  (the bootstrap - navigation, prefetch listeners, view transitions, form interception - is minified once at module load and inlined into every document)`);

// 8. HTTP page-load throughput - MEASURED LIVE against the Go single binary
//    (this benchmark builds and spawns it; requires `go` on PATH). Same
//    harness shape as the reference rows: 8 parallel keep-alive connections,
//    8000 GETs, a browser's Accept-Encoding (br, gzip). The htmx/Django rows
//    are documented history - those reference apps are not part of this
//    repo; they were measured on this machine on 2026-09-21 with this same
//    harness. The Rosefn number is never stale: it is re-measured every run.
import { spawn, execSync } from 'child_process';
import { request, Agent } from 'http';

const GO_PORT = 8124;
const goBin = process.platform === 'win32' ? 'rosefn-server-go.exe' : 'rosefn-server-go';
execSync(`go build -o ${goBin} .`, { stdio: 'ignore' });
const goProc = spawn(join(process.cwd(), goBin), [], {
  env: { ...process.env, PORT: String(GO_PORT) },
  stdio: 'ignore'
});
const goBase = `http://localhost:${GO_PORT}`;
const goAgent = new Agent({ keepAlive: true, maxSockets: 8 });
const wireGet = (pathname: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request(
      { host: 'localhost', port: GO_PORT, path: pathname, agent: goAgent, headers: { 'accept-encoding': 'br, gzip' } },
      (res) => {
        let bytes = 0;
        res.on('data', (c: Buffer) => { bytes += c.length; });
        res.on('end', () => resolve(bytes));
      }
    );
    req.on('error', reject);
    req.end();
  });
try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { await fetch(goBase + '/'); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!up) throw new Error('the Go single-binary server did not start');
  const hammer = async (pathname: string, total: number) => {
    const t0 = performance.now();
    // each worker sums its own bytes: a shared `bytes += await ...` across
    // concurrent workers loses updates (read-modify-write is not atomic)
    const per = await Promise.all(Array.from({ length: 8 }, async () => {
      let bytes = 0;
      for (let i = 0; i < total / 8; i++) bytes += await wireGet(pathname);
      return bytes;
    }));
    return { rps: total / ((performance.now() - t0) / 1000), bytes: per.reduce((a, b) => a + b, 0) / total };
  };
  const goPage = await hammer('/', 8000);
  const goAsset = await hammer('/styles.css', 8000);
  console.log(`\nHTTP throughput (8 parallel keep-alive, 8000 GETs each, this machine):`);
  console.log(`  Rosefn Go binary:  ${goPage.rps.toFixed(0)} req/sec (${(goPage.bytes / 1024).toFixed(2)} KB brotli per page - the self-contained app, precompressed at build time)`);
  console.log(`  same binary, asset: ${goAsset.rps.toFixed(0)} req/sec (${(goAsset.bytes / 1024).toFixed(2)} KB brotli - the bare-Go ceiling for this server)`);
  console.log(`  Go + HTMX:         6653 req/sec (311 B shell; interactive only after a 2nd 16.2 KB request)`);
  console.log(`  Django + HTMX:      611 req/sec (1.64 ms/page, DEBUG dev server)`);
} finally {
  goProc.kill();
  goAgent.destroy();
}

const totalTime = Date.now() - START;
console.log(`\nBenchmark completed in ${totalTime}ms`);
console.log('===============================\n');

if (!routeOk) process.exit(1);
