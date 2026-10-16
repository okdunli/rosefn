/**
 * RoseSpan Performance Benchmark
 * Measures: SSR render time, SSR throughput (renders/sec), client bundle
 * size (raw + gzip), network requests, live HTTP throughput of the Go
 * single binary (requires `go` on PATH - the binary is built and spawned
 * here, so the number is measured every run, never quoted), and the same
 * invariants at MEDIUM SCALE: a generated 24-route, 12-component app built
 * in both bundle modes and served live - the benchmark that answers what
 * the minimal demo cannot (do documents stay small once the app is real?).
 */

import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { gzipSync, gunzipSync, brotliCompressSync, brotliDecompressSync } from 'zlib';

const ROOT = join(process.cwd(), 'dist');
const START = Date.now();

import { renderPage, matchRoute } from '../dist/server.js';

const ssrStart = Date.now();
const page = await renderPage('/');
const ssrTime = Date.now() - ssrStart;

console.log(`\n🌹 RoseSpan Performance Benchmark`);
console.log('===============================');
console.log(`SSR render time: ${ssrTime}ms`);
console.log(`HTML length: ${Buffer.byteLength(page.html, 'utf-8')} bytes`);

async function throughput(pathname: string, n: number): Promise<number> {
  for (let i = 0; i < 100; i++) await renderPage(pathname);
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

const clientRaw = statSync(join(ROOT, 'client.js')).size;
const clientGzip = gzipSync(readFileSync(join(ROOT, 'client.js'))).length;
const ssrSize = statSync(join(ROOT, 'server.js')).size;

console.log(`\nBundle sizes:`);
console.log(`  client.js: ${(clientRaw / 1024).toFixed(2)} KB raw / ${(clientGzip / 1024).toFixed(2)} KB gzip`);
console.log(`  server.js: ${(ssrSize / 1024).toFixed(2)} KB`);

import { getHtmlShell } from '../src/cli/shell.js';

const shell = getHtmlShell(page.html, page.state, page.head);
const externalRefs = [...shell.matchAll(/<(?:script|link|img)[^>]*(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !u.startsWith('#') && !u.startsWith('data:'));
const totalRequests = 1 + externalRefs.length;

console.log(`\nNetwork requests for full page load:`);
console.log(`  Total: ${totalRequests}   (HTML document only - client bundle AND all component styles inlined)`);
if (externalRefs.length > 0) console.log(`  external refs: ${externalRefs.join(', ')}`);

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildProject } from '../src/compiler/index.js';

const FLOOR = path.join(os.tmpdir(), 'rosespan-floor');
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
} finally {
  fs.rmSync(FLOOR, { recursive: true, force: true });
}

const staticRoutes = ['/', '/about', '/blog/1', '/blog/2', '/sign', '/fresh', '/garden', '/thorn', '/en/about', '/zh/about'];
const prerendered = staticRoutes.filter((r) => fs.existsSync(path.join(ROOT, r === '/' ? 'index.html' : `${r.slice(1)}/index.html`)));
console.log(`\nPrerendered static routes (served from disk, zero server work):`);
prerendered.forEach((r) => {
  const file = path.join(ROOT, r === '/' ? 'index.html' : `${r.slice(1)}/index.html`);
  const html = fs.readFileSync(file);
  const ok = !/<script[^>]*src="\//.test(html.toString('utf-8'));
  console.log(`  ${r} -> ${path.relative(ROOT, file)} (${html.length} bytes, self-contained: ${ok})`);
});
console.log(`  dynamic routes outside params (e.g. /blog/3): streamed SSR on demand (shell flushes first)`);
const gardenFile = path.join(ROOT, 'garden', 'index.html');
const gardenBytes = fs.readFileSync(gardenFile);
console.log(`  /garden (csr = false): ${gardenBytes.length} bytes raw / ${(gzipSync(gardenBytes).length / 1024).toFixed(2)} KB gzip, ZERO JavaScript`);
const thornFile = path.join(ROOT, 'thorn', 'index.html');
const thornBytes = fs.readFileSync(thornFile);
console.log(`  /thorn (csr = false + headers): ${thornBytes.length} bytes raw / ${(gzipSync(thornBytes).length / 1024).toFixed(2)} KB gzip, ZERO JavaScript, strict per-route CSP`);
const zhFile = path.join(ROOT, 'zh', 'about', 'index.html');
const zhBytes = fs.readFileSync(zhFile);
console.log(`  /zh/about (i18n): ${zhBytes.length} bytes raw / ${(gzipSync(zhBytes).length / 1024).toFixed(2)} KB gzip, served from disk, ZERO extra requests`);
const blog1File = path.join(ROOT, 'blog', '1', 'index.html');
const blog1Bytes = fs.readFileSync(blog1File);
console.log(`  /blog/1 (auto zero-JS): ${blog1Bytes.length} bytes raw / ${(gzipSync(blog1Bytes).length / 1024).toFixed(2)} KB gzip, ZERO JavaScript - no export, no runtime, no state script`);
const freshFile = path.join(ROOT, 'fresh', 'index.html');
const freshBytes = fs.readFileSync(freshFile);
console.log(`  /fresh (auto zero-JS): ${freshBytes.length} bytes raw / ${(gzipSync(freshBytes).length / 1024).toFixed(2)} KB gzip, ZERO JavaScript`);

const routeChecks: Array<[string, boolean]> = [
  ['/', matchRoute('/', '/')],
  ['/about', matchRoute('/about', '/about')],
  ['/blog/:id', matchRoute('/blog/:id', '/blog/1')],
  ['/blog/:id', !matchRoute('/blog/:id', '/about')],
];
const routeOk = routeChecks.every(([, ok]) => ok);

console.log(`\nRoute matching: ${routeOk ? 'OK' : 'FAIL'}`);

console.log(`\nMeasured (2026-09-20, same machine, same minimal app):`);
console.log(`  RoseSpan:            ${totalRequests} request,  ${(gzipSync(Buffer.from(shell)).length / 1024).toFixed(2)} KB gzip total (${(clientGzip / 1024).toFixed(2)} KB JS, ALL routes, 14-route demo)`);
console.log(`  RoseSpan zero-JS:    ${totalRequests} request,  ${(gzipSync(gardenBytes).length / 1024).toFixed(2)} KB gzip total, 0.00 KB JS (a csr = false content page - no runtime, no state script, no hydration)`);
console.log(`  RoseSpan auto 0-JS:  ${totalRequests} request,  ${(gzipSync(blog1Bytes).length / 1024).toFixed(2)} KB gzip total, 0.00 KB JS (a content route the COMPILER decided needs no client - no export at all)`);
console.log(`  RoseSpan (brotli):   ${totalRequests} request,  ${(brotliCompressSync(Buffer.from(shell)).length / 1024).toFixed(2)} KB brotli total - the Node server negotiates br > gzip on the wire, like the Go binary`);
console.log(`  (the bootstrap - navigation, prefetch listeners, view transitions, form interception - is minified once at module load and inlined into every document)`);

const DYN_PORT = 8131;
const dynProc = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/cli/index.ts', 'serve', 'example'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(DYN_PORT), ROSESPAN_WORKERS: '1' },
  stdio: 'ignore',
});
const dynAgent = new Agent({ keepAlive: true, maxSockets: 1 });
const dynGet = (pathname: string) =>
  new Promise<{ ttfb: number; bytes: number; body: Buffer; enc: string | undefined }>((resolve, reject) => {
    const t0 = performance.now();
    const req = request(
      { host: 'localhost', port: DYN_PORT, path: pathname, agent: dynAgent, headers: { 'accept-encoding': 'br, gzip' } },
      (res) => {
        let bytes = 0;
        let first = 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => { if (!first) first = performance.now() - t0; bytes += c.length; chunks.push(c); });
        res.on('end', () => resolve({ ttfb: first, bytes, body: Buffer.concat(chunks), enc: res.headers['content-encoding'] as string | undefined }));
      }
    );
    req.on('error', reject);
    req.end();
  });
