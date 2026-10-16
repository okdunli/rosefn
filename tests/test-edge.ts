/**
 * rosespan edge adapter test - the Web-standard fetch handler on Node 22's
 * native Request/Response: same one-request guarantee, same zero-hydration
 * document, 404 status codes, and no Node built-ins in the server bundle.
 *
 * Run: npx tsx tests/test-edge.ts   (after npm run build)
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { createEdgeHandler } from '../src/cli/edge.js';

let checks = 0;
const assert = (cond: boolean, msg: string) => {
  checks++;
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
};

const handle = await createEdgeHandler('./dist');

const res = await handle(new Request('http://localhost/'));
assert(res.status === 200, 'GET / -> 200');
assert(res.headers.get('content-type') === 'text/html; charset=utf-8', 'content-type header set');
const html = await res.text();
assert(html.includes('<div id="app">'), 'document has app container');
assert(html.includes('__rosespan_state'), 'state serialized into document');
const externalRefs = [...html.matchAll(/<(?:script|link)[^>]*(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !u.startsWith('#') && !u.startsWith('data:'));
assert(externalRefs.length === 0, `zero external asset refs (one request) - got ${externalRefs.length}`);

const styleBlocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('');
assert(styleBlocks.includes('[data-rosespan-c="index"] .rcard'), 'the edge document inlines the scoped index rules');
assert(styleBlocks.includes('[data-rosespan-c="about"] .rcard'), 'the edge document inlines the scoped about rules');
assert(!/<link[^>]+stylesheet/i.test(html), 'the edge document requests zero stylesheets');
assert(html.includes('data-rosespan-c="index"'), 'the styled component root carries its scope attribute');

const about = await handle(new Request('http://localhost/about'));
assert(about.status === 200, 'GET /about -> 200');
const aboutHtml = await about.text();
const stateJson = aboutHtml.match(/<script type="application\/json" id="__rosespan_state">([\s\S]*?)<\/script>/)?.[1];
assert(!!stateJson, 'state script present in document');
const aboutState = JSON.parse(stateJson!);
assert(aboutState.title === 'About RoseSpan', '$data + $state serialized for /about');
assert(Array.isArray(aboutState.facts) && aboutState.facts.length === 4, 'server $data array serialized');

assert(aboutHtml.includes('data-on-click="reload"'), 'the about page serves the refresh button binding');
assert(/data fetches:/.test(aboutHtml), 'the about page renders the data-fetch counter');

const post = await handle(new Request('http://localhost/blog/42'));
assert(post.status === 200, 'GET /blog/42 -> 200');

const missing = await handle(new Request('http://localhost/nope'));
assert(missing.status === 404, 'unknown route -> 404 status');
assert((await missing.text()).includes('This rose has no petals here'), 'the 404 response is the custom page');

const signPost = await handle(new Request('http://localhost/sign', {
  method: 'POST',
  body: new URLSearchParams({ name: 'Edge Signer' }),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
}));
assert(signPost.status === 200, 'POST /sign -> 200');
const signHtml = await signPost.text();
assert(signHtml.includes('Edge Signer'), 'the edge POST response carries the new signature');
assert(signHtml.includes('Ada Lovelace'), 'the action keeps existing signatures');

const broken = await handle(new Request('http://localhost/broken'));
assert(broken.status === 500, 'a throwing route -> 500');
const brokenHtml = await broken.text();
assert(brokenHtml.includes('This rose pricked itself'), 'the 500 response is the custom error page');
const brokenState = brokenHtml.match(/<script type="application\/json" id="__rosespan_state">([\s\S]*?)<\/script>/)?.[1] ?? '';
assert(!brokenState.includes('data source is down'), 'the serialized state carries no server error text');

const streamed = await handle(new Request('http://localhost/admin', { headers: { cookie: 'session=Ada' } }));
assert(streamed.status === 200, 'streamed GET -> 200');
const reader = streamed.body!.getReader();
const decoder = new TextDecoder();
const firstRead = await reader.read();
const firstChunk = decoder.decode(firstRead.value);
assert(firstChunk.startsWith('<!DOCTYPE html>'), 'the first flushed chunk is the document shell');
assert(firstChunk.includes('<div id="app">'), 'the shell chunk opens the app container');
assert(!firstChunk.includes('Hello, Ada'), 'the shell flushed before the route rendered');
let streamRest = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  streamRest += decoder.decode(value, { stream: true });
}
const streamDoc = firstChunk + streamRest;
assert(streamDoc.includes('Hello, Ada'), 'the stream closes with the rendered route');
assert(streamDoc.includes('__rosespan_state'), 'the stream carries the state script');
assert(streamDoc.trimEnd().endsWith('</html>'), 'the streamed document is complete');
const streamState = JSON.parse(streamDoc.match(/id="__rosespan_state">([\s\S]*?)<\/script>/)![1]);
assert(streamState.__route === '/admin', 'the streamed state names the requested route');
const streamRefs = [...streamDoc.matchAll(/<(?:script|link|img)[^>]*(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !u.startsWith('#') && !u.startsWith('data:'));
assert(streamRefs.length === 0, `the streamed document needs zero extra requests (${streamRefs.length} refs)`);
const blog42 = await handle(new Request('http://localhost/blog/42'));
const blog42Html = await blog42.text();
assert(blog42.status === 200, 'GET /blog/42 -> 200 (buffered zero-JS)');
assert(blog42Html.includes('<title>Not found - RoseSpan blog</title>'), 'the buffered zero-JS document carries its full <head>');
assert(blog42Html.includes('Blog Post #'), 'the buffered zero-JS document carries the route content');
assert((blog42Html.match(/<script/g) || []).length === 0, 'the buffered zero-JS document contains zero script tags');

const likePost1 = await handle(new Request('http://localhost/', {
  method: 'POST',
  body: new URLSearchParams({ __action: 'like' }),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
}));
assert(likePost1.status === 200, 'POST __action=like -> 200');
const likeState1 = JSON.parse((await likePost1.text()).match(/id="__rosespan_state">([\s\S]*?)<\/script>/)![1]);
assert(likeState1.likes === 42, 'the edge POST ran the like action (41 -> 42)');
const likeForm = new FormData();
likeForm.append('__action', 'like');
const likePost2 = await handle(new Request('http://localhost/', { method: 'POST', body: likeForm }));
assert(likePost2.status === 200, 'multipart POST __action=like -> 200');
const likeState2 = JSON.parse((await likePost2.text()).match(/id="__rosespan_state">([\s\S]*?)<\/script>/)![1]);
assert(likeState2.likes === 43, 'the multipart POST ran the same action (42 -> 43)');

const serverSrc = readFileSync('dist/server.js', 'utf-8');
assert(!/require\(|from ['"]node:|from ['"]fs['"]/.test(serverSrc), 'server bundle has zero Node built-in imports');

const apiGet = await handle(new Request('http://localhost/api/hello'));
assert(apiGet.status === 200, 'GET /api/hello -> 200 at the edge');
assert(apiGet.headers.get('content-type') === 'application/json', 'the edge api response is application/json');
assert(JSON.parse(await apiGet.text()).hello === 'RoseSpan', 'the edge api GET body is the handler object');
const apiForm = new FormData();
apiForm.append('name', 'ada');
const apiPost = await handle(new Request('http://localhost/api/hello', { method: 'POST', body: apiForm }));
assert(apiPost.status === 200, 'POST /api/hello -> 200 at the edge');
assert(JSON.parse(await apiPost.text()).hello === 'ada', 'the edge api POST handler reads the FormData');
const apiPut = await handle(new Request('http://localhost/api/hello', { method: 'PUT' }));
assert(apiPut.status === 405, 'PUT /api/hello -> 405 at the edge');
assert(apiPut.headers.get('allow') === 'GET, POST', 'the edge api 405 carries the Allow header');
const apiMissing = await handle(new Request('http://localhost/api/nope'));
assert(apiMissing.status === 404, 'unknown api route -> 404 at the edge');
assert((await apiMissing.text()).includes('not found'), 'the edge api 404 is JSON');

const walled = await handle(new Request('http://localhost/admin'));
assert(walled.status === 302, `the middleware walls /admin with a 302 at the edge (got ${walled.status})`);
assert(walled.headers.get('location') === '/sign', 'the edge redirect names its target');
const allowed = await handle(new Request('http://localhost/admin', { headers: { cookie: 'session=rose' } }));
assert(allowed.status === 200, 'a session passes the wall at the edge');
assert((await allowed.text()).includes('Hello, rose'), 'the gated page greets the session user at the edge');
const secretDenied = await handle(new Request('http://localhost/api/secret'));
assert(secretDenied.status === 401, 'the guarded api answers 401 at the edge');
const secretOk = await handle(new Request('http://localhost/api/secret', { headers: { cookie: 'session=rose' } }));
assert(secretOk.status === 200 && JSON.parse(await secretOk.text()).for === 'rose', 'the guarded api serves the session user at the edge');
const homeEdge = await handle(new Request('http://localhost/'));
assert(homeEdge.status === 200 && (await homeEdge.text()).includes('Welcome to'), 'normal routes are unaffected at the edge');

const vaultWalled = await handle(new Request('http://localhost/vault'));
assert(vaultWalled.status === 302, `the middleware walls /vault with a 302 at the edge (got ${vaultWalled.status})`);
const vaultOk = await handle(new Request('http://localhost/vault', { headers: { cookie: 'session=rose' } }));
assert(vaultOk.status === 200 && (await vaultOk.text()).includes('The Vault'), 'a session passes the plain wall at the edge');
const edgeMod = await import('./dist/server.js');
assert(Array.isArray((edgeMod as any).revalidate), 'the revalidate windows ship in the server bundle (the edge adapter renders live and ignores them)');

const garden = await handle(new Request('http://localhost/garden'));
assert(garden.status === 200, 'GET /garden -> 200 at the edge');
const gardenDoc = await garden.text();
assert(gardenDoc.includes('The Garden') && gardenDoc.includes('in full bloom'), 'the no-JS route renders its content at the edge');
assert(!gardenDoc.includes('__rosespan_state'), 'the edge no-JS document has no state script');
assert(!gardenDoc.includes('__rosespan_handlers'), 'the edge no-JS document has no client bundle');
assert((gardenDoc.match(/<script/g) || []).length === 0, 'the edge no-JS document contains zero script tags');
assert(gardenDoc.includes('<title>The Garden - RoseSpan</title>'), 'the edge no-JS document keeps the route <title> (rendered live, buffered, complete head)');
assert(Array.isArray((edgeMod as any).noJsRoutes) && (edgeMod as any).noJsRoutes.includes('/garden'), 'the no-JS route list ships in the server bundle');
assert((edgeMod as any).noJsRoutes.includes('/blog/:id'), 'content routes are auto zero-JS with no export at all');
assert((edgeMod as any).isNoJs('/garden') === true && (edgeMod as any).isNoJs('/blog/42') === true, 'isNoJs() matches the opted-out and the auto-detected routes');
assert((edgeMod as any).isNoJs('/') === false && (edgeMod as any).isNoJs('/about') === false && (edgeMod as any).isNoJs('/sign') === false, 'isNoJs() leaves interactive routes (events, lifecycle, forms) alone');

const homeH = await handle(new Request('http://localhost/'));
const homeHtmlH = await homeH.text();
const homeCspH = homeH.headers.get('content-security-policy')!;
assert(homeCspH.includes('script-src \'sha256-') && homeCspH.includes("object-src 'none'"), 'every edge document carries the strict CSP');
const edgeBlocks = [...homeHtmlH.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const edgeHash = createHash('sha256').update(edgeBlocks[edgeBlocks.length - 1], 'utf-8').digest('base64');
assert(homeCspH.includes(`'sha256-${edgeHash}'`), 'the edge CSP hashes the exact inline script bytes it served');
const thorn = await handle(new Request('http://localhost/thorn'));
assert(thorn.headers.get('content-security-policy') === "default-src 'none'; style-src 'unsafe-inline'; img-src data:", 'the thorn route replaces the CSP at the edge');
assert(thorn.headers.get('x-robots-tag') === 'noindex', 'the thorn route adds its plain header at the edge');

const edgeSignA = await handle(new Request('http://localhost/sign'));
const edgeSignAHtml = await edgeSignA.text();
const edgeCspA = edgeSignA.headers.get('content-security-policy')!;
const edgeNonceA = /'nonce-([^']+)'/.exec(edgeCspA)?.[1];
assert(!!edgeNonceA, 'the edge nonce route answers a nonce policy');
assert(edgeCspA.includes("'strict-dynamic'") && !edgeCspA.includes('sha256'), 'the edge nonce policy is nonce + strict-dynamic, no hash');
assert(edgeSignAHtml.match(/<script type="module"([^>]*)>/)![1].includes(`nonce="${edgeNonceA}"`), 'the edge document tag carries the header nonce');
assert(edgeSignAHtml.includes('<script type="application/json" id="__rosespan_state">'), 'the edge state script stays untagged');
const edgeSignB = await handle(new Request('http://localhost/sign'));
const edgeNonceB = /'nonce-([^']+)'/.exec(edgeSignB.headers.get('content-security-policy')!)![1];
assert(edgeNonceB !== edgeNonceA, 'every edge response mints a fresh nonce');
const edgeSignPost = await handle(new Request('http://localhost/sign', {
  method: 'POST',
  body: new URLSearchParams({ name: 'Edge Nonce' }),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
}));
const edgePostHtml = await edgeSignPost.text();
const edgePostNonce = /'nonce-([^']+)'/.exec(edgeSignPost.headers.get('content-security-policy')!)![1];
assert(edgePostNonce !== edgeNonceA && edgePostNonce !== edgeNonceB, 'the edge action response mints its own nonce');
assert(edgePostHtml.includes(`nonce="${edgePostNonce}"`), 'the edge action response tag carries that nonce');
assert(edgePostHtml.includes('Edge Nonce') || edgePostHtml.includes('guestbook is full'), 'the edge action still ran under the nonce policy');
const edgeHome2 = await handle(new Request('http://localhost/'));
assert((edgeHome2.headers.get('content-security-policy') || '').includes("'sha256-"), 'a hashed route keeps its hash at the edge');
assert((edgeMod as any).cspNonceRoutes.join(',') === '/sign', 'the compiler reports the nonce routes');
assert((edgeMod as any).dynamicRoutes.includes('/sign'), 'a nonce route is dynamic by construction (never baked)');

assert((edgeMod as any).localeList().slice().sort().join(',') === 'ar,en,zh', 'the locales ship in the server bundle');
const edgeEn = await handle(new Request('http://localhost/en/about'));
assert(edgeEn.status === 200 && (await edgeEn.text()).includes('This page speaks your language'), 'the edge renders the en dictionary');
const edgeZh = await handle(new Request('http://localhost/zh/about'));
assert(edgeZh.status === 200 && (await edgeZh.text()).includes('这一页说你的语言'), 'the edge renders the zh dictionary');
const edgeAr = await handle(new Request('http://localhost/ar/about'));
const edgeArDoc = await edgeAr.text();
const edgeArHtmlTag = /<html[^>]*>/.exec(edgeArDoc)?.[0] ?? '';
assert(edgeAr.status === 200 && edgeArHtmlTag.includes('lang="ar"') && edgeArHtmlTag.includes('dir="rtl"'), `the edge renders the packed locale with dir="rtl" (got ${edgeArHtmlTag})`);
assert(edgeArDoc.includes('لا توقيعات بعد في سجل الزوار'), 'the edge expands the Arabic =0 arm');
const edgeEnTag = /<html[^>]*>/.exec(await (await handle(new Request('http://localhost/en/about'))).text())?.[0] ?? '';
assert(edgeEnTag.includes('lang="en"') && !edgeEnTag.includes('dir='), 'an ltr locale carries no dir attribute (ltr is the html default)');
const edgeFr = await handle(new Request('http://localhost/fr/about'));
assert(edgeFr.status === 404, 'an unknown locale answers 404 at the edge');
const edgeNeg = await handle(new Request('http://localhost/about', { headers: { 'accept-language': 'zh' } }));
assert(edgeNeg.status === 302 && edgeNeg.headers.get('location') === '/zh/about', 'the edge middleware negotiates Accept-Language');

const likeStateNow = async () => JSON.parse((await (await handle(new Request('http://localhost/'))).text()).match(/id="__rosespan_state">([\s\S]*?)<\/script>/)![1]).likes as number;
const forged = await handle(new Request('http://localhost/sign', {
  method: 'POST',
  body: new URLSearchParams({ name: 'Forced' }),
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://evil.example' },
}));
assert(forged.status === 403, 'a cross-origin POST is refused with 403');
assert((await forged.text()).includes('Origin does not match Host'), 'the refusal names the reason');
const unparsable = await handle(new Request('http://localhost/sign', {
  method: 'POST',
  body: new URLSearchParams({ name: 'Forced' }),
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'not a url' },
}));
assert(unparsable.status === 403 && (await unparsable.text()).includes('unparsable Origin'), 'an unparsable Origin header is refused, not ignored');
const secFetch = await handle(new Request('http://localhost/sign', {
  method: 'POST',
  body: new URLSearchParams({ name: 'Forced' }),
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' },
}));
assert(secFetch.status === 403 && (await secFetch.text()).includes('sec-fetch-site'), 'a cross-site Sec-Fetch-Site is refused when no Origin is sent');
const forgedGet = await handle(new Request('http://localhost/', { headers: { origin: 'http://evil.example' } }));
assert(forgedGet.status === 200, 'a cross-origin GET is a normal read (CSRF is about writes)');
for (const m of ['PUT', 'PATCH', 'DELETE']) {
  const forgedWrite = await handle(new Request('http://localhost/sign', { method: m, headers: { origin: 'http://evil.example' } }));
  assert(forgedWrite.status === 403, `a cross-origin ${m} is refused too`);
}
const likePass = async (headers: Record<string, string>, msg: string) => {
  const before = await likeStateNow();
  const r = await handle(new Request('http://localhost/', {
    method: 'POST',
    body: new URLSearchParams({ __action: 'like' }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  }));
  const after = JSON.parse((await r.text()).match(/id="__rosespan_state">([\s\S]*?)<\/script>/)![1]).likes as number;
  assert(r.status === 200 && after === before + 1, msg);
};
await likePass({ origin: 'http://localhost' }, "a same-origin POST (the browser's own origin) runs the action");
await likePass({ 'sec-fetch-site': 'same-origin' }, 'a same-origin Sec-Fetch-Site passes');
await likePass({}, 'a POST with neither Origin nor Sec-Fetch-Site passes (not CSRF-attackable)');

console.log(`\nAll edge adapter checks passed - Web-standard handler, one request, zero hydration - ${checks} assertions.`);
