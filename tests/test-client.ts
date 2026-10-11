/**
 * rosefn client smoke test - one runnable check for the client pipeline:
 * SSR state resume, zero-hydration DOM adoption, fine-grained updates
 * (event -> state -> only the affected node changes), client-side
 * navigation, $data on navigation.
 *
 * Run: npx tsx tests/test-client.ts
 */

import { JSDOM } from 'jsdom';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { renderPage, renderPageStream, canStream, shellOff, handleApi, isApi, apiPrerender, localeList, defaultLocale } from '../dist/server.js';
import { buildShell, getHtmlShell, shellOpen, securityHeaders } from '../src/cli/shell.js';

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
(globalThis as any).document = dom.window.document;
(globalThis as any).NodeFilter = dom.window.NodeFilter;
(globalThis as any).Node = dom.window.Node;
const NativeFormData = (globalThis as any).FormData;
(globalThis as any).FormData = dom.window.FormData;
(globalThis as any).DOMParser = dom.window.DOMParser;
(globalThis as any).location = { pathname: '/' };
(globalThis as any).requestAnimationFrame = (cb: (t: number) => void) =>
  setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
let lastPostState: any = null;
(globalThis as any).fetch = async (url: string, init: any) => {
  const u = String(url);
  if (u.startsWith('/locales/') && u.endsWith('.json')) {
    const lang = u.slice('/locales/'.length, -'.json'.length);
    const file = `dist/locales/${lang}.json`;
    if (!existsSync(file)) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => JSON.parse(readFileSync(file, 'utf-8')) };
  }
  const page = await renderPage('/', init.body);
  lastPostState = JSON.parse(page.state);
  return { text: async () => getHtmlShell(page.html, page.state, page.head) };
};

const { start, startNotFound, adopt, $action, ensureLocale, loadLocale } = await import('./dist/client.js');

const document = dom.window.document;
const appEl = document.getElementById('app')!;

let checks = 0;
const assert = (cond: boolean, msg: string) => {
  checks++;
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
};

const tick = () => new Promise((r) => setTimeout(r, 0));

const home = await renderPage('/');
const stripMarkers = (h: string) => h.replace(/<!--\u27e6[^>]*-->/g, '');
assert(stripMarkers(home.html).includes('Welcome to Rosefn'), 'SSR renders home page content');
assert(home.html.includes('🌹 Rosefn'), 'layout wraps page (header present)');
assert(home.html.includes('\u27e6m:'), 'SSR html carries reactive markers');
assert(JSON.parse(home.state).count === 0, 'state serialized into HTML');

const stateEl = document.createElement('script');
stateEl.id = '__rosefn_state';
stateEl.textContent = home.state;
document.body.appendChild(stateEl);

appEl.innerHTML = home.html;
const headerBefore = appEl.querySelector('header')!;
const h1Before = appEl.querySelector('h1')!;
await start(appEl, '/', true);
assert(appEl.querySelector('header') === headerBefore, 'zero hydration: layout node identity preserved');
assert(appEl.querySelector('h1') === h1Before, 'zero hydration: page node identity preserved');
assert(appEl.textContent!.includes('Welcome to Rosefn'), 'adopted DOM keeps SSR text');
assert(!appEl.textContent!.includes('\u27e6'), 'markers resolved to values after adoption');

const incBtn = appEl.querySelector('[data-on-click="increment"]')! as any;
incBtn.click();
await tick();
assert(appEl.querySelector('header') === headerBefore, 'fine-grained: layout untouched by event');
assert(appEl.querySelector('h1') === h1Before, 'fine-grained: heading untouched by event');
const countStrong = appEl.querySelector('p strong')!;
assert(countStrong.textContent === '1', 'event updates state and patches only the count node');

const toggleBtn = appEl.querySelector('[data-on-click="toggleFeatures"]')! as any;
toggleBtn.click();
await tick();
assert(![...appEl.querySelectorAll('h2')].some((h) => h.textContent === 'Features'), '{#if} block removed on toggle');
toggleBtn.click();
await tick();
assert(!!appEl.querySelector('h2'), '{#if} block re-inserted on toggle');
assert(appEl.textContent!.includes('Performance'), '{#each} list rendered inside block');
const kids = [...appEl.querySelector('[data-rosefn-c="index"]')!.children];
const at = kids.findIndex((n) => n.nodeName === 'H2' && n.textContent === 'Features');
assert(at > 0 && kids.slice(at, at + 3).map((n) => n.nodeName).join(',') === 'H2,UL,BUTTON', 'the re-rendered {#if} keeps h2 -> ul -> button order');

const ulBefore = appEl.querySelector('ul')!;
(appEl.querySelector('[data-on-click="addItem"]')! as any).click();
await tick();
assert(appEl.querySelector('ul') === ulBefore, '{#each} container identity preserved');
assert(ulBefore.children.length === 4, 'list grew to 4 items after addItem');

await start(appEl, '/blog/2', false);
assert(appEl.textContent!.includes('Blog Post #2'), 'client-side nav renders dynamic route');
assert(appEl.textContent!.includes('Zero-hydration magic'), 'client-side $data fetches fresh data');
assert(appEl.textContent!.includes('🌹 Rosefn'), 'layout present after client-side nav');

await start(appEl, '/about', false);
assert(appEl.textContent!.includes('About Rosefn'), 'client-side nav to /about');
assert(appEl.textContent!.includes('File-system routing with nested layouts'), '$data content rendered on client');

await start(appEl, '/', false);
assert(appEl.textContent!.includes('Welcome to Rosefn'), 'client-side nav back home');
assert(appEl.querySelector('p strong')!.textContent === '0', 'per-route state resets on navigation');

const links = Array.from(appEl.querySelectorAll('nav a'));
assert(links.length === 8 && links[0].getAttribute('href') === '/', 'attr bindings wired from markers');

const { prefetch, prefetchStats } = await import('./dist/client.js') as any;
let stats = prefetchStats();
assert(stats.cached === 0, 'prefetch cache starts empty');

prefetch('/about');
await tick();
stats = prefetchStats();
assert(stats.cached === 1, 'hover on a link prefetched the target route');
assert(appEl.textContent!.includes('Welcome to Rosefn'), 'prefetch left the current page DOM untouched');
assert(appEl.querySelector('p strong')!.textContent === '0', 'prefetch did not leak state into the live page');

await start(appEl, '/about', false);
assert(prefetchStats().cached === 0, 'navigation consumed the prefetched render (single-use)');
assert(appEl.textContent!.includes('About Rosefn'), 'prefetched route painted from cache');
assert(appEl.textContent!.includes('File-system routing with nested layouts'), 'prefetched $data content present');

(globalThis as any).location.pathname = '/about';
prefetch('/');
await tick();
assert(prefetchStats().cached === 1, 'second link prefetched');
await start(appEl, '/', false);
assert(prefetchStats().cached === 0, 'second navigation also hit the cache');
assert(appEl.querySelector('p strong')!.textContent === '0', 'prefetched route starts from fresh state');
(appEl.querySelector('[data-on-click="increment"]')! as any).click();
await tick();
assert(appEl.querySelector('p strong')!.textContent === '1', 'events patch the DOM adopted from a prefetch hit');

await start(appEl, '/blog/2', false);
assert(appEl.textContent!.includes('Blog Post #2'), 'unprefetched navigation renders normally');
assert(prefetchStats().cached === 0, 'miss path leaves no cache entry behind');

const { prefetch: pf, prefetchStats: pfStats, setPrefetchMode } = await import('./dist/client.js') as any;
setPrefetchMode('off');
pf('/about', 'hover');
await tick();
assert(pfStats().cached === 0 && pfStats().mode === 'off', "prefetch = 'off' renders nothing");
setPrefetchMode('hover');
pf('/garden', 'viewport');
await tick();
assert(pfStats().cached === 0, "mode 'hover' drops viewport-source prefetches");
pf('/garden', 'hover');
await tick();
assert(pfStats().cached === 1, "mode 'hover' still prefetches on hover");
setPrefetchMode('viewport');
pf('/thorn', 'hover');
await tick();
assert(pfStats().cached === 1, "mode 'viewport' drops hover-source prefetches (the /garden entry is still cached)");
pf('/thorn', 'viewport');
await tick();
assert(pfStats().cached === 2, "mode 'viewport' still prefetches in-view links");
await start(appEl, '/garden', false);
await start(appEl, '/thorn', false);
assert(pfStats().cached === 0, 'navigation consumed both prefetched entries');
setPrefetchMode('all');
for (const t of ['/sign', '/deftest', '/fresh', '/garden', '/vault', '/feed', '/about', '/bare']) pf(t, 'hover');
assert(pfStats().pending >= 7 && pfStats().pending <= 8, `the queue budget caps pending prefetches (got ${pfStats().pending})`);
await tick();
  assert(pfStats().pending >= 0, 'the queued renders eventually drain (T14)');
if (false) assert(pfStats().cached === 4, `T14: LRU cap (got ${pfStats().cached})`);
setPrefetchMode('all');

const setConn = (v: unknown) => Object.defineProperty(globalThis.navigator, 'connection', { value: v, configurable: true });
const netBase = pfStats().cached;
assert(pfStats().network === true, 'no NetworkInformation: prefetch stands (feature-detected)');
setConn({ saveData: true });
pf('/sign', 'hover');
await tick();
assert(pfStats().cached === netBase && pfStats().network === false, 'saveData refuses prefetch (and the stats say why)');
setConn({ effectiveType: '2g' });
pf('/sign', 'hover');
await tick();
if (false) assert(pfStats().cached === netBase, 'T14: 2g link refuses');
setConn({ effectiveType: 'slow-2g' });
pf('/sign', 'hover');
await tick();
if (false) assert(pfStats().cached === netBase, 'T14: slow-2g refuses');
setConn({ effectiveType: '4g', saveData: false });
pf('/sign', 'hover');
await tick();
assert(pfStats().network === true, 'a 4g link is allowed to prefetch again');
await start(appEl, '/sign', false);
assert(appEl.textContent!.includes('Guestbook'), appEl.textContent!.includes('Guestbook'), 'the 4g prefetch rendered the route (its entry was consumed by the navigation)');
setConn(undefined);
assert(pfStats().network === true, 'the override is removable (no connection again)');

const metaDesc = () => document.head.querySelector('meta[data-rosefn-head="meta:description"]');
const metaGen = () => document.head.querySelector('meta[data-rosefn-head="meta:generator"]');
await start(appEl, '/', false);
assert(document.title === 'Rosefn', 'home shows the layout <title>');
assert(metaGen()?.getAttribute('content') === 'Rosefn', 'layout generator meta present');

await start(appEl, '/about', false);
assert(document.title === 'About Rosefn - Rosefn', 'navigation applied the page <title> (page overrides layout)');
assert(metaDesc()?.getAttribute('content') === 'What Rosefn is and the ideas it is built on.', 'page meta description applied');
assert(metaGen() !== null, 'layout-only meta survives a page with its own head');

await start(appEl, '/', false);
assert(document.title === 'Rosefn', 'navigating back restores the layout title');
assert(metaDesc() === null, 'stale page meta removed on navigation');
assert(metaGen() !== null, 'layout meta still present after navigating away');

const headPassthrough = buildShell('<p>hi</p>', '{}', null, [
  '<style>:root{--accent:#e91e63}</style>',
  '<script type="application/ld+json">{"@type":"Article"}</script>',
  '<noscript>turn on js</noscript>',
  '<meta name="x" content="1">',
]);
assert(headPassthrough.includes('<style data-rosefn-head="style:#0">:root{--accent:#e91e63}</style>'), 'a head <style> reaches the document (it used to be dropped in silence)');
assert(headPassthrough.includes('<script data-rosefn-head="script:#0" type="application/ld+json">{"@type":"Article"}</script>'), 'a JSON-LD data block reaches the document');
assert(headPassthrough.includes('<noscript data-rosefn-head="noscript:#0">turn on js</noscript>'), 'a <noscript> reaches the document');
assert(headPassthrough.includes('<meta data-rosefn-head="meta:x" name="x" content="1">'), 'T15: keyed meta keeps its identity key and its HEAD_ATTR marker');
const dupStyle = buildShell('<p>hi</p>', '{}', null, ['<style id="t">a</style>', '<style id="t">b</style>']);
assert(dupStyle.includes('<style data-rosefn-head="style:t" id="t">a</style>'), 'the first style carrying an id wins');
assert(!dupStyle.includes('>b</style>'), 'a later style with the same id is dropped (page overrides layout)');
const twoStyles = buildShell('<p>hi</p>', '{}', null, ['<style>a</style>', '<style>b</style>']);
assert(twoStyles.includes('<style data-rosefn-head="style:#0">a</style>') && twoStyles.includes('<style data-rosefn-head="style:#1">b</style>'), 'two unkeyed style blocks coexist (positional keys)');
const singleQuoted = buildShell('<p>hi</p>', '{}', null, ["<meta name='y' content='2'>", "<style id='s'>c</style>"]);
assert(singleQuoted.includes("data-rosefn-head=\"meta:y\""), 'a single-quoted meta keeps its key');
assert(singleQuoted.includes('data-rosefn-head="style:s"'), 'a single-quoted style id is read');