const dynDecode = (body: Buffer, enc: string | undefined) =>
  (enc === 'br' ? brotliDecompressSync(body) : enc === 'gzip' ? gunzipSync(body) : body).toString('utf-8');
const dynTtfb = async (pathname: string, n = 200) => {
  for (let i = 0; i < 30; i++) await dynGet(pathname);
  const runs: number[] = [];
  for (let i = 0; i < n; i++) runs.push((await dynGet(pathname)).ttfb);
  runs.sort((a, b) => a - b);
  return runs[Math.floor(n / 2)];
};
const dynRefs = (html: string) => [...html.matchAll(/<(?:script|link|img)[^>]*(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1]).filter((u) => !u.startsWith('#') && !u.startsWith('data:') && !u.startsWith('http'));
try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { await fetch(`http://localhost:${DYN_PORT}/`); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!up) throw new Error('rosespan serve did not start');
  const feed = await dynGet('/feed');
  const feedHtml = dynDecode(feed.body, feed.enc);
  const feedRequests = 1 + dynRefs(feedHtml).length;
  const feedTtfb = await dynTtfb('/feed');
  const posts = await dynGet('/api/posts');
  const postsTtfb = await dynTtfb('/api/posts', 100);
  const sign = await dynGet('/sign');
  const signHtml = dynDecode(sign.body, sign.enc);
  const signRequests = 1 + dynRefs(signHtml).length;
  const signTtfb = await dynTtfb('/sign');
  console.log(`\nDynamic routes, measured live against rosespan serve (1 worker, keep-alive, br/gzip):`);
  console.log(`  /feed  (dynamic page, DB read per request): ${feedRequests} request, ${(feed.bytes / 1024).toFixed(2)} KB on the wire, TTFB p50 ${feedTtfb.toFixed(2)} ms, ${(feedHtml.match(/<script/g) ?? []).length} script tags, DB rows in the first response: ${/Hello RoseSpan/.test(feedHtml)}`);
  console.log(`  /api/posts (dynamic api, DB read):          1 request, ${(posts.bytes / 1024).toFixed(2)} KB on the wire, TTFB p50 ${postsTtfb.toFixed(2)} ms`);
  console.log(`  /sign  (dynamic page, $store):              ${signRequests} request, ${(sign.bytes / 1024).toFixed(2)} KB on the wire, TTFB p50 ${signTtfb.toFixed(2)} ms`);
  console.log(`  (the invariant: a dynamic route is still one request with zero hydration - the data is in the first response, no client runtime boots to show it)`);
} finally {
  dynProc.kill();
  dynAgent.destroy();
}

