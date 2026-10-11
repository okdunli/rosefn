/**
 * rosefn Go single-binary server test.
 *
 * Builds the Go binary (which embeds dist/), runs it, and verifies:
 *   1. prerendered static routes serve the self-contained one-request document
 *   2. compression on demand: gzip, and build-precompressed brotli
 *      (dist/<file>.br) which wins on the wire, with weak ETags answering
 *      bodiless 304s on repeat visits
 *   3. prerendered dynamic routes (export const params) are served directly
 *      as static pages with $data resolved at build time
 *   4. dynamic routes outside params (/blog/3) work through the SPA fallback:
 *      the served index.html is client-rendered for the requested route in a
 *      real DOM
 *   5. unknown routes render the client-side 404 page the same way
 * 6. ops: the Prometheus /metrics endpoint, the stdout
 *      access log, the stderr error trail, and the UPSTREAM hybrid deploy -
 *      POSTs and unbaked /api routes proxy to the Node backend while every
 *      static answer stays local
 *
 * Run: node tests/test-go.mjs   (needs `go` on PATH; run `npm run build` first)
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { brotliCompressSync } from 'node:zlib';
import { JSDOM } from 'jsdom';

const freePort = async (from, to) => {
  const { createServer } = await import('node:net');
  for (let p = from; p <= to; p++) {
    const free = await new Promise((resolve) => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.listen(p, () => srv.close(() => resolve(true)));
    });
    if (free) return p;
  }
  throw new Error(`no free port in ${from}-${to}`);
};
const PORT = await freePort(8123, 8132);
const BASE = `http://localhost:${PORT}`;

let checks = 0;
const assert = (cond, msg) => {
  checks++;
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
};

const binName = process.platform === 'win32' ? 'rosefn-server-go.exe' : 'rosefn-server-go';
execSync(`go build -o ${binName} .`, { stdio: 'inherit' });
assert(true, 'go build produced a single binary');

{
  const { readdirSync } = await import('node:fs');
  const deploy = readdirSync('dist', { withFileTypes: true }).map((e) => e.name);
  const intermediates = deploy.filter((f) => /^(?:comp-\d+\.(?:ssr|client)|runtime|(?:server|client)-entry)\.js$/.test(f));
  assert(intermediates.length === 0, `deploy dir has no build intermediates (found: ${intermediates.join(', ') || 'none'})`);
  assert(deploy.includes('client.js') && deploy.includes('server.js'), 'deploy dir has the two self-contained bundles');
}

const bin = join(process.cwd(), binName);
const server = spawn(bin, [], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore'
});
try {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE + '/');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const home = await fetch(BASE + '/');
  assert(home.status === 200, 'GET / -> 200');
  assert(home.headers.get('content-type') === 'text/html; charset=utf-8', 'html content-type set');
  const homeHtml = await home.text();
  const stripMarkers = (h) => h.replace(/<!--\u27e6[^>]*-->/g, '');
  assert(stripMarkers(homeHtml).includes('Welcome to Rosefn'), 'prerendered home content served');
  const refs = [...homeHtml.matchAll(/<(?:script|link|img)[^>]*(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !u.startsWith('#') && !u.startsWith('data:'));
  assert(refs.length === 0, 'zero external refs (one request)');

  const rawGet = (pathname, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = request({ host: 'localhost', port: PORT, path: pathname, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });

  const rawRes = await rawGet('/');
  const gzRes = await rawGet('/', { 'accept-encoding': 'gzip' });
  assert(gzRes.headers['content-encoding'] === 'gzip', 'gzip applied when accepted');
  assert(gzRes.body.length < rawRes.body.length, `gzip smaller than raw (${gzRes.body.length} < ${rawRes.body.length} bytes)`);
  assert(gzRes.body.length < 12850, `gzip document under 12.8 KB on the wire (${gzRes.body.length} bytes)`);

  const about = await fetch(BASE + '/about');
  const aboutHtml = await about.text();
  assert(aboutHtml.includes('About Rosefn'), 'prerendered /about served');

  for (const [id, title] of [['1', 'Hello Rosefn'], ['2', 'Zero-hydration magic']]) {
    const res = await fetch(BASE + `/blog/${id}`);
    const html = await res.text();
    assert(res.status === 200, `GET /blog/${id} -> 200`);
    assert(stripMarkers(html).includes(`Blog Post #${id}`), `prerendered /blog/${id} content in raw HTML (no client work)`);
    assert(stripMarkers(html).includes(title), `prerendered /blog/${id} $data resolved at build time`);
 assert((html.match(/<script/g) || []).length === 0, `the content-route document ships zero script tags (auto zero-JS)`);
    assert(html.length < 6000, `the content-route document is tiny (${html.length} bytes raw, no inlined bundle)`);
  }

  async function spaRender(pathname) {
    const res = await fetch(BASE + pathname);
    const html = await res.text();
    let classic = html.replace('<script type="module">', '<script>');
    const exp = classic.match(/\bexport\{([^}]*)\};?/);
    if (exp) {
      const decls = exp[1].split(',').map((s) => {
        const [orig, alias] = s.split(/\s+as\s+/);
        return `${alias || orig}=${orig}`;
      }).join(',');
      classic = classic.replace(exp[0], `const ${decls};`);
    }
    const dom = new JSDOM(classic, { runScripts: 'dangerously', url: BASE + pathname, pretendToBeVisual: true });
    await new Promise((r) => setTimeout(r, 30));
    return dom.window.document;
  }

  const blog3 = await spaRender('/blog/3');
  assert(blog3.body.textContent.includes('Blog Post #3'), 'unlisted /blog/3 client-rendered via SPA fallback');
  assert(blog3.body.textContent.includes('Not found'), '$data falls back to the not-found post on the client');
  assert(!blog3.body.textContent.includes('Welcome to Rosefn'), 'mismatched SSR DOM replaced, not adopted');

  const missingDoc = await spaRender('/nope');
  assert(missingDoc.body.textContent.includes('404'), 'unknown route renders the client-side 404 page');

  const adminDoc = await spaRender('/admin');
  assert(adminDoc.body.textContent.includes('Please sign in'), 'the walled route client-renders only its public shell on the binary');
  const adminText = [...adminDoc.querySelectorAll('p')].map((p) => p.textContent).join('|');
  assert(!adminText.includes('Hello,'), 'no gated content leaks into the static deploy');

  const vaultDoc = await spaRender('/vault');
  assert(vaultDoc.body.textContent.includes('The Vault'), 'the plain-walled route SPA-falls-back on the binary (a wall needs a server)');

  assert(!existsSync(join('dist', 'sign', 'index.html')), 'the nonce route is never baked into the deploy dir');
  const signFallback = await spaRender('/sign');
  assert(signFallback.body.textContent.includes('Signatures'), 'the nonce route client-renders on the binary (a nonce needs a server)');
  const signFallbackRes = await fetch(BASE + '/sign');
  const signFallbackCsp = signFallbackRes.headers.get('content-security-policy') || '';
  assert(signFallbackCsp.includes("script-src 'sha256-") && !signFallbackCsp.includes("'nonce-"), 'the fallback response keeps the hashed policy - no nonce is invented here');

  const freshRes = await fetch(BASE + '/fresh');
  assert(freshRes.status === 200, 'GET /fresh -> 200 from the binary');
  assert(/render #\d+/.test(await freshRes.text()), 'the baked ISR document is served with its render stamp');

  const api = await fetch(BASE + '/api/hello');
  assert(api.status === 200, 'GET /api/hello -> 200 from the binary');
  assert(api.headers.get('content-type') === 'application/json; charset=utf-8', 'the baked api body is served as json');
  const apiJson = await api.json();
  assert(apiJson.hello === 'Rosefn', 'the baked api body is the build-time GET response');
  const apiMissing = await fetch(BASE + '/api/nope');
  assert(apiMissing.status === 404, 'unbaked api route -> 404 from the binary');
  assert(apiMissing.headers.get('content-type') === 'application/json; charset=utf-8', 'the api 404 is json, not the html shell');
  assert(JSON.parse(await apiMissing.text()).error.includes('not baked'), 'the api 404 body explains the boundary');
  const apiPost = await fetch(BASE + '/api/hello', { method: 'POST' });
  assert(apiPost.status === 405, 'POST /api/hello -> 405 (the binary serves static content only)');

  const gardenRes = await fetch(BASE + '/garden');
  assert(gardenRes.status === 200, 'GET /garden -> 200 from the binary');
  const garden = await gardenRes.text();
  assert(garden.includes('The Garden') && garden.includes('in full bloom'), 'the no-JS route serves its content from the binary');
  assert(!garden.includes('__rosefn_state'), 'the binary-served no-JS document has no state script');
  assert(!garden.includes('__rosefn_handlers'), 'the binary-served no-JS document has no client bundle');
  assert((garden.match(/<script/g) || []).length === 0, 'the binary-served no-JS document contains zero script tags');
  assert(garden.length < 6000, `the no-JS baked document is tiny (${garden.length} bytes raw)`);
  const fallbackDoc = await (await fetch(BASE + '/')).text();
  const fallbackDom = new JSDOM(fallbackDoc, { runScripts: 'dangerously', url: BASE + '/garden', pretendToBeVisual: true });
  await new Promise((r) => setTimeout(r, 30));
  assert(fallbackDom.window.document.body.textContent.includes('The Garden'), 'the SPA fallback bundle can still render the no-JS route');
  assert(garden.includes('\u{1F339}'), 'the binary serves the plugin-transformed document');
  const bundle = await (await fetch(BASE + '/client.js')).text();
  assert(bundle.includes('setPrefetchMode') && bundle.includes('prefetchStats'), 'the binary serves the prefetch guards in the client bundle');
  const nestedIcon = await fetch(BASE + '/public/icons/rose.svg');
  assert(nestedIcon.status === 200, 'the binary serves a nested public/ asset (/public/icons/rose.svg)');
  assert(nestedIcon.headers.get('content-type') === 'image/svg+xml', 'the nested asset carries its mime type');
  assert((await nestedIcon.text()).includes('🌹'), 'the nested asset keeps its bytes');
  const flatLogo = await fetch(BASE + '/public/logo.svg');
  assert(flatLogo.status === 200, 'the flat public/ asset still serves beside the nested one');

  for (const p of ['/blog/1', '/blog/2', '/fresh', '/en/about', '/zh/about', '/ar/about']) {
    const doc = await (await fetch(BASE + p)).text();
    assert((doc.match(/<script/g) || []).length === 0, `${p} is an auto zero-JS document (zero script tags)`);
    assert(doc.length < 6000, `${p} is tiny (${doc.length} bytes raw, no inlined bundle)`);
  }
  const arDoc = await (await fetch(BASE + '/ar/about')).text();
  assert(arDoc.includes('<html lang="ar" dir="rtl">'), 'the binary serves the Arabic document right-to-left');
  assert(arDoc.includes('لا توقيعات بعد') && arDoc.includes('توقيع واحد'), 'the binary serves the Arabic plural arms');
  const arPack = await fetch(BASE + '/locales/ar.json');
  assert(arPack.status === 200, 'GET /locales/ar.json -> 200 from the binary');
  assert((arPack.headers.get('content-type') || '').includes('json'), 'the pack is served as json');
  assert((await arPack.text()).includes('about.plural'), 'the pack file carries the Arabic dictionary');
  for (const p of ['/', '/about']) {
    const doc = await (await fetch(BASE + p)).text();
    assert(doc.includes('__rosefn_state') && doc.includes('__rosefn_handlers'), `${p} is baked with the state script and the bundle`);
  }
  const signOnBinary = await (await fetch(BASE + '/sign')).text();
  const homeOnBinary = await (await fetch(BASE + '/')).text();
  assert(signOnBinary === homeOnBinary, '/sign is a $store route: the binary answers it with the SPA shell (client-rendered), not a baked document');
  const signDom = new JSDOM(signOnBinary, { runScripts: 'dangerously', url: BASE + '/sign', pretendToBeVisual: true });
  await new Promise((r) => setTimeout(r, 30));
  assert(signDom.window.document.body.textContent.includes('Guestbook'), 'the SPA shell client-renders the $store sign route');

  const goHome = await fetch(BASE + '/');
  const goHomeCsp = goHome.headers.get('content-security-policy');
  assert(goHomeCsp && goHomeCsp.includes('script-src \'sha256-'), 'the binary serves the strict CSP on every html document');
  const goHomeHtml = await goHome.text();
  const goBlocks = [...goHomeHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const goHash = createHash('sha256').update(goBlocks[goBlocks.length - 1], 'utf-8').digest('base64');
  assert(goHomeCsp.includes(`'sha256-${goHash}'`), 'the binary-served CSP hashes the exact inline bytes it serves');
  const goThorn = await fetch(BASE + '/thorn');
  assert(goThorn.headers.get('content-security-policy') === "default-src 'none'; style-src 'unsafe-inline'; img-src data:", 'the thorn route replaces the CSP on the binary');
  assert(goThorn.headers.get('x-robots-tag') === 'noindex', 'the thorn route adds its plain header on the binary');
  const goAsset = await fetch(BASE + '/client.js');
  assert(!goAsset.headers.get('content-security-policy'), 'assets carry no page CSP on the binary');

  const goEn = await fetch(BASE + '/en/about');
  assert(goEn.status === 200 && (await goEn.text()).includes('This page speaks your language'), 'the binary serves the baked en document');
  const goZh = await fetch(BASE + '/zh/about');
  assert(goZh.status === 200 && (await goZh.text()).includes('这一页说你的语言'), 'the binary serves the baked zh document');
  const goEnDoc = await (await fetch(BASE + '/en/about')).text();
  const goZhDoc = await (await fetch(BASE + '/zh/about')).text();
  assert((goEnDoc.match(/<script/g) || []).length === 0, 'the baked en document is auto zero-JS');
  assert((goZhDoc.match(/<script/g) || []).length === 0, 'the baked zh document is auto zero-JS');
  const goFrDom = new JSDOM(await (await fetch(BASE + '/fr/about')).text(), { runScripts: 'dangerously', url: BASE + '/fr/about', pretendToBeVisual: true });
  await new Promise((r) => setTimeout(r, 30));
  assert(goFrDom.window.document.body.textContent.includes('This rose has no petals here'), 'an unknown locale falls back to the bundle, which paints the 404 page');

  const brRes = await rawGet('/', { 'accept-encoding': 'br' });
  assert(brRes.headers['content-encoding'] === 'br', 'brotli served when accepted (precompressed at build time)');
  assert(brRes.body.length < gzRes.body.length, `brotli beats gzip on the wire (${brRes.body.length} < ${gzRes.body.length} bytes)`);
  assert(brRes.body.equals(brotliCompressSync(rawRes.body)), 'the served bytes are the exact build-time brotli of the document');
  const brPref = await rawGet('/zh/about', { 'accept-encoding': 'br, gzip' });
  assert(brPref.headers['content-encoding'] === 'br', 'a br+gzip client (every browser) gets brotli, not gzip');
  const etag = rawRes.headers['etag'];
  assert(etag && etag.startsWith('W/'), `documents carry a weak ETag (${etag})`);
  const cond = await rawGet('/', { 'accept-encoding': 'br', 'if-none-match': etag });
  assert(cond.status === 304, 'a repeat visit with a matching ETag answers 304');
  assert(cond.body.length === 0, `the 304 carries zero body bytes (${cond.body.length})`);
  const condStale = await rawGet('/', { 'accept-encoding': 'br', 'if-none-match': 'W/"0-0"' });
  assert(condStale.status === 200 && condStale.body.length > 0, 'a stale ETag re-transfers the document');
  const brDirect = await rawGet('/index.html.br');
  assert(brDirect.headers['content-encoding'] !== 'br', 'a direct request for a .br sibling is not served as brotli');
  assert(stripMarkers(brDirect.body.toString()).includes('Welcome to Rosefn'), 'a direct request for a .br sibling answers the real page');

  const metrics = await fetch(BASE + '/metrics');
  assert(metrics.status === 200, 'GET /metrics -> 200');
  assert(metrics.headers.get('content-type') === 'text/plain; version=0.0.4; charset=utf-8', '/metrics answers the Prometheus text format');
  const metricAt = async () => Object.fromEntries(
    [...(await (await fetch(BASE + '/metrics')).text()).matchAll(/^(rosefn_\w+)(?:\{code="(\d+)"\})? ([\d.]+)$/gm)]
      .map((m) => [m[2] ? `${m[1]}{${m[2]}}` : m[1], Number(m[3])]));
  const m1 = await metricAt();
  assert('rosefn_uptime_seconds' in m1 && m1.rosefn_uptime_seconds >= 0, 'the scrape carries uptime');
  assert('rosefn_http_request_duration_seconds_sum' in m1 && 'rosefn_http_request_duration_seconds_count' in m1, 'the scrape carries a duration sum/count pair');
  assert(m1['rosefn_http_requests_in_flight'] >= 1 && m1['rosefn_http_requests_in_flight'] <= 2, 'the in-flight gauge counts the scrape itself and nothing more');
  assert((m1['rosefn_http_requests_total{200}'] ?? 0) > 0, 'the counter saw the 200s this suite already made');
  for (let i = 0; i < 3; i++) await fetch(BASE + '/');
  const m2 = await metricAt();
  assert(m2['rosefn_http_requests_total{200}'] >= m1['rosefn_http_requests_total{200}'] + 3, 'the 200 counter advances with real traffic');
  assert(m2['rosefn_http_request_duration_seconds_count'] > m1['rosefn_http_request_duration_seconds_count'], 'the request count advances with real traffic');
  const condRes = await rawGet('/', { 'accept-encoding': 'br', 'if-none-match': etag });
  assert(condRes.status === 304, 'the conditional request still answers 304');
  const m3 = await metricAt();
  assert((m3['rosefn_http_requests_total{304}'] ?? 0) >= 1, 'the 304 is counted under its own status code');
  const m4 = await metricAt();
  assert(m4['rosefn_http_request_duration_seconds_count'] > m3['rosefn_http_request_duration_seconds_count'], '/metrics counts itself like any other request');

  const deadPort = await freePort(8153, 8162);
  const logPort = await freePort(8133, 8142);
  const out = [];
  const errs = [];
  const logBin = spawn(bin, [], {
    env: { ...process.env, PORT: String(logPort), UPSTREAM: `http://localhost:${logPort}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  logBin.stdout.on('data', (c) => out.push(c));
  logBin.stderr.on('data', (c) => errs.push(c));
  const logBase = `http://localhost:${logPort}`;
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(logBase + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    await fetch(logBase + '/');
    const deadPost = await fetch(logBase + '/api/like', { method: 'POST' });
    assert(deadPost.status === 502, 'a POST with a dead upstream answers 502 (not a hang, not a 405)');
    await new Promise((r) => setTimeout(r, 150));
    const lines = Buffer.concat(out).toString().split('\n').filter(Boolean);
    const getLine = lines.find((l) => l.includes(' GET / 200 '));
    assert(!!getLine, `the access log has a line for the GET (${lines.length} lines captured)`);
    assert(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z GET \/ 200 \d+B \d+(\.\d+)?(ns|µs|ms|s)$/.test(getLine), `the access line is one greppable record: ${getLine}`);
    const postLine = lines.find((l) => l.includes(' POST /api/like 502 '));
    assert(!!postLine && postLine.endsWith('via=upstream'), `a proxied request is marked in the access log: ${postLine}`);
    const errText = Buffer.concat(errs).toString();
    assert(errText.includes('Rosefn error: upstream') && errText.includes('POST /api/like'), 'the dead upstream is named in the error log on stderr');
  } finally {
    logBin.kill();
  }

  const { createServer } = await import('node:http');
  const dyn = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ upstream: true, method: req.method, url: req.url, bytes: chunks.join('').length }));
    });
  });
  await new Promise((r) => dyn.listen(0, '127.0.0.1', r));
  const dynPort = dyn.address().port;
  const hybPort = await freePort(8143, 8152);
  const hybBin = spawn(bin, [], {
    env: { ...process.env, PORT: String(hybPort), UPSTREAM: `http://localhost:${hybPort}` },
    stdio: 'ignore'
  });
  const hybBase = `http://localhost:${hybPort}`;
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(hybBase + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const likePost = await (await fetch(hybBase + '/api/like', { method: 'POST' })).json();
    assert(likePost.upstream === true && likePost.method === 'POST', 'a server-action POST is proxied to the Node backend');
    const signPost = await (await fetch(hybBase + '/sign', { method: 'POST' })).json();
    assert(signPost.upstream === true && signPost.method === 'POST', 'a page form POST is proxied to the Node backend');
    const apiLive = await (await fetch(hybBase + '/api/nope')).json();
    assert(apiLive.upstream === true, 'an unbaked /api route is proxied to the live handler');
    const apiBaked = await (await fetch(hybBase + '/api/hello')).json();
    assert(apiBaked.hello === 'Rosefn' && apiBaked.upstream === undefined, 'a baked api body still answers locally (the proxy never shadows the build)');
    const hybHome = await (await fetch(hybBase + '/')).text();
    assert(stripMarkers(hybHome).includes('Welcome to Rosefn') && !hybHome.includes('"upstream":true'), 'the static document is still served locally in hybrid mode');
    const hybBlog = await (await fetch(hybBase + '/blog/1')).text();
    assert(stripMarkers(hybBlog).includes('Blog Post #1'), 'a prerendered content route is still served locally in hybrid mode');
    const hybSpa = await fetch(hybBase + '/blog/3');
    assert(hybSpa.status === 200 && stripMarkers(await hybSpa.text()).includes('Welcome to Rosefn'), 'the SPA fallback is still served locally in hybrid mode');
  } finally {
    hybBin.kill();
    dyn.close();
  }

  console.log(`\nAll Go single-binary server checks passed - one binary, one request, static pages for params routes, SPA fallback for the rest, ops and hybrid deploy verified - ${checks} assertions.`);
} finally {
  server.kill();
}