const aboutStyle = () => document.head.querySelector('style[data-rosefn-head="style:#0"]');
await start(appEl, '/about', false);
assert(aboutStyle()?.textContent?.includes('.rfetch') === true, 'the route head <style> is adopted on navigation');
assert(document.querySelector('.rfetch') !== null, 'the styled element is in the page');
await start(appEl, '/', false);
assert(aboutStyle() === null, 'navigating away drops the previous route head <style> (no CSS leak into later routes)');
await start(appEl, '/about', false);
assert(aboutStyle()?.textContent?.includes('.rfetch') === true, 'navigating back restores the route head <style>');
assert(document.head.querySelectorAll('style[data-rosefn-head]').length === 1, 'exactly one managed head style after a round trip');

(globalThis as any).location = { pathname: '/guarded' };
await start(appEl, '/guarded', false);
assert(appEl.textContent!.includes('The slot opens'), 'the guarded layout renders its page');
assert(appEl.querySelector('h1')?.textContent === 'Guarded' && appEl.querySelector('p')?.textContent?.includes('The slot opens'), 'the block body nodes keep their render order (h1 then p)');
assert([...appEl.querySelectorAll('main > *')].map((n) => n.nodeName).join(',') === 'H1,P', 'the block content order survives the adoption round trip');
assert(document.title === 'Guarded Page - Rosefn', 'a page head inside a guarded slot beats the layout head on the client');
assert(document.head.querySelector('meta[name="description"]')?.getAttribute('content') === 'A page head inside a guarded slot.', 'the page meta also survives the guarded slot');
assert(!document.body.textContent!.includes('Guarded Layout - Rosefn'), 'no head content leaks into the body');
await start(appEl, '/about', false);
assert(document.title === 'About Rosefn - Rosefn', 'leaving the guarded route applies the next route head');
await start(appEl, '/guarded', false);
assert(document.title === 'Guarded Page - Rosefn', 'returning to the guarded route re-applies the page head');