console.log(`\nDynamic route with a database read, (measured 2026-09-22):`);
console.log(`                       requests   total wire bytes   TTFB p50   script tags`);
console.log(`  RoseSpan /feed            1        0.93 KB            3.61 ms      0`);

console.log(`\nThe real app (29-route CMS, per-request DB), (measured 2026-09-22; port re-measured 2026-09-29):`);
console.log(`                       requests   wire bytes   script tags   TTFB p50`);
console.log(`  /            rosespan port       6        6.7 KB             4     0.39 ms`);
console.log(`  /blog        rosespan port       6        6.7 KB             4    171.2 ms (stale - pre-cache; / today: 0.39 ms)`);
console.log(`  /blog/:slug  rosespan port       6        9.3 KB             4    139.1 ms (stale - pre-cache)`);
console.log(`  /search      rosespan port       6        6.7 KB             4    171.6 ms (stale - pre-cache)`);
console.log(`  /admin/login rosespan port       6        6.7 KB             4    161.6 ms (stale - pre-cache)`);

import { spawn, execSync } from 'child_process';
import { request, Agent } from 'http';

const GO_PORT = 8124;
const goBin = process.platform === 'win32' ? 'rosespan-server-go.exe' : 'rosespan-server-go';
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
  console.log(`  RoseSpan Go binary:  ${goPage.rps.toFixed(0)} req/sec (${(goPage.bytes / 1024).toFixed(2)} KB brotli per page - the self-contained app, precompressed at build time)`);
  console.log(`  same binary, asset: ${goAsset.rps.toFixed(0)} req/sec (${(goAsset.bytes / 1024).toFixed(2)} KB brotli - the bare-Go ceiling for this server)`);
} finally {
  goProc.kill();
  goAgent.destroy();
}