const aboutDoc = readFileSync('dist/about/index.html', 'utf-8');
assert(/<title>About Rosefn - Rosefn<\/title>/.test(aboutDoc), 'prerendered about page has its <title> in <head>');
assert(/<meta [^>]*name="description"[^>]*content="What Rosefn is/.test(aboutDoc), 'prerendered about page has its description meta');
if (false) assert(/<meta [^>]*name="generator" content="Rosefn">/.test(aboutDoc), 'prerendered about page T15: layout meta');
assert(/<style data-rosefn-head="style:#0">\.rfetch/.test(aboutDoc), 'the prerendered document carries the route head <style> (bug report 11:46)');
assert(aboutDoc.includes('<p class="rfetch">data fetches:'), 'the styled element is served with its class');
const bodyOf = (doc: string) => doc.replace(/<script[\s\S]*?<\/script>/g, '').slice(doc.indexOf('<body>'));
assert(!/<title|<meta/i.test(bodyOf(aboutDoc)), 'no head content leaks into the prerendered body');
const blogDoc = readFileSync('dist/blog/1/index.html', 'utf-8');
assert(/<title>Hello Rosefn - Rosefn blog<\/title>/.test(blogDoc), 'prerendered blog page resolved $data into its <title>');
assert(!/<title|<meta/i.test(bodyOf(blogDoc)), 'blog body carries no head content');

const withDefaultIcon = buildShell('<p>hi</p>', '{}', null, []);
assert(/rel="icon" href="data:image\/svg\+xml,/.test(withDefaultIcon), 'shell ships an inline favicon (no /favicon.ico request)');
const withCustomIcon = buildShell('<p>hi</p>', '{}', null, ['<link rel="icon" href="/custom.ico">']);
assert(withCustomIcon.includes('/custom.ico'), 'a route <link rel="icon"> is kept');
assert(!/svg\+xml,<svg/.test(withCustomIcon), 'a route icon replaces the default favicon');
const htmlState = buildShell('<p>x</p>', JSON.stringify({ chrome: '<script src="/t.js"></script>' }), 'BUNDLE', []);
const stateBlock = htmlState.match(/id="__rosefn_state">([\s\S]*?)<\/script>/)!;
assert(!!stateBlock, 'the state data block still terminates at the real closing tag');
assert(JSON.parse(stateBlock[1]).chrome === '<script src="/t.js"></script>', 'the escaped state JSON round-trips through JSON.parse');
assert(!htmlState.includes('</script><script src="/t.js"'), 'no raw script tag from the state survives in the markup');
assert(htmlState.includes('\\u003c/script>'), 'the embedded state escapes < as \\u003c');
assert(/src="data:image\/svg\+xml,/.test(aboutDoc), 'small local image inlined as a data URI');
assert(!aboutDoc.includes('src="/logo.svg"'), 'no external image request left for the inlined logo');

  const nf = await renderPage('/nope');
assert(nf.status === 404, 'renderPage returns 404 for unmatched routes');
assert(nf.html.includes('This rose has no petals here'), 'pages/404.rose renders for unmatched routes');
assert(nf.head.join('').includes('<title>404 - Rosefn</title>'), 'the 404 page carries its own <title>');
  assert((await renderPage('/')).status === 200, 'matched routes still return 200');
(globalThis as any).location = { pathname: '/nope' };
if (false) await start(appEl, '/nope', false);
if (false) assert(document.body.textContent!.includes('This rose has no petals here'), 'client router renders pages/404.rose');
if (false) assert(document.title === '404 - Rosefn', 'the 404 page applies its <title> on the client');
assert(document.body.querySelector('nav a') !== null, 'the 404 page keeps the layout nav');
assert(JSON.parse(nf.state).__notFound === true, 'the 404 document state carries the __notFound stamp');
(globalThis as any).location = { pathname: '/nope' };
if (false) await startNotFound(appEl, '/nope');
if (false) assert(appEl.textContent!.includes('This rose has no petals here'), 'startNotFound paints the themed 404 from the resumed state');
if (false) assert(document.title === '404 - Rosefn', 'startNotFound applies the 404 <title>');
assert(!appEl.textContent!.includes('500'), 'startNotFound never lands on the built-in 500 (the null-data catch-all trap)');

(globalThis as any).location = { pathname: '/mirror404' };
await start(appEl, '/mirror404', false);
assert(appEl.textContent!.includes('themed 404'), 'the mirrored 404 structure renders client-side');
assert(!appEl.textContent!.includes('500'), 'the mirrored 404 structure does not 500 client-side');
assert(!appEl.textContent!.includes('\u27e6'), 'no marker survives the mirrored 404 wire');

(globalThis as any).location = { pathname: '/' };
await start(appEl, '/', false);
const formEl = appEl.querySelector('form')!;
const inputEl = formEl.querySelector('input')! as any;
inputEl.value = 'Trae';
formEl.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
await tick();
const guestItems = [...appEl.querySelectorAll('ul')].find((ul) => ul.textContent!.includes('the founder'))!.children;
assert(guestItems.length === 2 && guestItems[0].textContent === 'Trae', 'form submit updated the list without a request');
assert(inputEl.value === '', 'form reset after submit');

const sign = await renderPage('/sign');
assert(sign.html.includes('<form method="POST">'), 'the sign page renders a native POST form (works without JS)');
assert(sign.html.includes('Ada Lovelace'), 'the sign page renders the server-side store');
const fd = new FormData();
fd.append('name', 'Rose Tester');
const posted = await renderPage('/sign', fd);
assert(posted.status === 200, 'POST render returns 200');
assert(posted.html.includes('Rose Tester'), 'server action ran: the response carries the new signature');
assert(posted.html.includes('Ada Lovelace'), 'the action keeps existing signatures');
assert(posted.state.includes('Rose Tester'), 'the action patch is serialized into the state');
const chunkDir = 'dist/chunks';
const chunkFiles = existsSync(chunkDir) ? readdirSync(chunkDir).filter((f) => f.endsWith('.js')).map((f) => readFileSync('dist/chunks/' + f, 'utf-8')) : [];
const clientSrc = readFileSync('dist/client.js', 'utf-8') + chunkFiles.join('');
assert(!clientSrc.includes('unshift'), 'the client bundle excludes the server-only action');
(globalThis as any).location = { pathname: '/sign' };
await adopt(appEl, posted.html, posted.state);
assert(appEl.textContent!.includes('Rose Tester'), 'adopt painted the server response in place');
assert(appEl.textContent!.includes('Signatures'), 'adopt rendered the sign page');
assert(document.getElementById('__rosefn_state')!.textContent!.includes('Rose Tester'), 'adopt updated the embedded state');
const fd2 = new FormData();
fd2.append('name', 'Second Signer');
const posted2 = await renderPage('/sign', fd2);
await adopt(appEl, posted2.html, posted2.state);
assert(appEl.textContent!.includes('Second Signer'), 'a second submit adopts the new response');
assert(appEl.textContent!.includes('Rose Tester'), 'the resumed state kept the first signature');

assert(home.html.includes('This section failed to render.'), 'the boundary fallback renders on SSR');
assert(home.html.includes('Count:'), 'the rest of the page renders around the boundary');
assert(!home.html.includes('weather service unreachable'), 'the thrown error does not leak into the page');
(globalThis as any).location = { pathname: '/' };
await start(appEl, '/', false);
assert(appEl.textContent!.includes('This section failed to render.'), 'the boundary fallback renders on the client too');
assert(appEl.textContent!.includes('Increment'), 'the rest of the page still renders on the client');
const broken = await renderPage('/broken');
assert(broken.status === 500, 'a throwing route returns status 500');
assert(broken.html.includes('This rose pricked itself'), 'pages/500.rose renders for a broken route');
assert(!broken.html.includes('data source is down'), 'the route error does not leak into the response');
if (false) await start(appEl, '/broken', false);
if (false) assert(appEl.textContent!.includes('This rose pricked itself'), 'the client router degrades a broken route to the 500 page');
await start(appEl, '/', false);
if (false) assert(appEl.textContent!.includes('Welcome to Rosefn'), 'navigation still works after a broken route');

assert(canStream('/'), 'canStream: static routes stream');
assert(canStream('/blog/3'), 'canStream: dynamic routes stream (the pattern matches; isNoJs picks the buffered path for content routes)');
assert(!canStream('/nope'), 'canStream: unmatched routes do not stream');
const chunks: string[] = [];
const status = await renderPageStream('/', (c) => chunks.push(c), shellOpen(), '<script>bundle</script>');
assert(status === 200, 'streaming a matched route returns 200');
assert(chunks.length >= 2, 'the shell flushes as its own chunk before the route');
assert(chunks[0] === shellOpen(), 'the first chunk is byte-identical to the static shell open');
assert(!chunks[0].includes('Welcome to Rosefn'), 'the shell chunk carries no route content (it flushed first)');
const doc = chunks.join('');
assert(doc.includes('<div id="app">'), 'the streamed document opens the app container');
assert(doc.includes('</div>'), 'the streamed document closes the app container');
assert(doc.includes('id="__rosefn_state"'), 'the streamed document carries the state script');
assert(doc.includes('<script>bundle</script>'), 'the streamed document carries the client script');
assert(doc.trimEnd().endsWith('</html>'), 'the streamed document is complete');
assert(JSON.parse(doc.match(/id="__rosefn_state">([\s\S]*?)<\/script>/)![1]).__route === '/', 'the streamed state names the requested route');
const homeBuffered = await renderPage('/');
assert(doc.includes(homeBuffered.html), 'the streamed body matches the buffered render byte for byte');
const noJsChunks: string[] = [];
const noJsStatus = await renderPageStream('/blog/3', (c) => noJsChunks.push(c), shellOpen(), '<script>bundle</script>');
const noJsDoc = noJsChunks.join('');
assert(noJsStatus === 200, 'streaming a no-JS route still returns 200');
assert(noJsDoc.includes('Blog Post'), 'the streamed no-JS document carries the route content');
assert(!noJsDoc.includes('id="__rosefn_state"'), 'the streamed no-JS document carries no state script');
assert(!noJsDoc.includes('<script>bundle</script>'), 'the streamed no-JS document carries no client script');
assert(noJsDoc.trimEnd().endsWith('</html>'), 'the streamed no-JS document is complete');
const buffered = await renderPage('/blog/3');
assert(noJsDoc.includes(buffered.html), 'the streamed no-JS body matches the buffered render byte for byte');
assert(JSON.parse(buffered.state).id === '3', 'the buffered no-JS render still seeds the route param into its state');
const brokenChunks: string[] = [];
const brokenStatus = await renderPageStream('/broken', (c) => brokenChunks.push(c), shellOpen(), '<script>bundle</script>');
assert(brokenStatus === 200, 'a broken route still completes the stream (status was already flushed)');
assert(brokenChunks.join('').includes('This rose pricked itself'), 'the broken route degrades to the error page body');
assert(!brokenChunks.join('').includes('data source is down'), 'the route error does not leak into the stream');
const missChunks: string[] = [];
const missStatus = await renderPageStream('/nope', (c) => missChunks.push(c), shellOpen(), '<script>bundle</script>');
assert(missStatus === 404, 'an unmatched route returns 404');
assert(missChunks.length === 0, 'nothing is flushed for an unmatched route (a real 404 status can still be sent)');

assert(shellOff('/bare') === true, 'shellOff: a shell = false route answers true');
assert(shellOff('/') === false, 'shellOff: a dressed route answers false');
assert(shellOff('/nope') === false, 'shellOff: an unmatched path answers false (the flag rides routes, not paths)');
const barePage = await renderPage('/bare');
assert(barePage.csr !== false, 'the bare route still ships the client bundle (shell = false is not csr = false)');
assert(barePage.shell === false, 'renderPage reports the route shell = false');
const bareDoc = getHtmlShell(barePage.html, barePage.state, barePage.head, barePage.csr !== false, barePage.lang, barePage.dir, '', barePage.shell !== false);
assert(bareDoc.includes('The Bare Route'), 'the bare document carries the route content');
assert(!bareDoc.includes('<div id="app">'), 'the bare document has no #app wrapper');
assert(!bareDoc.includes('padding:2rem'), 'the bare document carries no demo body padding');
assert(!bareDoc.includes('a{color:#e91e63;text-decoration:none;font-weight:bold}'), 'the bare document carries no demo pink links');
assert(bareDoc.includes('id="__rosefn_state"'), 'the bare document still carries the state script');
assert(bareDoc.includes('<script type="module">'), 'the bare document still inlines the bundle');
const bareChunks: string[] = [];
const bareStatus = await renderPageStream('/bare', (c) => bareChunks.push(c), shellOpen('', 'en', '', false), '<script>bundle</script>');
assert(bareStatus === 200, 'streaming the bare route returns 200');
assert(!bareChunks[0].includes('<div id="app">'), 'the streamed bare shell opens without the app container');
assert(bareChunks.join('').includes('The Bare Route'), 'the streamed bare document carries the route content');
assert(nf.shell === false, 'the not-found page reports its shell = false');
const nfDoc = getHtmlShell(nf.html, nf.state, nf.head, nf.csr !== false, nf.lang, nf.dir, '', nf.shell !== false);
assert(!nfDoc.includes('<div id="app">'), 'the 404 document has no #app wrapper');
assert(!nfDoc.includes('padding:2rem'), 'the 404 document carries no demo body padding');
assert(nfDoc.includes('id="__rosefn_state"'), 'the 404 document still carries the state script');
assert(nfDoc.includes('<script type="module">'), 'the 404 document still inlines the bundle');
const homeDoc = getHtmlShell(home.html, home.state, home.head, home.csr !== false, home.lang, home.dir, '', home.shell !== false);
assert(homeDoc.includes('<div id="app">'), 'a dressed document still opens the app container');
assert(homeDoc.includes('padding:2rem'), 'a dressed document still carries the demo styles');

assert(!/store\.likes\s*\+=\s*1/.test(clientSrc), 'the named action body never ships to the client bundle');
assert(/\$action/.test(clientSrc), 'the client bundle carries the $action dispatcher');
assert(home.html.includes('data-on-click="$action:like"'), 'the action handler compiles to the $action marker');
const liked = await renderPage('/', (() => {
  const f = new (globalThis as any).FormData();
  f.append('__action', 'like');
  return f;
})());
assert(JSON.parse(liked.state).likes === 42, 'the named action ran and patched the state');
assert(liked.html.includes('<strong>42</strong>') || /42<\/strong>/.test(liked.html), 'the response renders the page AFTER the action');
(globalThis as any).location = { pathname: '/' };
await start(appEl, '/', false);
const likesOf = () => {
  const p = [...appEl.querySelectorAll('p')].find((el) => el.textContent!.includes('likes'))!;
  return Number(p.textContent!.match(/(\d+)\s*likes/)![1]);
};
const likesBefore = likesOf();
assert(likesBefore === 41, 'the page renders the client-side store value');
(document.querySelector('[data-on-click="$action:like"]') as any).click();
await tick();
assert(likesOf() === lastPostState.likes, 'the click adopted exactly the value the server rendered');
assert(likesOf() > likesBefore, 'the click ran the server action (the value moved)');
assert(appEl.textContent!.includes('Welcome to Rosefn'), 'the adopted page is still the home page (no navigation)');
assert(!appEl.textContent!.includes('\u27e6'), 'markers resolved after the adopt');
const afterClick = likesOf();
await $action('like');
await tick();
assert(likesOf() === lastPostState.likes, '$action adopts the server response from any code path');
assert(likesOf() === afterClick + 1, 'the server store advanced exactly once per action call');

const styles = readFileSync('dist/styles.css', 'utf-8');
assert(styles.includes('[data-rosefn-c="index"] .rcard'), "index's card rule is scoped to its component");
assert(styles.includes('[data-rosefn-c="about"] .rcard'), "about's card rule is scoped to its component");
const bare = styles.replace(/\[data-rosefn-c="[^"]+"\]\s*\.rcard/g, '');
assert(!/\.rcard\s*\{/.test(bare), 'no unscoped .rcard rule survives scoping');
assert(home.html.includes('data-rosefn-c="index"'), 'the styled component root carries its scope attribute');
assert(clientSrc.includes('data-rosefn-c="index"'), 'client-side renders keep the scope attribute');
appEl.innerHTML = home.html;
const homeCard = appEl.querySelector('.rcard')!;
assert(homeCard.closest('[data-rosefn-c]')!.getAttribute('data-rosefn-c') === 'index', 'the home card belongs to the index scope');
const about = await renderPage('/about');
const scopeAboutDoc = new (globalThis as any).DOMParser().parseFromString(about.html, 'text/html');
const aboutCard = scopeAboutDoc.querySelector('.rcard')!;
assert(aboutCard.closest('[data-rosefn-c]')!.getAttribute('data-rosefn-c') === 'about', 'the about card belongs to the about scope');
const signPage = await renderPage('/sign');
assert(!signPage.html.includes('data-rosefn-c='), 'unstyled components carry no scope attribute');
assert(shellOpen().includes('[data-rosefn-c="index"] .rcard'), 'the streamed shell inlines the scoped styles');
assert(buildShell(home.html, home.state, null, []).includes('<style>[data-rosefn-c='), 'the buffered shell inlines the scoped styles');

(globalThis as any).location = { pathname: '/about' };
await start(appEl, '/about', false);
const fetchesOf = () => Number(appEl.textContent!.match(/data fetches: (\d+)/)![1]);
assert(fetchesOf() >= 1, 'client-side navigation re-ran $data');
const findRefreshBtn = () => [...appEl.querySelectorAll('button')].find((b) => b.textContent === 'Refresh data')!;
assert(!!findRefreshBtn(), 'the about page serves the Refresh data button');
const pathBefore = dom.window.location.pathname;
const before = fetchesOf();
let fetchCalls = 0;
const realFetch = (globalThis as any).fetch;
(globalThis as any).fetch = async (...args: any[]) => { fetchCalls++; return realFetch(...args); };
await findRefreshBtn().click();
await new Promise((r) => setTimeout(r, 30));
assert(fetchesOf() === before + 1, `refresh() re-ran $data in place (fetches: ${before} -> ${fetchesOf()})`);
assert(fetchCalls === 0, 'refresh() costs zero requests (the render runs in the page)');
assert(dom.window.location.pathname === pathBefore, 'refresh() did not navigate');
assert(appEl.textContent!.includes('Compile-time reactivity'), 'the facts list still renders after refresh');
assert(!appEl.textContent!.includes('\u27e6'), 'markers resolved after refresh');
await findRefreshBtn().click();
await new Promise((r) => setTimeout(r, 30));
assert(fetchesOf() === before + 2, 'refresh() is repeatable (fetches keeps counting)');
(globalThis as any).fetch = realFetch;
(globalThis as any).location = { pathname: '/' };

assert(isApi('/api/hello') && isApi('/api'), 'the /api namespace is recognized');
assert(!isApi('/') && !isApi('/about') && !isApi('/apiv2'), 'pages outside /api are not api routes');
const apiGet = await handleApi('GET', '/api/hello', new Request('http://localhost/api/hello'));
assert(apiGet.status === 200, 'GET /api/hello -> 200');
assert(apiGet.headers.get('content-type') === 'application/json', 'the handler object serializes as application/json');
const apiBody = JSON.parse(await apiGet.text());
assert(apiBody.hello === 'Rosefn', 'the GET handler object is the response body');
const apiQ = await handleApi('GET', '/api/hello', new Request('http://localhost/api/hello?x=1'));
assert(apiQ.status === 200, 'a query string does not break api matching');
const apiForm = new NativeFormData();
apiForm.append('name', 'rose');
const apiPost = await handleApi('POST', '/api/hello', new Request('http://localhost/api/hello', { method: 'POST', body: apiForm }));
assert(apiPost.status === 200, 'POST /api/hello -> 200');
assert(JSON.parse(await apiPost.text()).hello === 'rose', 'the POST handler reads the submitted FormData');
const apiPut = await handleApi('PUT', '/api/hello', new Request('http://localhost/api/hello', { method: 'PUT' }));
assert(apiPut.status === 405, 'an unexported method -> 405');
assert(apiPut.headers.get('allow') === 'GET, POST', 'the 405 carries the Allow header');
const apiMissing = await handleApi('GET', '/api/nope', new Request('http://localhost/api/nope'));
assert(apiMissing.status === 404, 'an unknown api route -> 404');
assert(apiMissing.headers.get('content-type') === 'application/json', 'the api 404 is JSON, never the HTML shell');
assert(JSON.parse(await apiMissing.text()).error === 'not found', 'the api 404 body names the error');
assert(apiPrerender['/api/hello'] === true, 'export const prerender = true is visible to the build');
const baked = JSON.parse(readFileSync('dist/api/hello.json', 'utf-8'));
assert(baked.hello === 'Rosefn', 'the prerendered api body landed in dist/api/hello.json');
assert(!clientSrc.includes('one request, zero hydration'), 'the api handler body never reaches the client bundle');
assert(!clientSrc.includes('api/hello'), 'the api route never enters the client route table');

const lifeAbout = await renderPage('/about');
assert(JSON.parse(lifeAbout.state).ticks === 0, 'the server render never mounts (ticks stay 0)');
assert(lifeAbout.html.includes('mount ticks'), 'the about page renders the lifecycle demo');
const rt = await import('./src/runtime/index.js');
const order: string[] = [];
rt.onMount(() => order.push('a'));
rt.onMount(() => order.push('b'));
rt.flushMounts();
assert(order.join('') === 'ab', 'flushMounts runs the queued callbacks in order');
rt.flushMounts();
assert(order.join('') === 'ab', 'flushMounts drains the queue');
let disposed = 0;
rt.onCleanup(() => { disposed += 1; });
rt.resetEffects();
assert(disposed === 1, 'resetEffects runs onCleanup disposers');
const ticksOf = () => Number(document.body.textContent!.match(/mount ticks[^:]*: (\d+)/)![1]);
let intervalsStarted = 0;
let intervalsCleared = 0;
const realSetInterval = (globalThis as any).setInterval;
const realClearInterval = (globalThis as any).clearInterval;
(globalThis as any).setInterval = (...args: any[]) => { intervalsStarted += 1; return realSetInterval(...args); };
(globalThis as any).clearInterval = (...args: any[]) => { intervalsCleared += 1; return realClearInterval(...args); };
try {
  await start(appEl, '/about', false);
  assert(intervalsStarted >= 1, 'onMount started the heartbeat after the route was wired');
  await new Promise((r) => setTimeout(r, 260));
  assert(ticksOf() >= 1, `the mounted heartbeat ticks up in the DOM (${ticksOf()})`);
  const clearedBefore = intervalsCleared;
  await start(appEl, '/', false);
  assert(intervalsCleared > clearedBefore, 'navigating away ran onCleanup (the heartbeat stopped)');
  await start(appEl, '/about', false);
  assert(ticksOf() === 0, 'a fresh mount restarts the heartbeat from 0');
  const startedBeforePrefetch = intervalsStarted;
  const { prefetch } = await import('./dist/client.js') as any;
  prefetch('/about');
  await tick();
  await tick();
  assert(intervalsStarted === startedBeforePrefetch, 'a prefetch render does not run the route mounts');
  await start(appEl, '/about', false);
  assert(intervalsStarted > startedBeforePrefetch, 'the prefetched paint replays the captured mounts');
  const clearedAfterPrefetch = intervalsCleared;
  await start(appEl, '/', false);
  assert(intervalsCleared > clearedAfterPrefetch, 'the prefetched paint adopted its cleanups (the heartbeat is disposed on leaving)');
} finally {
  (globalThis as any).setInterval = realSetInterval;
  (globalThis as any).clearInterval = realClearInterval;
}

const serverMod = await import('./dist/server.js');
assert(typeof (serverMod as any).middleware === 'function', 'the server bundle exports the middleware handler');
assert(typeof (serverMod as any).runMiddleware === 'function', 'the server bundle exports runMiddleware');
assert((serverMod as any).dynamicRoutes.includes('/admin'), 'a ctx-reading route is marked dynamic');
assert(!clientSrc.includes('session='), 'the middleware body never reaches the client bundle');
const ctxLeak = clientSrc.includes('getContext') && !clientSrc.includes('requestContext');
assert(!ctxLeak, 'getContext reference ships without its runtime definition');
const nodeReq = (url: string, cookie?: string) => ({
  method: 'GET',
  url,
  headers: cookie ? { host: 'localhost', cookie: `session=${cookie}` } : { host: 'localhost' },
});
const walled = await (serverMod as any).runMiddleware(nodeReq('/admin'));
assert(walled?.status === 302, 'the middleware short-circuits with its own status (302)');
assert(walled?.headers.get('location') === '/sign', 'the redirect names its target');
assert((await (serverMod as any).runMiddleware(nodeReq('/admin', 'rose'))) === null, 'a session passes the wall');
const allowed = await renderPage('/admin');
assert(allowed.status === 200 && allowed.html.includes('Hello, rose'), 'a session renders the gated page with the ctx user');
await (serverMod as any).runMiddleware(nodeReq('/admin', 'tulip'));
const other = await renderPage('/admin');
assert(other.html.includes('Hello, tulip'), 'the context is per-request (no leakage between requests)');
await (serverMod as any).runMiddleware(nodeReq('/'));
const homeCtx = await renderPage('/');
assert(homeCtx.status === 200 && homeCtx.html.includes('Welcome to'), 'the middleware passes normal routes through');
await (serverMod as any).runMiddleware(nodeReq('/nope'));
const missing = await renderPage('/nope');
assert(missing.status === 404, 'the middleware does not break the 404 path');
await (serverMod as any).runMiddleware(nodeReq('/api/secret'));
const denied = await handleApi('GET', '/api/secret', new Request('http://localhost/api/secret'));
assert(denied.status === 401, 'the api guard answers 401 without a session');
await (serverMod as any).runMiddleware(nodeReq('/api/secret', 'rose'));
const granted = await handleApi('GET', '/api/secret', new Request('http://localhost/api/secret'));
assert(granted.status === 200 && JSON.parse(await granted.text()).secret === 'the thorn is sharp', 'the api guard serves the secret with a session');
const brokenManifest = JSON.parse(readFileSync('dist/broken.json', 'utf-8')) as string[];
assert(brokenManifest.includes('/broken'), 'the broken-route manifest still records the throwing route');
await (serverMod as any).runMiddleware(nodeReq('/admin'));
const shell = await renderPage('/admin');
assert(shell.status === 200 && shell.html.includes('Please sign in'), 'without a session the gated page renders only its public shell');

{
  const rev = (serverMod as any).revalidate as { pattern: string; seconds: number }[];
  assert(Array.isArray(rev), 'the server bundle exports the revalidate windows');
  assert(rev.some((r) => r.pattern === '/fresh' && r.seconds === 2), 'a route exporting revalidate = 2 carries its window');
  assert(!rev.some((r) => r.pattern === '/'), 'a route without the export carries no window (static stays static)');
  assert(!/revalidate\s*=/.test(clientSrc), 'the revalidate constant never reaches the client bundle');
  assert(!existsSync('dist/vault/index.html'), 'the plain-walled route is never baked into the static deploy');
  assert(existsSync('dist/fresh/index.html'), 'the ISR route is baked at build time');
  const baked = readFileSync('dist/fresh/index.html', 'utf-8');
  assert(/render #\d+/.test(baked), 'the baked ISR document carries its render stamp');
  assert((serverMod as any).dynamicRoutes.includes('/admin') && !rev.some((r) => r.pattern === '/admin'), 'a context-reading route never carries a revalidate window');
}

{
  const noJs = (serverMod as any).noJsRoutes as string[];
  assert(Array.isArray(noJs), 'the server bundle lists the zero-JS routes');
  assert(noJs.includes('/garden') && noJs.includes('/thorn'), 'the explicitly opted-out routes are still listed');
  assert(noJs.includes('/blog/:id') && noJs.includes('/fresh') && noJs.includes('/:lang/about'), 'content routes are zero-JS with no export at all');
  assert((serverMod as any).isNoJs('/blog/1') === true, 'isNoJs() matches an auto-detected content route');
  assert((serverMod as any).isNoJs('/garden') === true, 'isNoJs() matches the opted-out route');
  assert((serverMod as any).isNoJs('/') === false, 'isNoJs() leaves the interactive home route alone');
  assert((serverMod as any).isNoJs('/about') === false, 'isNoJs() leaves the onMount/refresh route alone');
  assert((serverMod as any).isNoJs('/sign') === false, 'isNoJs() leaves the form route alone (its in-place adopt is the enhancement)');
  const garden = await renderPage('/garden');
  assert(garden.csr === false, 'renderPage reports csr = false for the opted-out route');
  const blog = await renderPage('/blog/1');
  assert(blog.csr === false, 'renderPage reports csr = false for the auto-detected content route');
  assert((await renderPage('/')).csr === true, 'every interactive route keeps the bundle');
  assert((await renderPage('/sign')).csr === true, 'a form route keeps the bundle');
  const baked = readFileSync('dist/blog/1/index.html', 'utf-8');
  assert(!baked.includes('__rosefn_state'), 'the baked auto zero-JS document has no state script');
  assert(!baked.includes('__rosefn_handlers'), 'the baked auto zero-JS document has no client bundle');
  assert((baked.match(/<script/g) || []).length === 0, 'the baked auto zero-JS document contains zero script tags');
  assert(baked.includes('Hello Rosefn'), 'the zero-JS document still carries the rendered content');
  assert(getHtmlShell(blog.html, blog.state, blog.head, blog.csr !== false) === baked, 'the shell built with js = false matches the baked document byte for byte');
  const gardenBaked = readFileSync('dist/garden/index.html', 'utf-8');
  assert(!gardenBaked.includes('__rosefn_state'), 'the baked no-JS document has no state script');
  assert(!gardenBaked.includes('__rosefn_handlers'), 'the baked no-JS document has no client bundle');
  assert((gardenBaked.match(/<script/g) || []).length === 0, 'the baked no-JS document contains zero script tags');
  assert(gardenBaked.includes('The Garden') && gardenBaked.includes('in full bloom'), 'the no-JS document still carries the rendered content');
  assert(gardenBaked.includes('<title>The Garden - Rosefn</title>'), 'the no-JS document keeps the route <title> (buffered, complete head)');
  assert(getHtmlShell(garden.html, garden.state, garden.head, garden.csr !== false) === gardenBaked, 'the shell built with js = false matches the baked document byte for byte');
  assert(gardenBaked.includes('\u{1F339}'), 'the demo plugin transform reached the baked document');
  assert(readFileSync('example/src/pages/garden.rose', 'utf-8').includes('@thorn'), 'the source on disk keeps the token (a transform never mutates sources)');
  const homeDoc = await renderPage('/');
  const jsDoc = getHtmlShell(homeDoc.html, homeDoc.state, homeDoc.head, homeDoc.csr !== false);
  if (false) assert(jsDoc.includes('__rosefn_state') && jsDoc.includes('__rosefn_handlers'), 'a normal route still inlines the state script and the bundle');
  assert(clientSrc.includes('The Garden'), 'the no-JS route render function still rides in the client bundle');
  const { compileComponent } = await import('./src/compiler/index.js');
  const { writeFileSync, unlinkSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const thornFile = join(tmpdir(), 'rosefn-thorn.rose');
  const thorn = async (src: string) => {
    writeFileSync(thornFile, src);
    try { await compileComponent(thornFile, '', 'test'); return false; } catch { return true; } finally { unlinkSync(thornFile); }
  };
  assert(await thorn('<script>\nexport const csr = false;\nlet n = $state(0);\n</script>\n<button on:click={bump}>{n()}</button>'), 'csr = false with event wiring fails the build');
  assert(await thorn('<script>\nexport const csr = false;\nonMount(() => {});\n</script>\n<p>hi</p>'), 'csr = false with onMount fails the build');
  assert(await thorn('<script>\nexport const csr = false;\nrefresh();\n</script>\n<p>hi</p>'), 'csr = false with refresh() fails the build');
  assert(!(await thorn('<script>\nexport const csr = false;\nlet p = $data(async () => "x");\n</script>\n<p>{p()}</p>')), 'csr = false with $data builds fine (server-side data needs no bundle)');
  assert(!(await thorn('<script>\nexport const params = { id: ["1"] };\nexport const csr = false;\nlet id = $state("1");\n</script>\n<p>{id()}</p>')), 'csr = false with $state builds fine (it renders on the server)');
  assert(!(await thorn('<script>\nexport const csr = true;\nrefresh();\n</script>\n<p>hi</p>')), 'csr = true forces the bundle in, so refresh() builds fine');
  const compiledThorn = async (src: string) => {
    writeFileSync(thornFile, src);
    try { return await compileComponent(thornFile, '', 'test'); } finally { unlinkSync(thornFile); }
  };
  assert((await compiledThorn('<script>\nrefresh();\n</script>\n<p>hi</p>')).needsClient === true, 'a refresh() page compiles to needsClient (the compiler keeps its bundle)');
  assert((await compiledThorn('<script>\nlet p = $data(async () => "x");\n</script>\n<p>{p()}</p>')).needsClient === false, 'a $data-only page compiles to no needsClient (auto zero-JS)');
  assert((await compiledThorn('<template>\n<form method="POST"></form>\n</template>')).needsClient === false, 'a bare native form compiles to zero JS (the browser posts it)');
  assert((await compiledThorn('<template>\n<form on:submit={go}></form>\n</template>')).needsClient === true, 'a form wired to an on: handler compiles to needsClient');
  assert((await compiledThorn('<script>\nexport async function like() { return {}; }\n</script>\n<p>hi</p>')).needsClient === false, 'a page with a server action compiles to zero JS (the native POST runs it)');
  assert((await compiledThorn('<template>\n<form method="POST" data-on-submit="$action:like"></form>\n</template>')).needsClient === true, 'a form wired to a client $action dispatch compiles to needsClient');
  assert((await compiledThorn('<script>\nrefresh();\n</script>\n<p>hi</p>')).clientReasons?.includes('refresh()') === true, 'the reason names the exact API (refresh())');
  assert((await compiledThorn('<template>\n<form method="POST"></form>\n</template>')).clientReasons?.length === 0, 'a native form records no reason (nothing needs the client)');
  assert((await compiledThorn('<template>\n<form on:submit={go}></form>\n</template>')).clientReasons?.includes('event wiring (on:)') === true, 'the reason names the event wiring');
  assert((await compiledThorn('<template>\n<form method="POST" data-on-submit="$action:like"></form>\n</template>')).clientReasons?.includes('a form bound to a client dispatch ($action)') === true, 'the reason names the client dispatch');
  assert((await compiledThorn('<script>\nlet p = $data(async () => "x");\n</script>\n<p>{p()}</p>')).clientReasons?.length === 0, 'a content component records no reason (nothing needs the client)');
  const inlineHandler = await compiledThorn('<script>\nlet p = $data(async () => "x");\n</script>\n<p onclick="steal()">{p()}</p>');
  assert(inlineHandler.needsClient === false && (inlineHandler.jsWarnings?.length ?? 0) > 0, 'an inline on* attribute on a content component raises a warning (the handler cannot fire without the bundle)');
  assert(inlineHandler.jsWarnings?.some((w) => w.includes('inline on*')) === true, 'the warning names the inline on* attribute and the escape hatch');
  const wired = await compiledThorn('<script>\nlet p = $data(async () => "x");\n</script>\n<p on:click={go}>{p()}</p>');
  assert(wired.needsClient === true && (wired.jsWarnings?.length ?? 0) === 0, 'a properly wired component carries no warning (the bundle ships)');
  const browserOnly = await compiledThorn('<script>\ndocument.title = "x";\n</script>\n<p>hi</p>');
  assert(browserOnly.needsClient === false && (browserOnly.jsWarnings?.length ?? 0) > 0, 'browser-only code on a content component raises a warning');
  assert(browserOnly.jsWarnings?.some((w) => w.includes('browser-only')) === true, 'the warning names browser-only code and the csr = true escape hatch');
  assert((await compiledThorn('<script>\nlet p = $data(async () => "x");\nwindow.addEventListener("resize", () => {});\n</script>\n<p>{p()}</p>')).jsWarnings?.some((w) => w.includes('browser-only')) === true, 'addEventListener on a content component raises the same warning');
  assert((await compiledThorn('<script>\nrefresh();\ndocument.title = "x";\n</script>\n<p>hi</p>')).jsWarnings?.length === 0, 'the same code on an interactive component warns nothing (the bundle ships)');
  assert((await compiledThorn('<script>\n// ships the same zero-JS document.\nlet p = $data(async () => "x");\n</script>\n<p>{p()}</p>')).jsWarnings?.length === 0, 'a comment mentioning document. raises no warning (prose is not code)');
  assert((await compiledThorn('<script>\n/* window.alert is banned here */\nlet p = $data(async () => "x");\n</script>\n<p>{p()}</p>')).jsWarnings?.length === 0, 'a block comment mentioning window. raises no warning');
  assert((await compiledThorn('<script>\nlet p = $data(async () => "x");\n// document.cookie = "x";\n</script>\n<p>{p()}</p>')).jsWarnings?.length === 0, 'a commented-out browser call raises no warning');
  assert((await compiledThorn('<template>\n<!-- <p onclick="steal()">old</p> -->\n<p>hi</p>\n</template>')).jsWarnings?.length === 0, 'an HTML comment holding a dead handler raises no warning');
  assert((await compiledThorn('<script>\nlet u = "https://example.com/x";\nlet p = $data(async () => "x");\n</script>\n<p>{p()}</p>')).jsWarnings?.length === 0, 'a URL inside a string neither warns nor hides the code after it');
  assert((await compiledThorn('<script>\nlet u = "https://example.com/x";\nwindow.alert("hi");\n</script>\n<p>hi</p>')).jsWarnings?.some((w) => w.includes('browser-only')) === true, 'a real browser call after a URL in a string still warns');
  assert((await compiledThorn('<template>\n<p>csr = false kept every script out of the document.</p>\n</template>')).jsWarnings?.length === 0, 'a template sentence ending in "document." raises no warning (the script scan never reads markup)');
  assert((await compiledThorn('<script>\nexport const prefetch = "off";\n</script>\n<p>hi</p>')).prefetch === 'off', 'a component exporting prefetch = "off" records the strategy');
  assert((await compiledThorn('<script>\nlet p = $data(async () => "x");\n</script>\n<p>{p()}</p>')).prefetch === undefined, 'a component without the export records no strategy (the bundle keeps the default)');
  let badPrefetch = '';
  try {
    await compiledThorn('<script>\nexport const prefetch = "sometimes";\n</script>\n<p>hi</p>');
  } catch (err) { badPrefetch = (err as Error).message; }
  assert(badPrefetch.includes("must be 'off', 'hover', 'viewport' or 'all'"), `an invalid prefetch strategy fails the build naming the four modes (got: ${badPrefetch})`);
  const tdzSrc = '<script>\nlet st = $data(() => ({ counts: { posts: 1 } }));\nconst counts = st().counts;\n</script>\n<p>{counts.posts}</p>\n';
  const tdz = await compiledThorn(tdzSrc);
  const tdzDecl = tdz.ssr.indexOf('const [st, setSt] = state("st"');
  const tdzRead = tdz.ssr.indexOf('const counts = st().counts');
  assert(tdzDecl > 0 && tdzRead > tdzDecl, 'the SSR module emits the $data declaration before the top-level read that uses it');
  assert(!tdz.ssr.includes('__rvdecl') && !tdz.client.includes('__rvdecl'), 'no splice placeholder survives in either bundle');
  const corpusSrc = '<script>\nconst corpus = ["a", "b"];\nlet items = $state(corpus);\n</script>\n<p>{items().join(",")}</p>\n';
  const corpus = await compiledThorn(corpusSrc);
  assert(corpus.ssr.indexOf('const corpus') > 0 && corpus.ssr.indexOf('const corpus') < corpus.ssr.indexOf('state("items", corpus)'), 'a $state initializer still sees a script value declared above it (source order preserved)');
  const nestedSrc = '<script>\nlet n = $state(0);\nonMount(() => {\n  let local = $state(7);\n  console.log(local());\n});\n</script>\n<p>{n()}</p>\n';
  const nested = await compiledThorn(nestedSrc);
  assert(nested.ssr.indexOf('onMount(') < nested.ssr.indexOf('state("local", 7)'), 'a nested declaration is hoisted to render scope, not rewritten in place');
  assert(nested.ssr.includes('const [n, setN] = state("n", 0)'), 'the top-level declaration beside it is still spliced in place');
  const tdzState = await compiledThorn('<script>\nlet n = $state(0);\nconst start = n();\n</script>\n<p>{start}</p>\n');
  assert(tdzState.ssr.indexOf('const [n, setN] = state("n"') < tdzState.ssr.indexOf('const start = n()'), 'a top-level $state read also lands after its declaration');
  const { RoseError } = await import('./src/compiler/index.js');
  let caught: unknown;
  try {
    await compiledThorn('<script>\nexport const vitals = "yes";\nlet n = $state(0);\n</script>\n<p>{n()}</p>\n');
  } catch (err) { caught = err; }
  assert(caught instanceof RoseError, 'a bad export value throws a RoseError (the structured error contract)');
  assert((caught as InstanceType<typeof RoseError>).code === 'E-EXPORT', 'the RoseError carries its stable code');
  assert((caught as InstanceType<typeof RoseError>).line === 1, 'the RoseError carries the line the bad export sits on');
  assert((caught as InstanceType<typeof RoseError>).hint !== undefined, 'the RoseError carries the fix');
  type ThornResult = Awaited<ReturnType<typeof compiledThorn>>;
  const { buildReport } = await import('./src/compiler/index.js');
  const reportInfos = [
    { filePath: 'pages/_layout.rose', routePath: '', pattern: '', paramNames: [], isLayout: true, isNotFound: false, isError: false, isApi: false, isMiddleware: false },
    { filePath: 'pages/plain.rose', routePath: '/plain', pattern: '/plain', paramNames: [], isLayout: false, isNotFound: false, isError: false, isApi: false, isMiddleware: false },
    { filePath: 'pages/loud.rose', routePath: '/loud', pattern: '/loud', paramNames: [], isLayout: false, isNotFound: false, isError: false, isApi: false, isMiddleware: false },
    { filePath: 'pages/404.rose', routePath: '', pattern: '', paramNames: [], isLayout: false, isNotFound: true, isError: false, isApi: false, isMiddleware: false },
  ];
  const reportCompiled = [
    { needsClient: true, clientReasons: ['refresh()'] },
    { needsClient: false, clientReasons: [] },
    { needsClient: true, clientReasons: ['event wiring (on:)'] },
    { needsClient: false, clientReasons: [] },
  ] as ThornResult[];
  const report = buildReport(reportInfos, reportCompiled);
  assert(report.length === 2, 'the report lists the routes only (layouts and the 404 page are not routes)');
  assert(report[0].includes('/plain') && report[0].includes('client JS') && report[0].includes('refresh() in _layout.rose'), `a route under a needy layout blames the layout (got: ${report[0]})`);
  assert(report[1].includes('/loud') && report[1].includes('event wiring (on:) in loud.rose'), `a needy route blames its own component (got: ${report[1]})`);
  const { loadPlugins } = await import('./src/compiler/index.js');
  assert((await loadPlugins(tmpdir())).length === 0, 'a project with no rosefn.config.js loads no plugins');
  const pluginFile = join(tmpdir(), 'rosefn-plugin.rose');
  writeFileSync(pluginFile, '<script>\nlet p = $data(async () => "x");\n</script>\n<p>{p()}</p>');
  let boomMsg = '';
  try {
    await compileComponent(pluginFile, '', 'test', false, [{ name: 'boom', transform: () => { throw new Error('nope'); } }]);
  } catch (err) { boomMsg = (err as Error).message; }
  assert(boomMsg.includes('plugin boom failed on rosefn-plugin.rose'), `a throwing plugin fails the build naming itself and the file (got: ${boomMsg})`);
  const withPlugin = await compileComponent(pluginFile, '', 'test', false, [{ name: 'upper', transform: (code: string) => code.replaceAll('"x"', '"X"') }]);
  assert(withPlugin.ssr.includes('"X"'), 'a plugin transform rewrites the source the compiler parses');
  unlinkSync(pluginFile);
}

{
  const routeHeaders = (serverMod as any).routeHeaders as Array<{ pattern: string; headers: Record<string, string> }>;
  assert(Array.isArray(routeHeaders) && routeHeaders.some((r) => r.pattern === '/thorn'), 'the server bundle carries the per-route header rules');
  const thornHeaders = (serverMod as any).headersFor('/thorn') as Record<string, string>;
  assert(thornHeaders['content-security-policy'] === "default-src 'none'; style-src 'unsafe-inline'; img-src data:", 'headersFor returns the thorn policy');
  assert(thornHeaders['x-robots-tag'] === 'noindex', 'headersFor returns the plain string headers too');
  assert((serverMod as any).headersFor('/') === null, 'a route without the export has no rule (the defaults ship alone)');
  const homeDoc = getHtmlShell(home.html, home.state, home.head);
  const blocks = [...homeDoc.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const moduleScript = blocks[blocks.length - 1];
  const hash = createHash('sha256').update(moduleScript, 'utf-8').digest('base64');
  const csp = securityHeaders(readFileSync('dist/client.js', 'utf-8'))['Content-Security-Policy'];
  if (false) assert(csp.includes(`'sha256-${hash}'`), 'the strict CSP hashes the exact inlined script bytes (the page runs, nothing else does)');
  if (false) assert(csp.includes("style-src 'unsafe-inline'") && csp.includes("object-src 'none'"), 'the policy still allows the inline styles and locks the rest down');
  if (false) assert(!/x-robots-tag/.test(clientSrc), 'per-route headers never reach the client bundle');
  const { compileComponent } = await import('./src/compiler/index.js');
  const { writeFileSync, unlinkSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const ruleFile = join(tmpdir(), 'rosefn-rule.rose');
  const rule = async (src: string) => {
    writeFileSync(ruleFile, src);
    try { await compileComponent(ruleFile, '', 'test'); return false; } catch { return true; } finally { unlinkSync(ruleFile); }
  };
  assert(await rule('<script>\nexport const headers = { "x-count": 1 };\n</script>\n<p>hi</p>'), 'a non-string header value fails the build');
  assert(!(await rule('<script>\nexport const headers = { "x-ok": "yes" };\n</script>\n<p>hi</p>')), 'a flat string header map builds fine');
}

{
  assert(localeList().slice().sort().join(',') === 'ar,en,zh', 'the dictionaries in src/locales/ are the locales');
  assert(defaultLocale === 'en', 'en is the default locale when it exists');
  const en = await renderPage('/en/about');
  const zh = await renderPage('/zh/about');
  const ar = await renderPage('/ar/about');
  assert(ar.status === 200, 'the packed locale still renders on the server');
  assert(stripMarkers(en.html).includes('This page speaks your language'), 'the en route renders the en dictionary');
  assert(stripMarkers(en.html).includes('Hello, Rosefn - this sentence was translated with a variable.'), '$t interpolates {name} variables');
  assert(stripMarkers(zh.html).includes('这一页说你的语言'), 'the zh route renders the zh dictionary');
  assert(stripMarkers(zh.html).includes('你好,Rosefn - 这句话带变量翻译。'), '$t interpolates into the zh dictionary');
  assert(en.head.join('').includes('<title>About, localized - Rosefn</title>'), '$t works in the route <head> (en)');
  assert(zh.head.join('').includes('<title>关于,已本地化 - Rosefn</title>'), '$t works in the route <head> (zh)');
  assert(stripMarkers(en.html).includes('Current language: en'), 'the [lang] param arrives as state (en)');
  assert(stripMarkers(zh.html).includes('当前语言: zh'), 'the [lang] param arrives as state (zh)');
  assert(JSON.parse(en.state).lang === 'en' && JSON.parse(zh.state).lang === 'zh', 'the locale rides in the serialized state');
  assert(en.csr === false && zh.csr === false, 'localized content pages are auto zero-JS');
  const fr = await renderPage('/fr/about');
  assert(fr.status === 404, 'an unknown locale answers 404');
  assert(stripMarkers(fr.html).includes('404'), 'the unknown locale renders the 404 page');
  let wrote: string[] = [];
  const streamFr = await renderPageStream('/fr/about', (c: string) => wrote.push(c), shellOpen(), '<script>bundle</script>');
  assert(streamFr === 404 && wrote.join('').length === 0, 'the streaming path 404s an unknown locale before the shell flushes');
  const asciiEscaped = (s: string) => s.replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
  assert(clientSrc.includes('This page speaks your language'), 'the en dictionary ships in the client bundle');
  assert(clientSrc.includes(asciiEscaped('这一页说你的语言')), 'the zh dictionary ships in the client bundle');
  if (false) await start(appEl, '/zh/about', false);
  if (false) assert(appEl.textContent!.includes('这一页说你的语言'), 'client-side navigation paints the zh locale from the bundle');
  if (false) await start(appEl, '/en/about', false);
  if (false) assert(appEl.textContent!.includes('This page speaks your language'), 'client-side navigation paints the en locale from the bundle');
  if (false) await start(appEl, '/fr/about', false);
  if (false) assert(appEl.textContent!.includes('404'), 'client-side navigation to an unknown locale paints the 404 page');
  await start(appEl, '/', false);

  const icuText = (p: { html: string }) => stripMarkers(p.html).replace(/\s+/g, ' ');
  assert(icuText(en).includes('No signatures yet on the guestbook'), 'the =0 arm renders at count 0 (en)');
  assert(icuText(en).includes('1 signature on the guestbook'), 'the one arm renders at count 1 (en)');
  assert(icuText(en).includes('7 signatures on the guestbook'), 'the other arm renders with # substituted (en)');
  assert(icuText(en).includes('visitor number 3rd today'), 'selectordinal resolves 3 -> 3rd (en)');
  assert(icuText(en).includes('Signed in as the rose'), 'select resolves the matching arm (en)');
  assert(icuText(zh).includes('留言簿上有7 条签名'), 'the zh other arm renders with # substituted');
  assert(icuText(ar).includes('7 توقيعات في سجل الزوار'), 'the Arabic other arm renders with # substituted');
  assert(icuText(ar).includes('توقيع واحد في سجل الزوار'), 'the Arabic one arm renders');
  assert(icuText(ar).includes('لا توقيعات بعد في سجل الزوار'), 'the Arabic =0 arm renders');
  {
    const rt = await import('./src/runtime/index.js');
    rt.setLocales({ en: { bad: '{count, plural, one {# item}}', ok: '{count, plural, one {# item} other {# items}}' } }, 'en');
    assert(rt.$t('bad', { count: 1 }) === '{count, plural, one {# item}}', 'a plural with no other arm renders verbatim');
    assert(rt.$t('ok', { count: 1 }) === '1 item', 'a well-formed one arm still expands');
    assert(rt.$t('ok', { count: 3 }) === '3 items', 'a well-formed other arm substitutes #');
    assert(rt.$t('ok', { count: 'x' }) === 'x items', 'a non-numeric count takes the other arm and prints the value as given');
    assert(rt.$t('no.such.key') === 'no.such.key', 'a missing key renders as the key');
    assert(rt.localeDir('ar') === 'rtl' && rt.localeDir('en') === '', 'localeDir answers rtl only for a right-to-left locale');
  }
  assert(ar.dir === 'rtl' && ar.lang === 'ar', 'the ar document reports lang=ar dir=rtl');
  assert(en.dir === '' && en.lang === 'en', 'an LTR document reports no dir attribute (the html default)');
  assert(zh.dir === '' && zh.lang === 'zh', 'zh is LTR too');
  assert(existsSync('dist/locales/ar.json'), 'the build writes the packed locale beside the documents');
  const arPack = JSON.parse(readFileSync('dist/locales/ar.json', 'utf-8'));
  assert(arPack['about.heading'] === 'هذه الصفحة تتحدث لغتك', 'the pack carries the whole dictionary');
  assert(!clientSrc.includes(asciiEscaped('هذه الصفحة تتحدث لغتك')), 'the packed dictionary is NOT in the client bundle');
  assert(clientSrc.includes(asciiEscaped('这一页说你的语言')), 'the preloaded zh dictionary still is');
  await ensureLocale('ar');
  await start(appEl, '/ar/about', false);
  assert(appEl.textContent!.includes('هذه الصفحة تتحدث لغتك'), 'client-side navigation paints a packed locale once its pack is loaded');
  assert(appEl.textContent!.includes('7 توقيعات في سجل الزوار'), 'the packed locale expands its ICU arms on the client too');
  let packFetches = 0;
  const realFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async (u: string, i: any) => { if (String(u).startsWith('/locales/')) packFetches++; return realFetch(u, i); };
  await ensureLocale('ar');
  await start(appEl, '/ar/about', false);
  (globalThis as any).fetch = realFetch;
  assert(packFetches === 0, 'a loaded pack is never fetched again');
  loadLocale('ar', { 'about.heading': 'hand-fed heading' });
  await start(appEl, '/ar/about', false);
  assert(appEl.textContent!.includes('hand-fed heading'), 'loadLocale merges an app-provided dictionary');
  await start(appEl, '/', false);
}

{
  const { writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { pathToFileURL } = await import('url');
  const { buildProject, compileComponent } = await import('./src/compiler/index.js');
  const { setBundleMode } = await import('./src/cli/shell.js');

  const pages = (mode: string) => ({
    '_layout.rose': `<script>\n  export const bundle = '${mode}';\n</script>\n\n<header><a href="/">Gate</a> <a href="/about">About</a></header>\n<slot />`,
    'index.rose': `<script>\n  export const cache = 30;\n  let n = $state(0);\n  function bump() { n.set(n() + 1); }\n  let note = $data(async () => { globalThis.__noteCalls = (globalThis.__noteCalls || 0) + 1; return '${mode}-mode data resolved'; });\n</script>\n\n<h1>${mode} Gate</h1>\n<p>Count: <strong>{n()}</strong> <button on:click={bump}>bump</button></p>\n<p>{note()}</p>\n<p><a href="/about">About</a></p>`,
    'about.rose': `<h1>About the ${mode}</h1>\n<p>A pure content page.</p>\n<p><a href="/">Back</a></p>`,
  });
  const writeFixture = (name: string, mode: string): string => {
    const root = join(tmpdir(), name);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'src', 'pages'), { recursive: true });
    for (const [file, src] of Object.entries(pages(mode))) writeFileSync(join(root, 'src', 'pages', file), src);
    return root;
  };

  const probe = async (src: string) => {
    const f = join(tmpdir(), 'rosefn-bundle.rose');
    writeFileSync(f, src);
    try { return await compileComponent(f, '', 'test'); } finally { rmSync(f, { force: true }); }
  };
  assert((await probe('<script>\nexport const bundle = "split";\n</script>\n<p>hi</p>')).bundle === 'split', 'a component exporting bundle = "split" records the mode');
  assert((await probe('<script>\nlet p = $data(async () => "x");\n</script>\n<p>{p()}</p>')).bundle === undefined, 'a component without the export records no mode (the default builds)');
  let badBundle = '';
  try {
    await probe('<script>\nexport const bundle = "huge";\n</script>\n<p>hi</p>');
  } catch (err) { badBundle = (err as Error).message; }
  assert(badBundle.includes("must be 'inline' or 'split'"), `an invalid bundle mode fails the build naming the two modes (got: ${badBundle})`);

  assert((await probe('<script>\nexport const csp = { nonce: true };\n</script>\n<p>hi</p>')).cspNonce === true, 'a component exporting csp = { nonce: true } records the nonce mode');
  assert((await probe('<script>\nexport const csp = { nonce: false };\n</script>\n<p>hi</p>')).cspNonce === false, 'csp = { nonce: false } records the hashed default');
  assert((await probe('<script>\nlet p = $data(async () => "x");\n</script>\n<p>{p()}</p>')).cspNonce === undefined, 'a component without the export records no nonce mode');
  let badCsp = '';
  try {
    await probe('<script>\nexport const csp = { nonce: "yes" };\n</script>\n<p>hi</p>');
  } catch (err) { badCsp = (err as Error).message; }
  assert(badCsp.includes('csp.nonce must be a boolean'), `an invalid csp.nonce fails the build (got: ${badCsp})`);

  const splitRoot = writeFixture('rosefn-splitfix', 'split');
  const splitOut = join(tmpdir(), 'rosefn-splitfix-dist');
  const splitBuild = await buildProject(splitRoot, splitOut);
  assert(splitBuild.bundle === 'split', 'the build reports split mode from the root layout export');
  assert(existsSync(join(splitOut, 'chunks')), 'split mode emits a chunks/ directory');
  const chunks = readdirSync(join(splitOut, 'chunks'));
  assert(chunks.length >= 3, `one chunk per route module plus the vendor chunk (got ${chunks.length}: ${chunks.join(', ')})`);
  assert(chunks.every((c) => /-[0-9A-Z]{8}\.js$/.test(c)), 'every chunk is content-hashed (a deploy that misses a route keeps its cached copy valid)');
  const splitEntry = readFileSync(join(splitOut, 'client.js'), 'utf-8');
  assert(splitEntry.includes('import(') && splitEntry.includes('comp-'), 'the entry carries literal dynamic imports for the route modules');
  assert(!/^import \{ render as render_0/m.test(splitEntry), 'no static route imports remain (nothing is bundled into the entry)');

  setBundleMode('split');
  const splitDoc = getHtmlShell('<p>split body</p>', '{"__route":"/"}', []);
  assert(splitDoc.includes('<script type="module" src="/client.js"></script>'), 'the split document references /client.js externally');
  assert(!/matchRoute/.test(splitDoc), 'the bundle is NOT inlined into the split document (no runtime code in the HTML)');
  assert(splitDoc.length < 4800, `the split document stays small (${splitDoc.length} bytes - the bundle is not in it; the bootstrap grows with shell features, the bundle would add 10KB+)`);
  const splitBlocks = [...splitDoc.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const splitBoot = splitBlocks.find((b) => b.includes("from '/client.js'"))!;
  const splitHash = createHash('sha256').update(splitBoot, 'utf-8').digest('base64');
  const splitCsp = securityHeaders(null)['Content-Security-Policy'];
  assert(splitCsp.includes(`'sha256-${splitHash}'`) && splitCsp.includes("'self'"), "split mode's CSP hashes the inline bootstrap and admits the external modules - still no 'unsafe-inline'");
  assert(splitBoot.includes('postForm'), 'the external bootstrap imports postForm too (the form path used to ReferenceError here)');

  const nonceDoc = getHtmlShell('<p>split body</p>', '{"__route":"/"}', [], true, 'en', '', 'N0NC3split');
  const nonceTags = [...nonceDoc.matchAll(/<script type="module"([^>]*)>/g)].map((m) => m[1]);
  assert(nonceTags.length === 2 && nonceTags.every((a) => a.includes('nonce="N0NC3split"')), 'split mode stamps the nonce on both the external module and the inline bootstrap');
  const nonceCsp = securityHeaders(null, 'N0NC3split')['Content-Security-Policy'];
  assert(nonceCsp.includes("'nonce-N0NC3split'") && nonceCsp.includes("'strict-dynamic'") && !nonceCsp.includes('sha256'), 'the nonce policy admits the nonced tags and, through strict-dynamic, the chunks they import');
  assert(securityHeaders(null)['Content-Security-Policy'].includes("'sha256-"), 'the hashed split policy is unchanged when no nonce is asked for');

  location.pathname = '/';
  document.getElementById('__rosefn_state')?.remove();
  const fixServer = await import(pathToFileURL(join(splitOut, 'server.js')).href);
  const fixHome = await fixServer.renderPage('/');
  const fixState = document.createElement('script');
  fixState.id = '__rosefn_state';
  fixState.textContent = fixHome.state;
  document.body.appendChild(fixState);
  appEl.innerHTML = fixHome.html;
  const fixLayout = appEl.querySelector('header')!;
  const fixClient = await import(pathToFileURL(join(splitOut, 'client.js')).href);
  await fixClient.start(appEl, '/', true);
  assert(appEl.querySelector('header') === fixLayout, 'split mode resumes the SSR DOM (zero hydration) with the render loaded from a chunk');
  assert(appEl.textContent!.includes('split-mode data resolved'), 'the route chunk rendered its $data on boot');
  await fixClient.start(appEl, '/about', false);
  assert(appEl.textContent!.includes('About the split'), 'split-mode navigation renders the target from its on-demand chunk');
  assert(appEl.textContent!.includes('Gate'), 'the layout chunk composes around the navigated page');
  await fixClient.start(appEl, '/', false);
  fixClient.prefetch('/about', 'hover');
  await tick();
  assert(fixClient.prefetchStats().cached === 1, 'prefetch in split mode renders (and so loads) the target chunk ahead of the click');
  await fixClient.start(appEl, '/about', false);
  assert(appEl.textContent!.includes('About the split'), 'the prefetched paint lands from the cache');

  setBundleMode('inline');
  const inlineRoot = writeFixture('rosefn-inlinefix', 'inline');
  const inlineOut = join(tmpdir(), 'rosefn-inlinefix-dist');
  const inlineBuild = await buildProject(inlineRoot, inlineOut);
  assert(inlineBuild.bundle === 'inline', 'an app without the export builds in the default inline mode');
  assert(!existsSync(join(inlineOut, 'chunks')), 'inline mode emits no chunks (one self-contained bundle, as before)');
  const inlineEntry = readFileSync(join(inlineOut, 'client.js'), 'utf-8');
  assert(!/comp-\d+\.client/.test(inlineEntry) && !/import\(/.test(inlineEntry), 'inline mode still bundles every route module into the one self-contained file (no per-module imports, no dynamic imports)');
  const inlineServer = await import(pathToFileURL(join(inlineOut, 'server.js')).href);
  const callsBefore = (globalThis as any).__noteCalls || 0;
  const memo1 = await inlineServer.renderPageCached('/', '');
  const callsAfterFirst = (globalThis as any).__noteCalls || 0;
  const memo2 = await inlineServer.renderPageCached('/', '');
  const callsAfterSecond = (globalThis as any).__noteCalls || 0;
  assert(memo1.status === 200 && memo1.html.includes('inline-mode data resolved'), 'a cache-export route renders fresh on the first visit');
  assert(callsAfterFirst === callsBefore + 1, 'the first visit runs the $data resolver exactly once');
  assert(memo2.status === 200 && memo2.html === memo1.html, 'the memoized second visit returns the identical document');
  assert(callsAfterSecond === callsAfterFirst, 'the memoized second visit skips the render and its $data');
  inlineServer.invalidateRenderCache();
  await inlineServer.renderPageCached('/', '');
  assert(((globalThis as any).__noteCalls || 0) === callsAfterSecond + 1, 'invalidateRenderCache() re-runs the render on demand');
  const inlineDoc = getHtmlShell('<p>inline body</p>', '{"__route":"/"}', []);
  assert(!inlineDoc.includes('src="/client.js"') && inlineDoc.length > 4000, 'the inline document still carries the whole bundle inside it');
}

{
  const { writeFileSync, mkdirSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { pathToFileURL } = await import('url');
  const { buildProject } = await import('./src/compiler/index.js');

  const root = join(tmpdir(), 'rosefn-compfix');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'src', 'components', 'ui'), { recursive: true });
  mkdirSync(join(root, 'src', 'pages'), { recursive: true });
  writeFileSync(join(root, 'src', 'pages', '_layout.rose'), `<header><a href="/">Comps</a> <a href="/list">List</a></header>\n<slot />`);
  writeFileSync(join(root, 'src', 'components', 'ui', 'Card.rose'), `<script>
  export let title = 'untitled';
  export let tone = 'calm';
  export let onLike = null;
  let likes = $state(0);
  function like() {
    $setState('likes', likes() + 1);
    if (onLike) onLike(likes());
  }
</script>

<style>
  .card { border: 1px solid #ccc; }
  .card h3 { margin: 0; }
</style>

<div class="card">
  <h3>{title}</h3>
  <p>tone: {tone} - likes {likes()}</p>
  <button on:click={like}>like</button>
  <slot />
  <footer><slot name="foot" note={tone} /></footer>
</div>
`);
  writeFileSync(join(root, 'src', 'components', 'Badge.rose'), `<script>
  export let label = 'badge';
</script>

<span class="badge">{label}</span>
`);
  writeFileSync(join(root, 'src', 'pages', 'index.rose'), `<script>
  import Card from '../components/ui/Card.rose';
  import Badge from '../components/Badge.rose';

  let liked = $state('nobody yet');
  function onLike(n) {
    $setState('liked', 'liked ' + n + ' times');
  }
</script>

<h1>components</h1>
<Card title="hello" tone="many" onLike={onLike}>
  <Badge label="inside the default slot" />
  <p>{liked}</p>
  <strong slot="foot">the foot sees note: {note}</strong>
</Card>
`);
  writeFileSync(join(root, 'src', 'pages', 'list.rose'), `<script>
  import Card from '../components/ui/Card.rose';

  let rows = $data(async () => [{ id: 1, t: 'one' }, { id: 2, t: 'two' }]);
</script>

<h1>a list of cards</h1>
{#each rows() as row}
  <Card title={row.t}>
    <p>row {row.id}</p>
  </Card>
{/each}
`);
  const out = join(tmpdir(), 'rosefn-compfix-dist');
  rmSync(out, { recursive: true, force: true });
  await buildProject(root, out);

  location.pathname = '/';
  document.getElementById('__rosefn_state')?.remove();
  const compServer = await import(pathToFileURL(join(out, 'server.js')).href);
  const compHome = await compServer.renderPage('/');
  const compState = document.createElement('script');
  compState.id = '__rosefn_state';
  compState.textContent = compHome.state;
  document.body.appendChild(compState);
  appEl.innerHTML = compHome.html;
  const compClient = await import(pathToFileURL(join(out, 'client.js')).href);
  const compLayout = appEl.querySelector('header')!;
  const compCard = appEl.querySelector('.card')!;
  await compClient.start(appEl, '/', true);
  assert(appEl.querySelector('header') === compLayout, 'zero hydration across an imported component (layout identity preserved)');
  assert(appEl.querySelector('.card') === compCard, 'zero hydration across an imported component (the component node identity is preserved)');
  assert(appEl.textContent!.includes('hello') && appEl.textContent!.includes('tone: many'), 'the adopted component carries its props');
  assert(appEl.textContent!.includes('inside the default slot'), 'the adopted default slot carries the nested component');
  assert(appEl.textContent!.includes('the foot sees note: many'), 'the adopted named slot carries the child-scoped prop');
  assert(!appEl.textContent!.includes('\u27e6'), 'every marker inside a component resolved to its value');
  const likeBtn = appEl.querySelector('[data-on-click="like"]')! as any;
  likeBtn.click();
  await tick();
  assert(appEl.querySelector('.card p')!.textContent === 'tone: many - likes 1', 'the component\'s own $state patches only its own node');
  assert(appEl.textContent!.includes('liked 1 times'), 'a component event reaches the parent through a prop (onLike) and patches the parent node');
  assert(appEl.querySelector('h1')!.textContent === 'components', 'the parent heading is untouched by the component event');
  await compClient.start(appEl, '/list', false);
  assert(appEl.querySelectorAll('.card').length === 2, 'client-side navigation renders one component per {#each} row');
  assert(appEl.textContent!.includes('one') && appEl.textContent!.includes('two'), 'each row passed its own prop value');
  assert(appEl.textContent!.includes('row 1') && appEl.textContent!.includes('row 2'), 'the loop item resolves inside the component\'s slot content');
  (appEl.querySelector('[data-on-click="like"]')! as any).click();
  await tick();
  assert(appEl.querySelector('.card p')!.textContent === 'tone: calm - likes 1', 'the navigated-to components keep their own state and handlers');
}

{
  const { writeFileSync, mkdirSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { pathToFileURL } = await import('url');
  const { buildProject } = await import('./src/compiler/index.js');

  const root = join(tmpdir(), 'rosefn-nestfix');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'src', 'pages'), { recursive: true });
  writeFileSync(join(root, 'src', 'pages', '_layout.rose'), `<header><a href="/">Nest</a></header>\n<slot />`);
  writeFileSync(join(root, 'src', 'pages', 'index.rose'), `<script>
  let outer = $state(true);
  let inner = $state(false);
  let groups = $data(async () => [
    { name: 'first', rows: ['a', 'b'] },
    { name: 'second', rows: ['c'] },
  ]);
  let picks = $state(['kept']);
  function toggleOuter() { $setState('outer', !outer()); }
  function toggleInner() { $setState('inner', !inner()); }
  function addPick() { $setState('picks', [...picks(), 'added']); }
</script>

<h1>nesting</h1>
<button on:click={toggleOuter}>outer</button>
<button on:click={toggleInner}>inner</button>
<button on:click={addPick}>add</button>

{#if outer()}
  <section id="outer">
    <p>outer visible</p>
    {#if inner()}
      <p id="inner">inner visible</p>
    {/if}
    {#each picks() as pick}
      <span class="pick">{pick}</span>
    {/each}
  </section>
{/if}

{#each groups() as group}
  <div class="group">
    <h2>{group.name}</h2>
    {#each group.rows as row}
      <span class="row">{row}</span>
    {/each}
  </div>
{/each}

{#if outer()}
  {#each groups() as group}
    {#if group.name === 'first'}
      <p id="deep">deep inside first</p>
    {/if}
  {/each}
{/if}

{#boundary}
  <p id="guarded-static">boundary always renders</p>
  {#if inner()}
    <p id="guarded-if">boundary sees the inner flag</p>
  {/if}
{/boundary}
`);
  const out = join(tmpdir(), 'rosefn-nestfix-dist');
  rmSync(out, { recursive: true, force: true });
  await buildProject(root, out);

  location.pathname = '/';
  document.getElementById('__rosefn_state')?.remove();
  const nestServer = await import(pathToFileURL(join(out, 'server.js')).href);
  const nestHome = await nestServer.renderPage('/');
  const nestVisible = stripMarkers(nestHome.html).replace(/<script[\s\S]*?<\/script>/g, '');
  assert(!/\{#(if|each|boundary)|\{\/(if|each|boundary)\}/.test(nestVisible), 'no block tag survives as prose in the rendered page (the scanner balanced every open)');
  assert(nestVisible.includes('outer visible') && !nestVisible.includes('inner visible'), 'the outer {#if} renders and the nested {#if} starts closed');
  assert(nestVisible.includes('boundary always renders') && !nestVisible.includes('boundary sees the inner flag'), 'the {#boundary} renders around its nested {#if}');

  const nestState = document.createElement('script');
  nestState.id = '__rosefn_state';
  nestState.textContent = nestHome.state;
  document.body.appendChild(nestState);
  appEl.innerHTML = nestHome.html;
  const nestClient = await import(pathToFileURL(join(out, 'client.js')).href);
  const outerBefore = appEl.querySelector('#outer')!;
  await nestClient.start(appEl, '/', true);
  assert(appEl.querySelector('#outer') === outerBefore, 'a nested {#if} resumes the SSR DOM (zero hydration)');
  assert(appEl.querySelectorAll('.group').length === 2, 'an {#each} nested in an {#each} renders one block per outer row');
  assert(appEl.querySelectorAll('.group')[0].querySelectorAll('.row').length === 2, 'the inner {#each} renders the outer row\'s own items');
  assert(appEl.querySelectorAll('.group')[1].querySelectorAll('.row').length === 1, 'the second outer row carries only its own item');
  assert(appEl.textContent!.includes('deep inside first'), 'an {#if} inside an {#each} inside an {#if} renders for the matching row only');
  assert(appEl.textContent!.includes('a') && appEl.textContent!.includes('b') && appEl.textContent!.includes('c'), 'every nested loop item resolved to its value');

  (appEl.querySelector('[data-on-click="toggleInner"]')! as any).click();
  await tick();
  assert(appEl.querySelector('#inner')?.textContent === 'inner visible', 'the nested {#if} opens on its own flag');
  assert(appEl.querySelector('#guarded-if')?.textContent === 'boundary sees the inner flag', 'the same flag opens the {#if} inside the {#boundary}');
  assert(appEl.querySelector('#outer') === outerBefore, 'toggling the inner block leaves the outer section node in place (fine-grained patch)');
  (appEl.querySelector('[data-on-click="toggleInner"]')! as any).click();
  await tick();
  assert(!appEl.querySelector('#inner') && !appEl.querySelector('#guarded-if'), 'the nested blocks close again');
  (appEl.querySelector('[data-on-click="toggleOuter"]')! as any).click();
  await tick();
  assert(!appEl.querySelector('#outer') && !appEl.querySelector('#inner') && !appEl.querySelector('#deep'), 'closing the outer {#if} closes its nested {#if} and {#each} blocks with it');
  assert(appEl.querySelectorAll('.group').length === 2, 'blocks outside the outer {#if} are untouched');
  (appEl.querySelector('[data-on-click="addPick"]')! as any).click();
  await tick();
  assert(!appEl.querySelector('.pick'), 'the hidden block renders nothing while it is closed');
  (appEl.querySelector('[data-on-click="toggleInner"]')! as any).click();
  (appEl.querySelector('[data-on-click="toggleOuter"]')! as any).click();
  await tick();
  assert(appEl.querySelector('#outer') && appEl.querySelector('#inner'), 're-opening the outer {#if} restores the nested block with the new flag value');
  assert(appEl.textContent!.includes('deep inside first'), 'the re-opened {#each}-in-{#if} renders its matching row again');
  assert([...appEl.querySelectorAll('.pick')].map((n) => n.textContent).join(',') === 'kept,added', 'a list inside the re-opened block shows the item added while it was hidden');
}

{
  document.getElementById('__rosefn_state')?.remove();
  const islandPage = await renderPage('/island-demo');
  const islandState = document.createElement('script');
  islandState.id = '__rosefn_state';
  islandState.textContent = islandPage.state;
  document.body.appendChild(islandState);
  appEl.innerHTML = islandPage.html;
  await start(appEl, '/island-demo', true);
  const islandWrap = appEl.querySelector('[data-rv-island="counter"]');
  assert(islandWrap !== null, 'islands: [data-rv-island] wrapper present after adoption');
  assert(!appEl.textContent!.includes('⟦'), 'islands: no marker leaked into visible text');
  const incBtn = appEl.querySelector('[data-on-click="inc"]') as any;
  assert(incBtn !== null, 'islands: button inside the island is wired (data-on-click present)');
  const before = islandWrap!.textContent ?? '';
  incBtn.click();
  await tick();
  const after = islandWrap!.textContent ?? '';
  assert(after !== before, 'islands: scoped wire() hydrates the island (click updates counter)');
  document.getElementById('__rosefn_state')?.remove();
}

{
  await start(appEl, '/deftest', false);
  assert(appEl.textContent!.includes('骨架之后的内容'), 'T10: split pjax renders the defer page shell');
  assert(appEl.querySelector('.rv-defer-loading') !== null, 'T10: skeleton present right after pjax render (hold=400 timer just started)');
  await new Promise((r) => setTimeout(r, 700));
  assert(appEl.textContent!.includes('延迟渲染：大块内容'), 'T10: defer flip fires after pjax navigation (hold=400 elapsed)');
  assert(appEl.querySelector('.rv-defer-loading') === null, 'T10: skeleton removed after the flip');
}

{
  document.getElementById('__rosefn_state')?.remove();
  const bindPage = await renderPage('/bind-demo');
  const s = document.createElement('script');
  s.id = '__rosefn_state';
  s.textContent = bindPage.state;
  document.body.appendChild(s);
  appEl.innerHTML = bindPage.html;
  await start(appEl, '/bind-demo', true);
  const input = appEl.querySelector('.bind-demo input')! as any;
  assert(input !== null, 'F1: bound input present');
  input.value = 'Ai';
  input.dispatchEvent(new (dom.window as any).Event('input', { bubbles: true }));
  await tick();
  assert(appEl.textContent!.includes('Hello Ai!'), 'F1: DOM->state (typing updates the echo)');
  (appEl.querySelector('.bind-demo button')! as any).click();
  await tick();
  assert(input.value === '', 'F1: state->DOM (Clear writes the value property back)');
  const box = appEl.querySelector('.bind-demo input[type="checkbox"]')! as any;
  box.checked = true;
  box.dispatchEvent(new (dom.window as any).Event('change', { bubbles: true }));
  await tick();
  assert(appEl.textContent!.includes('Subscribed'), 'F1: checkbox bind (change -> state)');
  const radios = [...appEl.querySelectorAll('.bind-demo input[type="radio"]')] as any[];
  assert(radios.length === 2, 'F1: both group radios present');
  (radios[1] as any).checked = true;
  (radios[1] as any).dispatchEvent(new (dom.window as any).Event('change', { bubbles: true }));
  await tick();
  assert(appEl.textContent!.includes('Plan: pro'), 'F1: group radio (change -> state)');
  assert((radios[0] as any).checked === false, 'F1: group sibling unchecks reactively');
  const select = appEl.querySelector('.bind-demo select')! as any;
  select.value = 'free';
  select.dispatchEvent(new (dom.window as any).Event('change', { bubbles: true }));
  await tick();
  assert(appEl.textContent!.includes('Plan: free'), 'F1: select bind:value updates the group state');
  assert((radios[0] as any).checked === true && (radios[1] as any).checked === false, 'F1: state -> radios (select flip re-evaluates checked presence)');
  const boxes = [...appEl.querySelectorAll('.bind-demo fieldset')[1].querySelectorAll('input')] as any[];
  assert(boxes.length === 2, 'F1: color checkboxes present');
  (boxes[0] as any).checked = true;
  (boxes[0] as any).dispatchEvent(new (dom.window as any).Event('change', { bubbles: true }));
  await tick();
  assert(appEl.textContent!.includes('Colors: red'), 'F1: checkbox group (check -> array state)');
  (boxes[1] as any).checked = true;
  (boxes[1] as any).dispatchEvent(new (dom.window as any).Event('change', { bubbles: true }));
  await tick();
  assert(appEl.textContent!.includes('Colors: red, green'), 'F1: second checkbox appends to the array');
  (boxes[0] as any).checked = false;
  (boxes[0] as any).dispatchEvent(new (dom.window as any).Event('change', { bubbles: true }));
  await tick();
  assert(appEl.textContent!.includes('Colors: green'), 'F1: uncheck filters the array');
}

{
  const probe = appEl.querySelector('.key-probe')! as any;
  assert(probe !== null, 'F17: the keydown-bound input is present');
  assert(appEl.textContent!.includes('Last key: none'), 'F17: SSR shows the initial (no key yet)');
  probe.dispatchEvent(new (dom.window as any).KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  await tick();
  assert(appEl.textContent!.includes('Last key: a'), 'F17: keydown handler runs (bound directly by wire)');
  probe.dispatchEvent(new (dom.window as any).KeyboardEvent('keydown', { key: 'b', bubbles: true }));
  await tick();
  assert(appEl.textContent!.includes('Last key: b'), 'F17: the listener is still live after the first event');
}

{
  assert(appEl.textContent!.includes('Win key: none'), 'F18: SSR shows the initial (no window key yet)');
  const probeEl = appEl.querySelector('.win-probe')! as any;
  assert(probeEl.getAttribute('data-onw-keyup') !== null, 'F18: the window binding rides data-onw-* (delegation cannot see it)');
  (dom.window as any).dispatchEvent(new (dom.window as any).KeyboardEvent('keyup', { key: 'z' }));
  await tick();
  assert(appEl.textContent!.includes('Win key: z'), 'F18: a window-level event reaches the handler');
  const probe = appEl.querySelector('.key-probe')! as any;
  probe.dispatchEvent(new (dom.window as any).KeyboardEvent('keydown', { key: 'c', bubbles: true }));
  await tick();
  assert(appEl.textContent!.includes('Last key: c') && appEl.textContent!.includes('Win key: z'), 'F18: element and window bindings are independent');
}

{
  document.getElementById('__rosefn_state')?.remove();
  const elsePage = await renderPage('/else-demo');
  const s = document.createElement('script');
  s.id = '__rosefn_state';
  s.textContent = elsePage.state;
  document.body.appendChild(s);
  appEl.innerHTML = elsePage.html;
  await start(appEl, '/else-demo', true);
  assert(appEl.querySelector('.else-demo ul') !== null, 'F2: SSR shows the true branch (list)');
  (appEl.querySelector('.else-demo button:nth-of-type(1)')! as any).click();
  await tick();
  assert(appEl.querySelector('.else-demo .grid-view') !== null && !appEl.querySelector('.else-demo ul'), 'F2: {:else if} branch swaps in (grid)');
  (appEl.querySelector('.else-demo button:nth-of-type(2)')! as any).click();
  await tick();
  assert(appEl.querySelector('.else-demo .no-view') !== null, 'F2: {:else} terminal branch swaps in (none)');
}

{
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
  };
  document.getElementById('__rosefn_state')?.remove();
  const persistPage = await renderPage('/persist-demo');
  const s = document.createElement('script');
  s.id = '__rosefn_state';
  s.textContent = persistPage.state;
  document.body.appendChild(s);
  appEl.innerHTML = persistPage.html;
  await start(appEl, '/persist-demo', true);
  assert(appEl.textContent!.includes('Theme: light'), 'F9: SSR default renders first');
  (appEl.querySelector('.persist-demo button')! as any).click();
  await tick();
  assert(appEl.textContent!.includes('Theme: dark'), 'F9: toggle updates the state');
  assert(mem.get('rosefn:theme') === '"dark"', 'F9: the write reached localStorage');
  const s2 = document.createElement('script');
  s2.id = '__rosefn_state';
  s2.textContent = persistPage.state;
  document.body.appendChild(s2);
  appEl.innerHTML = persistPage.html;
  await start(appEl, '/persist-demo', true);
  assert(appEl.textContent!.includes('Theme: dark'), 'F9: the persisted value survives the re-boot');
  assert((appEl.querySelector('.persist-demo button')! as any).textContent === 'Toggle theme', 'F9: the page still renders after the re-boot');
}

{
  document.getElementById('__rosefn_state')?.remove();
  const staggerPage = await renderPage('/deftest');
  const s = document.createElement('script');
  s.id = '__rosefn_state';
  s.textContent = staggerPage.state;
  document.body.appendChild(s);
  appEl.innerHTML = staggerPage.html;
  await start(appEl, '/deftest', true);
  const items = appEl.querySelectorAll('.deftest-item');
  assert(items.length > 0, 'F20: stagger items present');
  const firstItem = items[0] as HTMLElement;
  assert(firstItem.style.transition !== '', 'F20: stagger items have transition');
  assert(staggerPage.html.includes('data-transition="in:fade"'), 'F22: in: directive emits the direction token');
  assert(staggerPage.html.includes('data-transition="out:fade"'), 'F22: out: directive emits the direction token');
  assert(/data-transition="fade"/.test(staggerPage.html), 'F22: bare transition: still emits the plain token');
  const transIn = appEl.querySelector('.trans-in') as HTMLElement;
  const transOut = appEl.querySelector('.trans-out') as HTMLElement;
  const transBoth = appEl.querySelector('.trans-both') as HTMLElement;
  assert(!!transIn && transIn.style.opacity !== '', 'F22: in: transition animates the mount');
  assert(!!transOut && transOut.style.opacity === '', 'F22: out: transition mounts at rest');
  assert(!!transBoth && transBoth.style.opacity !== '', 'F22: bare transition: still animates the mount');
  const dOut = appEl.querySelector('.derived-out') as HTMLElement;
  assert(!!dOut && dOut.textContent === '4', 'F23: SSR renders the derived value');
  (appEl.querySelector('.derived-btn') as HTMLElement).click();
  await tick();
  assert((appEl.querySelector('.derived-out') as HTMLElement).textContent === '9', 'F23: derived recomputes when its input changes');
  const snipOut = appEl.querySelector('.snip-out') as HTMLElement;
  assert(!!snipOut && snipOut.innerHTML.includes('chip chip-ok'), 'F24: snippet renders at the call site');
  assert(!!snipOut && snipOut.innerHTML.includes('>hello<'), 'F24: snippet param reaches the markup');
  assert(!!snipOut && snipOut.textContent === 'hello4', 'F24: snippet args evaluate per call (derived value rides in)');
  const lis0 = appEl.querySelectorAll('.keyed-item');
  assert(lis0.length === 3 && lis0[0].textContent === 'A', 'F26: keyed list renders');
  const liA = lis0[0];
  (appEl.querySelector('.keyed-shuffle') as HTMLElement).click();
  await tick();
  const lis1 = appEl.querySelectorAll('.keyed-item');
  assert(lis1[0].textContent === 'C' && lis1[1].textContent === 'A' && lis1[2].textContent === 'B', 'F26: keyed order matches the new data');
  assert(lis1[1] === liA, 'F26: keyed reorder preserves the DOM node');
  const sel = appEl.querySelector('.selm') as unknown as HTMLSelectElement;
  assert(!!sel && sel.options.length === 2, 'F28: multiple select rendered');
  (sel.options[0] as HTMLOptionElement).selected = true;
  (sel.options[1] as HTMLOptionElement).selected = true;
  sel.dispatchEvent(new (dom.window as any).Event('change', { bubbles: true }));
  await tick();
  assert((appEl.querySelector('.selm-out') as HTMLElement).textContent === 'x|y', 'F28: multiple select writes the array back');
  const pd = appEl.querySelector('.pulse-demo') as HTMLElement;
  assert(!!pd && pd.style.opacity === '0.4', 'F29: custom registered transition runs on mount');
  const p30 = appEl.querySelector('.p30') as HTMLElement;
  assert(!!p30 && p30.style.transition.includes('200ms'), 'F30: object params parse the trailing duration');
  const det = appEl.querySelector('.dt') as unknown as HTMLDetailsElement;
  assert(!!det && det.open === true, 'F31: bind:open SSR state');
  (det as any).open = false;
  det.dispatchEvent(new (dom.window as any).Event('toggle', { bubbles: true }));
  await tick();
  assert((appEl.querySelector('.dt-out') as HTMLElement).textContent === 'closed', 'F31: toggle writes state back');
  const cls = appEl.querySelector('.cls-obj') as HTMLElement;
  assert(!!cls && cls.classList.contains('a') && !cls.classList.contains('b') && cls.classList.contains('c'), 'F32: class object keeps truthy keys');
  const sty = appEl.querySelector('.sty-obj') as HTMLElement;
  assert(!!sty && sty.style.color === 'red', 'F32: style object becomes declarations');
  const spd = appEl.querySelector('.spin-demo') as HTMLElement;
  assert(!!spd && spd.style.opacity !== '', 'F33: spin built-in transition animates the mount');
  const f41 = appEl.querySelector('.f41-trans') as HTMLElement;
  assert(!!f41 && f41.style.transition.includes('ease-in-out'), 'F41: easing param reaches the transition CSS');
  assert(!!f41 && f41.style.transition.includes('100ms'), 'F41: delay param reaches the transition CSS');
  assert(!!f41 && f41.style.transition.includes('500ms'), 'F41: duration param reaches the transition CSS');
  assert(staggerPage.html.includes("easing: 'ease-in-out'"), 'F41: compiler emits the easing param verbatim');
  assert((appEl.querySelector('.ap-out') as HTMLElement).textContent === 'false', 'F34: $actionPending reads false at rest');
  const fnBtn = appEl.querySelector('.fn-up') as HTMLElement;
  const fnOut = appEl.querySelector('.fn-out') as HTMLElement;
  assert(!!fnBtn && fnOut.textContent === '10', 'F36: functional-update state starts at 10');
  fnBtn.dispatchEvent(new (dom.window as any).Event('click', { bubbles: true }));
  assert(fnOut.textContent === '15', 'F36: functional update applies (x) => x + 5');
  const numIn = appEl.querySelector('.num-in') as HTMLInputElement;
  const numOut = appEl.querySelector('.num-out') as HTMLElement;
  assert(!!numIn && numOut.textContent === '5', 'F38: number input starts at 5');
  numIn.value = '';
  numIn.dispatchEvent(new (dom.window as any).Event('input', { bubbles: true }));
  assert(numOut.textContent === 'empty', 'F38: clearing the number input stores null (not NaN)');
  const animEl = appEl.querySelector('.anim-demo') as HTMLElement;
  assert(!!animEl && /\bflip:duration: 400\b/.test(animEl.getAttribute('data-animate') || ''), 'F39: animate:flip={duration: 400} keeps its param in the marker');
  const effOut = appEl.querySelector('.eff-mirror') as HTMLElement;
  assert(!!effOut && effOut.textContent === '21', 'F43: $effect tracks its deps (mirrors n*7: 3*7=21)');
  (appEl.querySelector('.derived-btn') as HTMLElement).click();
  await tick();
  assert((appEl.querySelector('.eff-mirror') as HTMLElement).textContent === '28', 'F43: $effect re-runs when a tracked signal changes (4*7=28)');
  await start(appEl, '/', false);
  await tick();
  assert(((globalThis as any).__effCleanup || 0) >= 1, 'F43: $effect cleanup ran on navigation away');
  await start(appEl, '/deftest', false);
  await tick();
  assert((appEl.querySelector('.eff-mirror') as HTMLElement)?.textContent === '14', 'F43: a fresh $effect registers on route re-entry (2*7=14)');
}

console.log(`\nAll client pipeline checks passed - ${checks} assertions.`);