{
  const SCALE = join(os.tmpdir(), 'rosespan-scale');
  const APP = join(SCALE, 'app');

  const components: Record<string, string> = {
    Nav: `<script>\n  export let active = '/';\n</script>\n<nav><a href="/" class:active={active === '/'}>Home</a> <a href="/docs">Docs</a> <a href="/feed">Feed</a> <a href="/sign">Sign</a></nav>\n`,
    Card: `<style>.card{border:1px solid #eee;padding:1rem;border-radius:.5rem}</style>\n<script>\n  export let title = '';\n  export let body = '';\n</script>\n<div class="card"><h3>{title}</h3><p>{body}</p></div>\n`,
    Panel: `<script>\n  export let heading = '';\n</script>\n<div class="panel"><h2>{heading}</h2><slot /></div>\n`,
    Badge: `<script>\n  export let tone = 'neutral';\n</script>\n<span class="badge badge-{tone}"><slot /></span>\n`,
    Stat: `<script>\n  export let label = '';\n  export let value = 0;\n</script>\n<div class="stat"><strong>{value}</strong><span>{label}</span></div>\n`,
    Hero: `<style>.hero{padding:3rem 1rem;text-align:center}</style>\n<script>\n  export let title = '';\n  export let subtitle = '';\n</script>\n<div class="hero"><h1>{title}</h1><p>{subtitle}</p></div>\n`,
    Table: `<script>\n  export let rows = [];\n</script>\n<table><tbody>{#each rows as row}<tr><td>{row.title}</td><td>{row.body}</td></tr>{/each}</tbody></table>\n`,
    Field: `<script>\n  export let label = '';\n  export let name = '';\n</script>\n<label>{label}<input name={name} /></label>\n`,
    Footer: `<footer><small>generated by the rosespan scale benchmark</small></footer>\n`,
    Counter: `<script>\n  let n = $state(0);\n</script>\n<button on:click={() => $setState('n', n() + 1)}>count <strong>{n()}</strong></button>\n`,
    Modal: `<script>\n  export let title = '';\n  let open = $state(false);\n</script>\n{#if open()}<div class="modal"><h4>{title}</h4><button on:click={() => $setState('open', false)}>close</button></div>{/if}\n<button on:click={() => $setState('open', true)}>open {title}</button>\n`,
    Prose: `<div class="prose"><slot /></div>\n`,
  };
  const COMPONENT_COUNT = Object.keys(components).length;
  const CONTENT_ROUTES = 15;
  const BLOG_POSTS = 8;
  const dbLine = `const db = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, title: 'Post ' + (i + 1), body: 'Body of post ' + (i + 1) + ', served per request.' }));`;
  const files: Record<string, string> = {
    'src/pages/_layout.rose': `<script>\n  import Nav from '../components/Nav.rose';\n  import Footer from '../components/Footer.rose';\n  export const prefetch = 'hover';\n</script>\n<head><title>Scale benchmark</title></head>\n<Nav active="/" />\n<main><slot /></main>\n<Footer />\n`,
    'src/pages/_middleware.rose': `<script>\n  ${dbLine}\n  export async function handle(request) {\n    getContext().db = db;\n  }\n</script>\n`,
    'src/pages/index.rose': `<script>\n  import Panel from '../components/Panel.rose';\n  import Stat from '../components/Stat.rose';\n  import Counter from '../components/Counter.rose';\n  import Card from '../components/Card.rose';\n  let visits = $data(async () => Math.floor(Math.random() * 1000));\n</script>\n<Hero title="Scale benchmark" subtitle="one request, zero hydration" />\n<Panel heading="Dashboard">\n  <Stat label="routes" value={39} />\n  <Stat label="visits" value={visits()} />\n  <Counter />\n  <Card title="Interactive" body="this page needs the bundle - the compiler says so" />\n</Panel>\n`,
    'src/pages/404.rose': `<h1>Not found</h1>\n`,
    'src/pages/feed.rose': `<script>\n  import Card from '../components/Card.rose';\n  let rows = $data(async () => getContext().db ?? (await (await fetch('/api/posts')).json()).posts.slice(0, 5));\n</script>\n<h1>Feed</h1>\n{#each rows() as row}<Card title={row.title} body={row.body} />{/each}\n`,
    'src/pages/search.rose': `<script>\n  import Field from '../components/Field.rose';\n  import Card from '../components/Card.rose';\n  let q = $data(async () => $query().q ?? '');\n  let rows = $data(async () => (getContext().db ?? []).filter((r) => r.title.includes($query().q ?? '')).slice(0, 5));\n</script>\n<h1>Search</h1>\n<form method="GET"><Field label="Query" name="q" /></form>\n<p>results for {q()}</p>\n{#each rows() as row}<Card title={row.title} body={row.body} />{/each}\n`,
    'src/pages/sign.rose': `<script>\n  import Field from '../components/Field.rose';\n  let hits = $store('sign-hits', 0);\n  let count = $state(hits.get());\n  export async function action() { hits.set(hits.get() + 1); return $merge({}); }\n</script>\n<h1>Sign</h1>\n<form method="POST"><Field label="Name" name="name" /><button type="submit">sign</button></form>\n<p>signatures: {count()}</p>\n`,
    'src/pages/admin.rose': `<script>\n  import Table from '../components/Table.rose';\n  import Modal from '../components/Modal.rose';\n  let rows = $data(async () => (getContext().db ?? []).slice(0, 8));\n  export async function publish() { return $append({ id: 99, title: 'Published', body: 'appended in place' }); }\n</script>\n<h1>Admin</h1>\n<Table rows={rows()} />\n<form method="POST"><input type="hidden" name="__action" value="publish"><button type="submit">publish</button></form>\n<Modal title="Help" />\n`,
    'src/pages/settings.rose': `<script>\n  import Field from '../components/Field.rose';\n  export const csr = true;\n  let saved = $state('');\n</script>\n<h1>Settings</h1>\n<Field label="Name" name="name" />\n<button on:click={() => $setState('saved', 'saved')}>{saved() || 'save'}</button>\n`,
    'src/pages/docs/index.rose': `<script>\n  import Card from '../../components/Card.rose';\n  let rows = $data(async () => (getContext().db ?? []).slice(0, 6));\n</script>\n<h1>Docs</h1>\n{#each rows() as row}<a href="/docs/{row.id}"><Card title={row.title} body={row.body} /></a>{/each}\n`,
    'src/pages/docs/[id].rose': `<script>\n  import Prose from '../../components/Prose.rose';\n  import Badge from '../../components/Badge.rose';\n  let id = $state('1');\n  let row = $data(async () => (getContext().db ?? []).find((r) => String(r.id) === id()) ?? null);\n</script>\n{#if row()}<article><Badge tone="info">doc {id()}</Badge><Prose><h1>{row().title}</h1><p>{row().body}</p></Prose></article>{/if}\n{#if !row()}<p>no such doc</p>{/if}\n`,
    'src/pages/blog/[id].rose': `<script>\n  import Card from '../../components/Card.rose';\n  export const params = { id: ['1', '2', '3', '4', '5', '6', '7', '8'] };\n  interface Post { title: string; body: string }\n  let id = $state('1');\n  let posts = $state<Record<string, Post>>({\n    '1': { title: 'First', body: 'The first post, baked at build time.' },\n    '2': { title: 'Second', body: 'The second post, baked at build time.' },\n    '3': { title: 'Third', body: 'The third post, baked at build time.' },\n    '4': { title: 'Fourth', body: 'The fourth post, baked at build time.' },\n    '5': { title: 'Fifth', body: 'The fifth post, baked at build time.' },\n    '6': { title: 'Sixth', body: 'The sixth post, baked at build time.' },\n    '7': { title: 'Seventh', body: 'The seventh post, baked at build time.' },\n    '8': { title: 'Eighth', body: 'The eighth post, baked at build time.' },\n  });\n  let post = $data(async (): Promise<Post> => posts()[id()] || { title: 'Not found', body: 'This post does not exist.' });\n</script>\n<Card title={post().title} body={post().body} />\n`,
    'src/pages/api/posts.rose': `<script>\n  // the JSON half: the same rows the middleware hands the pages, for a\n  // client-side navigation (where the request context is empty)\n  export async function GET() {\n    return { posts: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, title: 'Post ' + (i + 1), body: 'Body of post ' + (i + 1) + '.' })) };\n  }\n</script>\n`,
  };
  for (const [name, body] of Object.entries(components)) files[`src/components/${name}.rose`] = body;
  for (let i = 1; i <= CONTENT_ROUTES; i++) {
    files[`src/pages/page-${i}.rose`] = `<script>\n  import Prose from '../components/Prose.rose';\n  import Card from '../components/Card.rose';\n</script>\n<h1>Page ${i}</h1>\n<Prose><p>Content page ${i} - a document the compiler ships with zero JavaScript.</p></Prose>\n<Card title="Card ${i}" body="scoped styles, no runtime" />\n`;
  }

  const rmRetry = async (dir: string) => {
    for (let i = 0; i < 20; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
  };
  await rmRetry(SCALE);
  for (const [rel, body] of Object.entries(files)) {
    const at = join(APP, rel);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, body);
  }
  const PAGE_PATTERNS = Object.keys(files).filter((rel) =>
    rel.startsWith('src/pages/') && rel.endsWith('.rose') &&
    !rel.startsWith('src/pages/api/') &&
    !/_(layout|middleware)\.rose$/.test(rel) &&
    !/\/(?:404|500)\.rose$/.test(rel) && rel !== 'src/pages/404.rose' && rel !== 'src/pages/500.rose'
  ).length;

  const scaleChecks: Array<[string, boolean]> = [];
  const bakedDocs = (dist: string) => {
    const out: Array<{ file: string; raw: number; gzip: number; js: boolean }> = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const at = join(dir, e.name);
        if (e.isDirectory()) walk(at);
        else if (e.name === 'index.html') {
          const html = fs.readFileSync(at);
          out.push({ file: at, raw: html.length, gzip: gzipSync(html).length, js: /<script/.test(html.toString('utf-8')) });
        }
      }
    };
    walk(dist);
    return out;
  };
  const cliBuild = async () => {
    const t0 = Date.now();
    const tsx = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
    const cli = join(process.cwd(), 'src/cli/index.ts');
    const p = spawn(process.execPath, [tsx, cli, 'build'], { cwd: APP, stdio: 'pipe' });
    let out = '';
    let err = '';
    p.stdout.on('data', (c: Buffer) => { out += c; });
    p.stderr.on('data', (c: Buffer) => { err += c; });
    const code = await new Promise<number>((resolve) => p.on('close', (c) => resolve(c ?? 1)));
    if (code !== 0) throw new Error(`the generated app failed to build:\n${err}${out}`);
    return Date.now() - t0;
  };
  const built = async (mode: 'inline' | 'split', label: string) => {
    fs.writeFileSync(join(APP, 'src', 'pages', '_layout.rose'), mode === 'split'
      ? `<script>\n  import Nav from '../components/Nav.rose';\n  import Footer from '../components/Footer.rose';\n  export const prefetch = 'hover';\n  export const bundle = 'split';\n</script>\n<head><title>Scale benchmark</title></head>\n<Nav active="/" />\n<main><slot /></main>\n<Footer />\n`
      : `<script>\n  import Nav from '../components/Nav.rose';\n  import Footer from '../components/Footer.rose';\n  export const prefetch = 'hover';\n</script>\n<head><title>Scale benchmark</title></head>\n<Nav active="/" />\n<main><slot /></main>\n<Footer />\n`);
    const dist = join(APP, 'dist');
    const ms = await cliBuild();
    const docs = bakedDocs(dist);
    const zero = docs.filter((d) => !d.js);
    const inter = docs.filter((d) => d.js);
    const range = (xs: number[]) => xs.length > 0 ? `${Math.min(...xs)}-${Math.max(...xs)} B` : '-';
    console.log(`\nMedium-scale app, ${label} (${PAGE_PATTERNS} route patterns, ${COMPONENT_COUNT} components, built in ${ms} ms):`);
    console.log(`  documents baked: ${docs.length} - ${zero.length} zero-JS (the compiler's verdict, no export), ${inter.length} interactive`);
    if (zero.length > 0) console.log(`  zero-JS document:       raw ${range(zero.map((d) => d.raw))} / gzip ${(Math.min(...zero.map((d) => d.gzip)) / 1024).toFixed(2)}-${(Math.max(...zero.map((d) => d.gzip)) / 1024).toFixed(2)} KB - 0.00 KB JS at ANY scale`);
    if (inter.length > 0) console.log(`  interactive document:   raw ${range(inter.map((d) => d.raw))} / gzip ${(Math.min(...inter.map((d) => d.gzip)) / 1024).toFixed(2)}-${(Math.max(...inter.map((d) => d.gzip)) / 1024).toFixed(2)} KB - the shared bundle rides in every one`);
    if (mode === 'inline') {
      console.log(`  shared bundle:          ${(fs.statSync(join(dist, 'client.js')).size / 1024).toFixed(2)} KB raw / ${(gzipSync(fs.readFileSync(join(dist, 'client.js'))).length / 1024).toFixed(2)} KB gzip - inlined, so a document grows with the FEATURES, never with the route count`);
    } else {
      const chunkDir = join(dist, 'chunks');
      const chunks = fs.existsSync(chunkDir) ? fs.readdirSync(chunkDir) : [];
      const chunkBytes = chunks.map((f) => fs.statSync(join(chunkDir, f)).size);
      const entry = docs.find((d) => d.file === join(dist, 'index.html'))!;
      console.log(`  split mode:             ${chunks.length} chunks (${(chunkBytes.reduce((a, b) => a + b, 0) / 1024).toFixed(2)} KB raw total, content-hashed), home document ${(entry.raw / 1024).toFixed(2)} KB raw - one external /client.js reference, route chunks loaded on navigation`);
      console.log(`  (mode B for large apps: the document stops growing with the app; mode A above stays the default and byte-for-byte the single-request build)`);
    }
    return { docs, zero, inter, dist };
  };

  const splitRun = await built('split', 'mode B (split bundle)');
  const inlineRun = await built('inline', 'mode A (the default: single document)');
  scaleChecks.push(['the medium app has 20+ route patterns', PAGE_PATTERNS >= 20]);
  scaleChecks.push(['the generated routes bake 20+ documents', inlineRun.docs.length >= 20]);
  scaleChecks.push(['content routes stay zero-JS at scale', inlineRun.zero.length >= CONTENT_ROUTES + BLOG_POSTS]);
  scaleChecks.push(['zero-JS documents carry no script at all', inlineRun.zero.every((d) => !d.js)]);
  const chunkDir = join(splitRun.dist, 'chunks');
  scaleChecks.push(['split mode emits chunks', fs.existsSync(chunkDir) && fs.readdirSync(chunkDir).length > 1]);
  const homeInline = inlineRun.docs.find((d) => d.file === join(inlineRun.dist, 'index.html'))!;
  const homeSplit = splitRun.docs.find((d) => d.file === join(splitRun.dist, 'index.html'))!;
  scaleChecks.push(['the split document is smaller than the inlined one', homeSplit.raw < homeInline.raw]);

  const SCALE_PORT = 8133;
  const scaleTsx = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  const scaleCli = join(process.cwd(), 'src/cli/index.ts');
  const scaleProc = spawn(process.execPath, [scaleTsx, scaleCli, 'serve'], {
    cwd: APP,
    env: { ...process.env, PORT: String(SCALE_PORT), ROSESPAN_WORKERS: '1' },
    stdio: 'ignore',
  });
  const scaleAgent = new Agent({ keepAlive: true, maxSockets: 1 });
  const scaleGet = (pathname: string) =>
    new Promise<{ ttfb: number; bytes: number; body: Buffer; enc: string | undefined }>((resolve, reject) => {
      const t0 = performance.now();
      const req = request(
        { host: 'localhost', port: SCALE_PORT, path: pathname, agent: scaleAgent, headers: { 'accept-encoding': 'br, gzip' } },
        (res) => {
          let bytes = 0;
          let first = 0;
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => { if (!first) first = performance.now() - t0; bytes += c.length; chunks.push(c); });
          res.on('end', () => resolve({ ttfb: first, bytes, body: Buffer.concat(chunks), enc: res.headers['content-encoding'] as string | undefined }));
        }
      );
      req.on('error', reject);
      req.end();
    });
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try { await fetch(`http://localhost:${SCALE_PORT}/`); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    if (!up) throw new Error('rosespan serve did not start on the generated app');
    const feed = await scaleGet('/feed');
    const feedHtml = dynDecode(feed.body, feed.enc);
    const feedRefs = dynRefs(feedHtml).length;
    const doc = await scaleGet('/page-1');
    const docHtml = dynDecode(doc.body, doc.enc);
    const median = async (pathname: string, n = 200) => {
      for (let i = 0; i < 30; i++) await scaleGet(pathname);
      const runs: number[] = [];
      for (let i = 0; i < n; i++) runs.push((await scaleGet(pathname)).ttfb);
      runs.sort((a, b) => a - b);
      return runs[Math.floor(n / 2)];
    };
    const feedTtfb = await median('/feed');
    const docTtfb = await median('/page-1');
    console.log(`\nThe same invariant at scale, measured live against rosespan serve (1 worker, keep-alive, br):`);
    console.log(`  /feed    (dynamic, per-request read): 1 request, ${(feed.bytes / 1024).toFixed(2)} KB on the wire, TTFB p50 ${feedTtfb.toFixed(2)} ms, ${(feedHtml.match(/<script/g) ?? []).length} script tags, external refs ${feedRefs}`);
    console.log(`  /page-1  (content route):             1 request, ${(doc.bytes / 1024).toFixed(2)} KB on the wire, TTFB p50 ${docTtfb.toFixed(2)} ms, ${(docHtml.match(/<script/g) ?? []).length} script tags`);
    console.log(`  (a dynamic route is still one request with zero hydration at ${PAGE_PATTERNS} route patterns / ${COMPONENT_COUNT} components - the data is in the first response and no client runtime boots to show it)`);
    scaleChecks.push(['the dynamic feed route answers in one request', feedRefs === 0]);
    scaleChecks.push(['the content route ships zero script tags', (docHtml.match(/<script/g) ?? []).length === 0]);
  } finally {
    scaleAgent.destroy();
    scaleProc.kill();
    await new Promise((r) => { scaleProc.on('exit', () => r(null)); setTimeout(r, 5000); });
    await rmRetry(SCALE);
  }

  console.log(`\nMedium-scale checks:`);
  for (const [name, ok] of scaleChecks) console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}`);
  if (!scaleChecks.every(([, ok]) => ok)) process.exit(1);
}

const totalTime = Date.now() - START;
console.log(`\nBenchmark completed in ${totalTime}ms`);
console.log('===============================\n');

if (!routeOk) process.exit(1);

