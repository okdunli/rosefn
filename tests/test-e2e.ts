/**
 * rosefn end-to-end test - the strongest proof of the whole pipeline:
 * fetch the real page from the dev server (single request), execute the
 * inlined client bundle in a real DOM (jsdom), and drive real interactions:
 * zero-hydration adoption, fine-grained patching, {#if}/{#each}, and
 * client-side navigation - all without a page reload.
 *
 * Prereq: a server running (npm run dev, or npm run build && npm run preview).
 * Run: npx tsx tests/test-e2e.ts
 *
 * ROSEFN_E2E_BASE overrides the target, so the suite can run beside another
 * project's server that already owns port 3000 (the default stays 3000).
 */

import { JSDOM } from 'jsdom';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { gunzipSync, brotliDecompressSync } from 'zlib';

const BASE = process.env.ROSEFN_E2E_BASE || 'http://localhost:3000';

const res = await fetch(BASE + '/');
const html = await res.text();

const externalRefs = [...html.matchAll(/<(?:script|link|img)[^>]*(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !u.startsWith('#') && !u.startsWith('data:'));
console.log(`page fetched: ${html.length} bytes, external asset refs: ${externalRefs.length} (expect 0)`);
if (externalRefs.length > 0) {
  console.error('FAIL: page should need zero extra requests');
  process.exit(1);
}

let classic = html.replace('<script type="module">', '<script>');
const exp = classic.match(/\bexport\{([^}]*)\};?/);
if (exp) {
  const decls = exp[1]
    .split(',')
    .map((s) => {
      const [orig, alias] = s.split(/\s+as\s+/);
      return `${alias || orig}=${orig}`;
    })
    .join(',');
  classic = classic.replace(exp[0], `const ${decls};`);
}

const dom = new JSDOM(classic, {
  runScripts: 'dangerously',
  url: BASE + '/',
  pretendToBeVisual: true,
  beforeParse(window) {
    let vtCalls = 0;
    (window as any).__vtCalls = () => vtCalls;
    (window.document as any).startViewTransition = (cb: () => unknown) => {
      vtCalls++;
      const done = Promise.resolve(cb());
      return { updateCallbackDone: done, ready: done, finished: done, skipTransition() {} };
    };
    (window as any).requestIdleCallback = (fn: () => void) => setTimeout(fn, 0);
    (window as any).IntersectionObserver = class {
      private cb: (entries: unknown[]) => void;
      constructor(cb: (entries: unknown[]) => void) {
        this.cb = cb;
      }
      observe(el: Element) {
        this.cb([{ isIntersecting: true, target: el }]);
      }
      unobserve() {}
    };
    const posts: string[] = [];
    (window as any).__posts = posts;
    (window as any).__postCount = () => posts.length;
    (window as any).fetch = (input: any, init: any) => {
      const url = new URL(String(input), BASE).href;
      if (init && init.body && typeof init.body.getAll === 'function') {
        const params = new URLSearchParams();
        for (const [k, v] of init.body.entries()) params.append(k, String(v));
        init = { ...init, body: params.toString(), headers: { ...(init.headers || {}), 'content-type': 'application/x-www-form-urlencoded' } };
      }
      posts.push(url);
      return fetch(url, init);
    };
  },
});
const { document } = dom.window;

const tick = () => new Promise((r) => setTimeout(r, 20));

await tick();

let checks = 0;
const assert = (cond: boolean, msg: string) => {
  checks++;
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
};

const app = document.getElementById('app')!;
assert(!!app, 'app container present');
assert(app.textContent!.includes('Welcome to Rosefn'), 'SSR content rendered by the real server');
assert(!app.textContent!.includes('\u27e6'), 'markers resolved after in-page boot');
assert(document.querySelector('header')!.textContent!.includes('Rosefn'), 'layout header rendered');

const h1Before = document.querySelector('h1')!;
(document.querySelector('[data-on-click="increment"]') as any).click();
await tick();
assert(document.querySelector('p strong')!.textContent === '1', 'increment patched the count node');
assert(document.querySelector('h1') === h1Before, 'heading untouched (no re-render)');

(document.querySelector('[data-on-click="toggleFeatures"]') as any).click();
await tick();
assert(![...document.querySelectorAll('h2')].some((h) => h.textContent === 'Features'), '{#if} block removed on toggle');
(document.querySelector('[data-on-click="toggleFeatures"]') as any).click();
await tick();
assert([...document.querySelectorAll('h2')].some((h) => h.textContent === 'Features'), '{#if} block re-inserted on toggle');

const featuresList = document.querySelector('ul')!;
(document.querySelector('[data-on-click="addItem"]') as any).click();
await tick();
assert(featuresList.children.length === 4, 'addItem appended a 4th list item');

const aboutLink = [...document.querySelectorAll('nav a')].find((a) => a.getAttribute('href') === '/about')!;
aboutLink.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
await tick();
assert(document.body.textContent!.includes('Welcome to Rosefn'), 'hover prefetch left the current page untouched');
assert(document.querySelector('p strong')!.textContent === '1', 'hover prefetch did not disturb live state');

const cached = dom.window.eval('prefetchStats().cached') as number;
assert(cached >= 3, `idle prefetch rendered the visible links (${cached} routes cached)`);

const seamJson = dom.window.eval(
  'JSON.stringify({ has: !!window.__rosefn, state: window.__rosefn.state(), prefetch: window.__rosefn.prefetch() })'
) as string;
const seam = JSON.parse(seamJson);
assert(seam.has === true, 'the booted document exposes the devtools seam (window.__rosefn)');
const seamState = JSON.parse(seam.state);
assert(seamState && seamState.count === 1, `the seam answers the live signal graph (count=${seamState.count})`);
assert(seamState.__route === '/', 'the signal graph names the route it rendered');
assert(seam.prefetch && typeof seam.prefetch.cached === 'number' && seam.prefetch.cached === cached, 'the seam answers the same prefetch counters the bundle exports');

assert(document.title === 'Rosefn', 'layout <title> served in <head>');
assert(document.querySelector('meta[name="generator"]')?.getAttribute('content') === 'Rosefn', 'layout meta served in <head>');
const noScripts = html.replace(/<script[\s\S]*?<\/script>/g, '');
assert(!/<title|<meta/i.test(noScripts.slice(noScripts.indexOf('<body>'))), 'no head content leaks into the served body');
assert(/rel="icon" href="data:image\/svg\+xml,/.test(html), 'inline favicon served in <head>');

aboutLink.click();
await tick();
assert(document.body.textContent!.includes('About Rosefn'), 'client-side nav rendered /about');
assert(document.body.textContent!.includes('File-system routing with nested layouts'), '$data resolved on the client');
assert(dom.window.location.pathname === '/about', 'URL updated via pushState');
assert((dom.window as any).__vtCalls() >= 1, 'client-side navigation ran inside a native view transition');
assert(document.title === 'About Rosefn - Rosefn', 'page <title> overrides the layout on navigation');
assert(document.querySelector('meta[name="description"]')?.getAttribute('content') === 'What Rosefn is and the ideas it is built on.', 'page meta description applied');
assert(document.querySelector('meta[name="generator"]') !== null, 'layout meta survives a page with its own head');
assert(document.body.querySelector('title, meta') === null, 'no head content leaks into the live body after nav');
assert(document.querySelector('img[alt="Rosefn"]')?.getAttribute('src')?.startsWith('data:image/svg+xml,') === true, 'logo inlined as a data URI after navigation');

const homeLink = [...document.querySelectorAll('nav a')].find((a) => a.getAttribute('href') === '/')!;
homeLink.click();
await tick();
assert(document.querySelector('p strong')!.textContent === '0', 'per-route state reset on navigation home');
assert(document.title === 'Rosefn', 'layout <title> restored on navigation home');
assert(document.querySelector('meta[name="description"]') === null, 'page meta removed when leaving /about');

const form = document.querySelector('form')!;
const input = form.querySelector('input')!;
input.value = 'Trae';
form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
await tick();
const guestList = [...document.querySelectorAll('ul')].find((ul) => ul.textContent!.includes('the founder'))!;
assert(guestList.textContent!.includes('Trae'), 'form submit updated the list without a request');
assert(dom.window.location.pathname === '/', 'form submit did not navigate');
assert(input.value === '', 'form reset after submit');

dom.window.history.pushState(null, '', '/nope');
dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
await tick();
assert(document.body.textContent!.includes('This rose has no petals here'), 'client-side nav to an unknown route renders pages/404.rose');
assert(document.title === '404 - Rosefn', 'the 404 page applies its own <title>');
assert(document.querySelector('meta[name="robots"]')?.getAttribute('content') === 'noindex', 'the 404 page applies its own meta');

const nfRes = await fetch(BASE + '/nope');
assert(nfRes.status === 404, `server returns 404 for unmatched routes (got ${nfRes.status})`);
const nfHtml = await nfRes.text();
assert(nfHtml.includes('This rose has no petals here'), 'the served 404 document is the custom page');
assert(/<title>404 - Rosefn<\/title>/.test(nfHtml), 'the served 404 document carries its <title>');

const signRes = await fetch(BASE + '/sign');
assert(signRes.status === 200, 'the sign page serves with 200');
const signHtml = await signRes.text();
assert(signHtml.includes('<form method="POST">'), 'the sign page renders a native POST form');
assert(signHtml.includes('Ada Lovelace'), 'the sign page renders the server-side store');
const signPost = await fetch(BASE + '/sign', {
  method: 'POST',
  body: new URLSearchParams({ name: 'No JS User' }),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
});
const signPostHtml = await signPost.text();
assert(signPost.status === 200 || signPost.status === 403, `native POST to the action answers 200 (or the demo's 403 cap): got ${signPost.status}`);
assert(signPostHtml.includes('No JS User') || signPostHtml.includes('guestbook is full'), 'the POST response is the page after the action (the new signature, or the cap message)');

dom.window.history.pushState(null, '', '/sign');
dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
await tick();
assert(document.body.textContent!.includes('Signatures'), 'client-side nav to /sign rendered the sign page');
const signForm = document.querySelector('form')!;
const signInput = signForm.querySelector('input')! as any;
signInput.value = 'JS User';
signForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
await tick();
await tick();
assert(document.body.textContent!.includes('JS User') || document.body.textContent!.includes('guestbook is full'), 'the intercepted POST adopted the server response in place (the new signature, or the demo cap)');
assert(dom.window.location.pathname === '/sign', 'the form submit did not navigate');
assert(document.querySelector('ul')!.textContent!.includes('Ada Lovelace'), 'the adopted list keeps the existing signatures');

dom.window.history.pushState(null, '', '/');
dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
await tick();
const likeBtn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('data-on-click') === '$action:like')!;
assert(!!likeBtn, 'the home page serves the $action:like button');
const likesBefore = Number(document.body.textContent!.match(/🌹 (\d+) likes/)![1]);
const postsBefore = (dom.window as any).__postCount();
likeBtn.click();
await tick();
await tick();
const likesAfter = Number(document.body.textContent!.match(/🌹 (\d+) likes/)![1]);
assert((dom.window as any).__postCount() === postsBefore + 1, 'the action cost exactly one request');
assert(likesAfter > likesBefore, `the click ran the server action and adopted its value (${likesBefore} -> ${likesAfter})`);
assert(!/\u27e6m:/.test(document.body.textContent!), 'the adopted likes text is marker-free');
assert(dom.window.location.pathname === '/', 'the action did not navigate');
assert(document.body.textContent!.includes('Welcome to Rosefn'), 'the page is still home after the action');
const likeRes = await fetch(BASE + '/', {
  method: 'POST',
  body: new URLSearchParams({ __action: 'like' }),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
});
assert(likeRes.status === 200, 'POST __action=like -> 200');
const likeState = JSON.parse((await likeRes.text()).match(/<script type="application\/json" id="__rosefn_state">([\s\S]*?)<\/script>/)[1]);
assert(likeState.likes === likesAfter + 1, 'the raw POST ran the action and patched the state');

const evilPost = await fetch(BASE + '/', {
  method: 'POST',
  body: new URLSearchParams({ __action: 'like' }),
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://evil.example' },
});
assert(evilPost.status === 403, `a cross-origin POST is refused with 403 (got ${evilPost.status})`);
assert((await evilPost.text()).includes('Cross-site'), 'the refusal says why');
const sameOriginPost = await fetch(BASE + '/api/hello', {
  method: 'POST',
  body: new URLSearchParams({ hello: 'world' }),
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
});
assert(sameOriginPost.status === 200, 'the same POST with a matching Origin runs (the guard never blocks the real app)');
const fetchSitePost = await fetch(BASE + '/api/hello', {
  method: 'POST',
  headers: { 'sec-fetch-site': 'cross-site' },
});
assert(fetchSitePost.status === 403, 'a cross-site Sec-Fetch-Site is refused too (the fallback when no Origin is sent)');
const sameSitePost = await fetch(BASE + '/api/hello', {
  method: 'POST',
  body: new URLSearchParams({ hello: 'world' }),
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
});
assert(sameSitePost.status === 200, 'a same-origin Sec-Fetch-Site passes');

const apiWrite = async (path: string, fields: Record<string, string>, cookie?: string) => {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cookie) headers.cookie = cookie;
  const r = await fetch(BASE + path, { method: 'POST', headers, body: new URLSearchParams(fields).toString() });
  return { status: r.status, body: await r.text(), setCookie: r.headers.get('set-cookie') };
};
const refusedWrite = await apiWrite('/api/posts', { title: 'x', body: 'y' });
assert(refusedWrite.status === 401, `a write without a session is 401 (got ${refusedWrite.status})`);
assert(JSON.parse(refusedWrite.body).error === 'sign in first', 'the refusal is a JSON API error, not an HTML page');
const badLogin = await apiWrite('/api/login', { user: 'ada', pass: 'wrong' });
assert(badLogin.status === 401, `wrong credentials are 401 (got ${badLogin.status})`);
const login = await apiWrite('/api/login', { user: 'ada', pass: 'lovelace' });
assert(login.status === 200, `the seeded user signs in (got ${login.status})`);
assert(login.setCookie?.includes('session=1') && login.setCookie.includes('HttpOnly'), 'login sets the HttpOnly session cookie');
const session = (login.setCookie ?? '').split(';')[0];
const posts = await (await fetch(BASE + '/api/posts')).json();
assert(Array.isArray(posts.posts) && posts.posts.some((p: any) => p.title === 'Hello Rosefn'), 'the public GET lists the seeded articles');
const title = 'e2e post ' + Date.now();
const created = await apiWrite('/api/posts', { title, body: 'written by the suite' }, session);
assert(created.status === 201, `an authenticated write creates the post (got ${created.status})`);
const newId = JSON.parse(created.body).id;
assert((await (await fetch(BASE + '/api/posts')).json()).posts.some((p: any) => p.id === newId), 'the new post is in the list');
const removed = await fetch(BASE + '/api/posts?id=' + newId, { method: 'DELETE', headers: { cookie: session } });
assert(removed.status === 200, 'an authenticated DELETE removes it');
assert(!(await (await fetch(BASE + '/api/posts')).json()).posts.some((p: any) => p.id === newId), 'the deleted post is gone');

import { $cookies, $sessionCookie } from '../src/runtime/index.js';
const parsed = $cookies(new Request('http://localhost/', { headers: { cookie: 'session=Ada%20Lovelace; theme=dark; bare' } }));
assert(parsed.session === 'Ada Lovelace' && parsed.theme === 'dark', '$cookies parses and decodes the Cookie header');
assert(!('bare' in parsed), 'a valueless cookie fragment is ignored, not turned into an undefined entry');
const set = $sessionCookie('session', 'a b/c');
assert(set === 'session=a%20b%2Fc; Path=/; Max-Age=604800; SameSite=Lax; HttpOnly', `$sessionCookie defaults are the safe ones: ${set}`);
assert($sessionCookie('s', 'v', { secure: true }).endsWith('Secure'), 'secure: true adds Secure');
assert($sessionCookie('s', 'v', { sameSite: 'None' }).includes('SameSite=None') && $sessionCookie('s', 'v', { sameSite: 'None' }).includes('Secure'), 'SameSite=None forces Secure (browsers reject the pairing otherwise)');
assert(!$sessionCookie('s', 'v', { httpOnly: false }).includes('HttpOnly'), 'httpOnly: false is honored when a client script really needs the cookie');

import { $store, setStoreTransport, applyStorePatch } from '../src/runtime/index.js';
const box = $store('unit-test', { n: 1 });
assert(box.get().n === 1, '$store reads its initial value');
assert($store('unit-test', { n: 999 }).get().n === 1, 'a second $store call for the same name returns the SAME box (the initial value is only the seed)');
box.set({ n: 2 });
assert(box.get().n === 2, '$store set replaces the value');
box.update((v) => ({ n: v.n + 1 }));
assert(box.get().n === 3, '$store update derives from the current value');
const seen: Array<{ name: string; value: unknown }> = [];
setStoreTransport((name, value) => seen.push({ name, value }));
box.set({ n: 4 });
assert(seen.length === 1 && seen[0].name === 'unit-test' && (seen[0].value as { n: number }).n === 4, 'a write broadcasts through the transport');
applyStorePatch('unit-test', { n: 99 });
assert(box.get().n === 99, 'an incoming patch lands in the same box');
setStoreTransport(null);
box.set({ n: 5 });
assert(seen.length === 1, 'a null transport disables the broadcast (single-process runners have no peer)');
assert($store('never-seen', { ok: true }).get().ok === true, 'an unknown store seeds from its initial value');

const styleBlock = html.match(/<style>([\s\S]*?)<\/style>/g)!.join('');
assert(styleBlock.includes('[data-rosefn-c="index"] .rcard'), 'the served document inlines the scoped index rules');
assert(styleBlock.includes('[data-rosefn-c="about"] .rcard'), 'the served document inlines the scoped about rules');
assert(!/<link[^>]+stylesheet/i.test(html), 'zero stylesheet requests (styles ride in the document)');
const liveCard = document.querySelector('.rcard')!;
assert(liveCard.closest('[data-rosefn-c]')!.getAttribute('data-rosefn-c') === 'index', 'the live home card belongs to the index scope');
dom.window.history.pushState(null, '', '/about');
dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
await tick();
const aboutCard = document.querySelector('.rcard')!;
assert(aboutCard.closest('[data-rosefn-c]')!.getAttribute('data-rosefn-c') === 'about', 'after navigation the live card belongs to the about scope');
assert(aboutCard.textContent!.includes('revolutionary web framework'), 'the about card rendered after navigation');
dom.window.history.pushState(null, '', '/');
dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
await tick();
assert(document.querySelector('.rcard')!.closest('[data-rosefn-c]')!.getAttribute('data-rosefn-c') === 'index', 'navigating home restores the index scope');
const likeBtn2 = [...document.querySelectorAll('button')].find((b) => b.getAttribute('data-on-click') === '$action:like')!;
likeBtn2.click();
await tick();
await tick();
assert(document.querySelector('.rcard')!.closest('[data-rosefn-c]')!.getAttribute('data-rosefn-c') === 'index', 'the action response keeps the scope attribute');

dom.window.history.pushState(null, '', '/about');
dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
await tick();
const fetchesOf = () => Number(document.body.textContent!.match(/data fetches: (\d+)/)![1]);
const findRefreshBtn = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Refresh data')!;
assert(!!findRefreshBtn(), 'the about page serves the Refresh data button');
const before = fetchesOf();
const postsBeforeRefresh = (dom.window as any).__postCount();
await findRefreshBtn().click();
await tick();
await tick();
assert(fetchesOf() === before + 1, `refresh() re-ran $data in the page (fetches: ${before} -> ${fetchesOf()})`);
assert((dom.window as any).__postCount() === postsBeforeRefresh, 'refresh() costs zero requests');
assert(dom.window.location.pathname === '/about', 'refresh() did not navigate');
assert(document.body.textContent!.includes('Compile-time reactivity'), 'the facts list still renders after refresh');

const ticksOf = () => Number(document.body.textContent!.match(/mount ticks[^:]*: (\d+)/)![1]);
assert(ticksOf() === 0, 'the freshly navigated about page starts with 0 mount ticks');
await new Promise((r) => setTimeout(r, 260));
assert(ticksOf() >= 1, `onMount's heartbeat drives the ticks up (${ticksOf()})`);
dom.window.history.pushState(null, '', '/');
dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
await tick();
dom.window.history.pushState(null, '', '/about');
dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
await tick();
assert(ticksOf() === 0, 'onCleanup stopped the old heartbeat; the fresh mount restarts from 0');
await new Promise((r) => setTimeout(r, 260));
assert(ticksOf() >= 1, 'the remounted heartbeat ticks again');
dom.window.history.pushState(null, '', '/');
dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
await tick();

const brokenRes = await fetch(BASE + '/broken');
assert(brokenRes.status === 500, `a throwing route serves with 500 (got ${brokenRes.status})`);
const brokenHtml = await brokenRes.text();
assert(brokenHtml.includes('This rose pricked itself'), 'the served 500 document is the custom error page');
const brokenState = brokenHtml.match(/<script type="application\/json" id="__rosefn_state">([\s\S]*?)<\/script>/)?.[1] ?? '';
assert(!brokenState.includes('data source is down'), 'the served 500 state carries no server error text');
assert((await fetch(BASE + '/')).status === 200, 'other routes still serve 200 next to a broken one');
dom.window.history.pushState(null, '', '/broken');
dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
await tick();
assert(document.body.textContent!.includes('This rose pricked itself'), 'the client router degrades a broken route to the 500 page');
dom.window.history.pushState(null, '', '/');
dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
await tick();
assert(document.body.textContent!.includes('Welcome to Rosefn'), 'navigation still works after a broken route');
assert(document.body.textContent!.includes('This section failed to render.'), 'the boundary widget degraded in place');

const streamRes = await fetch(BASE + '/admin', { headers: { cookie: 'session=Ada' } });
assert(streamRes.status === 200, 'a streamed route serves with 200');
assert(streamRes.headers.get('transfer-encoding') === 'chunked', 'the response is really streamed (chunked transfer encoding)');
const streamHtml = await streamRes.text();
assert(streamHtml.startsWith('<!DOCTYPE html>'), 'the streamed document is complete from the first byte');
assert(streamHtml.includes('<div id="app">'), 'the streamed document opens the app container');
assert(streamHtml.includes('Hello, Ada'), 'the streamed body carries the rendered route');
assert(streamHtml.trimEnd().endsWith('</html>'), 'the streamed document closes properly');
assert(streamHtml.includes('id="__rosefn_state"'), 'the streamed document carries the state script');
const streamState = JSON.parse(streamHtml.match(/id="__rosefn_state">([\s\S]*?)<\/script>/)![1]);
assert(streamState.__route === '/admin', 'the streamed state names the requested route');
const streamRefs = [...streamHtml.matchAll(/<(?:script|link|img)[^>]*(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !u.startsWith('#') && !u.startsWith('data:'));
assert(streamRefs.length === 0, `the streamed document needs zero extra requests (${streamRefs.length} refs)`);
assert(/\u27e6h:/.test(streamHtml), 'the streamed body carries the route head markers');
assert(streamHtml.includes('<title>Rosefn</title>'), 'the streamed shell serves the default title before the route head exists');
let streamClassic = streamHtml.replace('<script type="module">', '<script>');
const streamExp = streamClassic.match(/\bexport\{([^}]*)\};?/);
if (streamExp) {
  const decls = streamExp[1].split(',').map((s) => { const [orig, alias] = s.split(/\s+as\s+/); return `${alias || orig}=${orig}`; }).join(',');
  streamClassic = streamClassic.replace(streamExp[0], `const ${decls};`);
}
const sdom = new JSDOM(streamClassic, { runScripts: 'dangerously', url: BASE + '/admin', pretendToBeVisual: true });
await tick();
const sapp = sdom.window.document.getElementById('app')!;
assert(sapp.textContent!.includes('Hello, Ada'), 'the streamed document boots with zero hydration');
assert(!sapp.textContent!.includes('\u27e6'), 'markers resolved after the streamed boot');
assert(sdom.window.document.title === 'Admin - Rosefn', 'the client applies the route head markers at boot');
const blogRes = await fetch(BASE + '/blog/3');
assert(blogRes.status === 200, 'the content route serves with 200');
assert(blogRes.headers.get('transfer-encoding') !== 'chunked', 'a zero-JS route is buffered, never streamed');
const blogHtml = await blogRes.text();
assert(blogHtml.includes('<title>Not found - Rosefn blog</title>'), 'the buffered zero-JS document carries its full <head> inline');
assert(blogHtml.includes('Blog Post #<!--\u27e6m:0\u27e7-->3'), 'the zero-JS document carries the rendered route');
assert(blogHtml.includes('Not found'), 'the zero-JS document carries the resolved $data');
assert((blogHtml.match(/<script/g) || []).length === 0, 'the zero-JS document contains zero script tags');
assert(blogHtml.trimEnd().endsWith('</html>'), 'the zero-JS document closes properly');

const feedRes = await fetch(BASE + '/feed');
assert(feedRes.status === 200, 'GET /feed -> 200');
const feedHtml = await feedRes.text();
assert(feedRes.headers.get('transfer-encoding') !== 'chunked', 'the zero-JS dynamic route is buffered, never streamed (its <head> must be complete)');
assert(feedHtml.includes('The dynamic half'), 'the DB rows are in the first response (read per request, not baked)');
assert(feedHtml.includes('Hello Rosefn'), 'every row of the query is in the document');
assert(feedHtml.includes('ada'), 'the row author is in the document');
assert(feedHtml.includes('Reading as a guest'), 'the middleware context reaches the page (no session -> guest)');
const feedSigned = await fetch(BASE + '/feed', { headers: { cookie: 'session=Ada' } });
assert((await feedSigned.text()).includes('Signed in as Ada'), 'the same route reads the session from the request context');
assert((feedHtml.match(/<script/g) || []).length === 0, 'the dynamic DB route ships zero script tags');
const feedRefs = [...feedHtml.matchAll(/<(?:script|link|img)[^>]*(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !u.startsWith('#') && !u.startsWith('data:'));
assert(feedRefs.length === 0, `the dynamic DB route needs zero extra requests (${feedRefs.length} refs)`);
assert(feedHtml.includes('<title>Feed - Rosefn</title>'), 'the buffered document carries its full <head> inline');
assert(feedHtml.trimEnd().endsWith('</html>'), 'the dynamic DB document closes properly');
const feedApi = await fetch(BASE + '/api/posts');
const feedPosts = await feedApi.json();
assert(feedPosts.posts.length >= 2, 'the api route reads the same table (the two seeded rows at least)');
for (const p of feedPosts.posts.slice(0, 20)) {
  assert(feedHtml.includes(p.title), `the page carries the api's row "${p.title}" (one table, two doors)`);
}
console.log(`dynamic DB route /feed: ${feedHtml.length} bytes raw, 0 script tags, ${feedRefs.length} extra requests, ${feedPosts.posts.length} rows in the first response`);
const aboutRes = await fetch(BASE + '/about');
const aboutHtml = await aboutRes.text();
assert(aboutHtml.includes('<title>About Rosefn - Rosefn</title>'), 'a prerendered route still serves its full <head>');
assert(aboutHtml.includes('name="description" content="What Rosefn is and the ideas it is built on."'), 'the prerendered head carries the route meta');

const rawGet = (pathname: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
    const where = new URL(BASE);
    const req = request({ host: where.hostname, port: Number(where.port), path: pathname, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers as any, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });

const wireIdentity = await rawGet('/');
assert(wireIdentity.status === 200, 'identity response: 200');
assert(!wireIdentity.headers['content-encoding'], 'no accept-encoding -> identity body');
assert(wireIdentity.body.toString().includes('🌹 Rosefn'), 'identity body is the full document');

const wireGz = await rawGet('/', { 'accept-encoding': 'gzip' });
assert(wireGz.headers['content-encoding'] === 'gzip', 'gzip negotiated when accepted');
assert(wireGz.headers['vary'] === 'Accept-Encoding', 'Vary: Accept-Encoding set');
assert(wireGz.body.length < wireIdentity.body.length, `gzip wire bytes < raw (${wireGz.body.length} < ${wireIdentity.body.length})`);
assert(gunzipSync(wireGz.body).toString().includes('🌹 Rosefn'), 'gzip body decompresses to the full document');

const wireBr = await rawGet('/', { 'accept-encoding': 'br, gzip' });
assert(wireBr.headers['content-encoding'] === 'br', 'brotli preferred over gzip when both accepted');
assert(wireBr.body.length < wireGz.body.length, `brotli wire bytes < gzip (${wireBr.body.length} < ${wireGz.body.length})`);
assert(brotliDecompressSync(wireBr.body).toString().includes('🌹 Rosefn'), 'brotli body decompresses to the full document');

const etag = wireIdentity.headers['etag'];
assert(!!etag, 'static file carries an ETag');
assert((wireIdentity.headers['cache-control'] || '').includes('max-age=3600'), 'static file carries Cache-Control');
const wire304 = await rawGet('/', { 'if-none-match': etag! });
assert(wire304.status === 304, 'If-None-Match -> 304');
assert(wire304.body.length === 0, 'the 304 carries no body');

const wireStream = await rawGet('/blog/3', { 'accept-encoding': 'gzip' });
assert(wireStream.headers['content-encoding'] === 'gzip', 'the buffered content route is compressed');
const wireStreamDoc = gunzipSync(wireStream.body).toString();
assert(!wireStreamDoc.includes('id="__rosefn_state"'), 'the buffered zero-JS+gzip document carries no state script');
assert((wireStreamDoc.match(/<script/g) || []).length === 0, 'the buffered zero-JS+gzip document carries no scripts');
assert(wireStreamDoc.includes('Blog Post'), 'the buffered zero-JS+gzip document carries the route content');
assert(wireStreamDoc.trimEnd().endsWith('</html>'), 'the buffered zero-JS+gzip document is complete');
console.log(`wire bytes for /: raw ${wireIdentity.body.length}, gzip ${wireGz.body.length}, brotli ${wireBr.body.length}`);

const shellRound = () => new Promise<{ headers: Record<string, string>; body: Buffer; first: number; last: number }>((resolve, reject) => {
  const where = new URL(BASE);
  const t0 = performance.now();
  let first = 0;
  let last = 0;
  const req = request({ host: where.hostname, port: Number(where.port), path: '/sign', headers: { 'accept-encoding': 'br, gzip' } }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (c) => {
      const now = performance.now() - t0;
      if (!first) first = now;
      last = now;
      chunks.push(c);
    });
    res.on('end', () => resolve({ headers: res.headers as any, body: Buffer.concat(chunks), first, last }));
  });
  req.on('error', reject);
  req.end();
});

const shellRounds = [];
for (let i = 0; i < 5; i++) shellRounds.push(await shellRound());
for (const [i, r] of shellRounds.entries()) {
  assert(r.headers['content-encoding'] === 'br', `streamed round ${i}: brotli negotiated`);
  assert(r.headers['transfer-encoding'] === 'chunked', `streamed round ${i}: delivered chunked, not one blob`);
  const doc = brotliDecompressSync(r.body).toString();
  assert(doc.includes('Sign the book'), `streamed round ${i}: the document carries the route`);
  assert(doc.trimEnd().endsWith('</html>'), `streamed round ${i}: the flushed brotli stream decompresses to a complete document`);
}
const gaps = shellRounds.map((r) => r.last - r.first).sort((a, b) => a - b);
assert(gaps[2] > 0, `the shell reaches the socket before the document completes (median gap ${gaps[2].toFixed(2)} ms over 5 rounds)`);
const firsts = shellRounds.map((r) => r.first).sort((a, b) => a - b);
assert(firsts[2] < 25, `the streamed route's first byte leaves with the shell (p50 ${firsts[2].toFixed(2)} ms; the unflushed stream measured 53 ms)`);
console.log(`streamed /sign: first byte p50 ${firsts[2].toFixed(2)} ms, shell-to-body gap p50 ${gaps[2].toFixed(2)} ms, ${shellRounds[0].body.length} brotli bytes`);

const apiGet = await fetch(BASE + '/api/hello');
assert(apiGet.status === 200, 'GET /api/hello -> 200');
assert((apiGet.headers.get('content-type') || '').includes('application/json'), 'the api response is application/json');
assert(!apiGet.headers.get('etag'), 'the api path runs the handler, not the baked static file');
const apiJson = await apiGet.json();
assert(apiJson.hello === 'Rosefn', 'the api GET body is the handler object');
const apiPost = await fetch(BASE + '/api/hello', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'name=ada',
});
assert(apiPost.status === 200, 'POST /api/hello -> 200');
assert((await apiPost.json()).hello === 'ada', 'the api POST handler reads the urlencoded form');
const apiPut = await fetch(BASE + '/api/hello', { method: 'PUT' });
assert(apiPut.status === 405, 'PUT /api/hello -> 405');
assert(apiPut.headers.get('allow') === 'GET, POST', 'the api 405 carries the Allow header');
const apiMissing = await fetch(BASE + '/api/nope');
assert(apiMissing.status === 404, 'unknown api route -> 404');
const apiMissingBody = await apiMissing.text();
assert(apiMissingBody.startsWith('{'), 'the api 404 body is JSON, not the HTML page');
assert(JSON.parse(apiMissingBody).error === 'not found', 'the api 404 body names the error');

const walled = await fetch(BASE + '/admin', { redirect: 'manual' });
assert(walled.status === 302, `the middleware walls /admin with a 302 (got ${walled.status})`);
assert(walled.headers.get('location') === '/sign', 'the redirect names its target');
const allowed = await fetch(BASE + '/admin', { headers: { cookie: 'session=rose' } });
assert(allowed.status === 200, 'a session passes the wall');
assert((await allowed.text()).includes('Hello, rose'), 'the gated page greets the session user over real HTTP');
const homeOk = await fetch(BASE + '/');
assert(homeOk.status === 200 && (await homeOk.text()).includes('Welcome to'), 'normal routes are unaffected by the middleware');
const secretDenied = await fetch(BASE + '/api/secret');
assert(secretDenied.status === 401, 'the guarded api answers 401 without a session');
const secretOk = await fetch(BASE + '/api/secret', { headers: { cookie: 'session=rose' } });
assert(secretOk.status === 200 && JSON.parse(await secretOk.text()).for === 'rose', 'the guarded api serves the session user');
const vaultWalled = await fetch(BASE + '/vault', { redirect: 'manual' });
assert(vaultWalled.status === 302, `the middleware walls /vault with a 302 (got ${vaultWalled.status})`);
const vaultOk = await fetch(BASE + '/vault', { headers: { cookie: 'session=rose' } });
assert(vaultOk.status === 200 && (await vaultOk.text()).includes('The Vault'), 'a session passes the plain wall and renders the page');
dom.window.history.pushState(null, '', '/admin');
dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
await tick();
assert(document.body.textContent!.includes('Please sign in'), 'the client-side render of the walled route shows only the public shell');
dom.window.history.pushState(null, '', '/');
dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
await tick();

{
  const { spawn } = await import('node:child_process');
  const { readFileSync: readF, existsSync: existsF } = await import('node:fs');
  const PREVIEW = 'http://localhost:3210';
  const prev = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/cli/index.ts', 'preview', 'example'], {
    env: { ...process.env, PORT: '3210' },
    stdio: 'ignore',
  });
  const freshFile = 'dist/fresh/index.html';
  const stampOf = (h: string) => h.match(/render #(\d+)/)?.[1] ?? '';
  try {
    let up = false;
    for (let i = 0; i < 150 && !up; i++) {
      try {
        up = (await fetch(PREVIEW + '/')).status === 200;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    assert(up, 'the preview server started beside the dev server (PORT env)');
    assert(existsF(freshFile), 'the ISR route is baked at build time like any static route');

    await new Promise((r) => setTimeout(r, 2300));
    const onDisk = readF(freshFile, 'utf-8');
    const staleRes = await fetch(PREVIEW + '/fresh');
    const stale = await staleRes.text();
    assert(stale === onDisk, 'a stale request is answered from disk with the old document (stale-while-revalidate)');
    assert(staleRes.headers.get('cache-control') === 'public, max-age=0, stale-while-revalidate=2',
      `the ISR route's Cache-Control tells the browser the window (got: ${staleRes.headers.get('cache-control')})`);

    await new Promise((r) => setTimeout(r, 700));
    const swapped = readF(freshFile, 'utf-8');
    assert(swapped !== onDisk, 'the background pass re-rendered and swapped the file');
    const fresh = await (await fetch(PREVIEW + '/fresh')).text();
    assert(fresh === swapped, 'after the swap the request serves the new document');
    assert(stampOf(fresh) !== stampOf(onDisk), `the stamp advanced (${stampOf(onDisk)} -> ${stampOf(fresh)})`);
    assert(!fresh.includes('<script'), 'the swapped ISR document stays zero-JS (no script tags)');
    assert(!fresh.includes('__rosefn_state'), 'the swapped ISR document carries no state script');
    assert(!fresh.includes('__rosefn'), 'the swapped ISR document inlines no bundle');

    const again = await (await fetch(PREVIEW + '/fresh')).text();
    assert(stampOf(again) === stampOf(fresh), 'the window holds: no render until the next stale request');

    const pub1Res = await fetch(PREVIEW + '/');
    const pub1 = await pub1Res.text();
    await new Promise((r) => setTimeout(r, 2300));
    const pub2 = await (await fetch(PREVIEW + '/')).text();
    assert(pub1 === pub2, 'a route without revalidate is never swapped (static stays static)');
    assert(pub1Res.headers.get('cache-control') === 'public, max-age=3600',
      `a non-ISR route keeps the plain hour (got: ${pub1Res.headers.get('cache-control')})`);
  } finally {
    const { execSync } = await import('node:child_process');
    try {
      if (process.platform === 'win32') execSync(`taskkill /pid ${prev.pid} /T /F`, { stdio: 'ignore' });
      else prev.kill();
    } catch { /* already gone */ }
  }
}

{
  const garden = await (await fetch(BASE + '/garden')).text();
  assert(garden.includes('The Garden') && garden.includes('in full bloom'), 'the no-JS route serves its content over real HTTP');
  assert(!garden.includes('__rosefn_state'), 'the no-JS document has no state script');
  assert(!garden.includes('__rosefn_handlers'), 'the no-JS document has no client bundle');
  assert((garden.match(/<script/g) || []).length === 0, 'the no-JS document contains zero script tags');
  assert(garden.includes('<title>The Garden - Rosefn</title>'), 'the no-JS document keeps the route <title> (buffered, complete head)');
  assert(garden.includes('\u{1F339}'), 'the served no-JS document carries the plugin transform output');
  const gardenRefs = [...garden.matchAll(/<(?:script|link|img)[^>]*(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !u.startsWith('#') && !u.startsWith('data:'));
  assert(gardenRefs.length === 0, 'the no-JS document requests nothing: one request total');
  assert(garden.length < 6000, `the no-JS document is tiny (${garden.length} bytes raw)`);
  const home = await (await fetch(BASE + '/')).text();
  assert(home.includes('__rosefn_state') && home.includes('__rosefn_handlers'), 'a normal route still inlines the state script and the bundle');
  dom.window.history.pushState(null, '', '/garden');
  dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  await tick();
  assert(document.body.textContent!.includes('The Garden'), 'client-side navigation paints the no-JS route from the bundle');
  assert(document.body.textContent!.includes('in full bloom'), 'the client render ran the no-JS route $data resolver');
  assert(dom.window.document.title === 'The Garden - Rosefn', 'the client render applied the no-JS route <head>');
  dom.window.history.pushState(null, '', '/');
  dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  await tick();
}

{
  const homeRes = await fetch(BASE + '/');
  const homeCsp = homeRes.headers.get('content-security-policy')!;
  assert(homeCsp.includes('script-src \'sha256-') && homeCsp.includes("object-src 'none'"), 'every page document carries the strict CSP over real HTTP');
  const homeHtml = await homeRes.text();
  const blocks = [...homeHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const inlineHash = createHash('sha256').update(blocks[blocks.length - 1], 'utf-8').digest('base64');
  assert(homeCsp.includes(`'sha256-${inlineHash}'`), 'the served CSP hashes the exact inline script bytes the browser will run');
  const thornRes = await fetch(BASE + '/thorn');
  assert(thornRes.headers.get('content-security-policy') === "default-src 'none'; style-src 'unsafe-inline'; img-src data:", 'the thorn route replaces the CSP with its no-script policy');
  assert(thornRes.headers.get('x-robots-tag') === 'noindex', 'the thorn route adds its plain header');
  const adminRes = await fetch(BASE + '/admin', { headers: { cookie: 'session=rose' } });
  assert(adminRes.headers.get('content-security-policy') === homeCsp, 'a live render carries the same strict CSP');
  const assetRes = await fetch(BASE + '/styles.css');
  assert(!assetRes.headers.get('content-security-policy'), 'assets carry no page CSP');
  const etag = homeRes.headers.get('etag')!;
  const revalidated = await fetch(BASE + '/', { headers: { 'if-none-match': etag } });
  assert(revalidated.status === 304 && revalidated.headers.get('content-security-policy') === homeCsp, 'the 304 keeps the CSP');
}

{
  const signA = await fetch(BASE + '/sign');
  const signAHtml = await signA.text();
  const cspA = signA.headers.get('content-security-policy')!;
  const nonceA = /'nonce-([^']+)'/.exec(cspA)?.[1];
  assert(!!nonceA, 'the nonce route answers a nonce policy');
  assert(cspA.includes("'strict-dynamic'"), 'the nonce policy carries strict-dynamic (a third-party loader may load more)');
  assert(!cspA.includes('sha256'), 'the nonce policy carries no hash - the two are alternatives, not a blend');
  assert(cspA.includes("object-src 'none'"), 'the nonce policy keeps every other directive of the default');
  const moduleTag = signAHtml.match(/<script type="module"([^>]*)>/)![1];
  assert(moduleTag.includes(`nonce="${nonceA}"`), 'the document script tag carries the header nonce');
  assert(signAHtml.includes('<script type="application/json" id="__rosefn_state">'), 'the state script stays untagged');
  const signB = await fetch(BASE + '/sign');
  const nonceB = /'nonce-([^']+)'/.exec(signB.headers.get('content-security-policy')!)![1];
  assert(nonceB !== nonceA, 'every response mints a fresh nonce');
  assert((await signB.text()).includes(`nonce="${nonceB}"`), 'the second document carries its own nonce');
  const postRes = await fetch(BASE + '/sign', {
    method: 'POST',
    body: new URLSearchParams({ name: 'Nonce Tester' }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const postHtml = await postRes.text();
  const postNonce = /'nonce-([^']+)'/.exec(postRes.headers.get('content-security-policy')!)![1];
  assert(postNonce !== nonceA && postNonce !== nonceB, 'the action response mints its own nonce');
  assert(postHtml.includes(`nonce="${postNonce}"`), 'the action response tag carries that nonce');
  assert(postHtml.includes('Nonce Tester') || postHtml.includes('guestbook is full'), 'the action still ran (the nonce did not break the form)');
}

{
  const enRes = await fetch(BASE + '/en/about');
  assert(enRes.status === 200, 'GET /en/about -> 200');
  const enHtml = await enRes.text();
  assert(enHtml.includes('This page speaks your language'), 'the en document carries the en dictionary');
  assert(enHtml.includes('Hello, Rosefn - this sentence was translated with a variable.'), 'the served document interpolates the variable');
  assert(enHtml.includes('<title>About, localized - Rosefn</title>'), 'the en document head is localized');
  const zhRes = await fetch(BASE + '/zh/about');
  assert(zhRes.status === 200, 'GET /zh/about -> 200');
  const zhHtml = await zhRes.text();
  assert(zhHtml.includes('这一页说你的语言'), 'the zh document carries the zh dictionary');
  assert(zhHtml.includes('你好,Rosefn - 这句话带变量翻译。'), 'the zh document interpolates the variable');
  assert(zhHtml.includes('<title>关于,已本地化 - Rosefn</title>'), 'the zh document head is localized');
  const frRes = await fetch(BASE + '/fr/about');
  assert(frRes.status === 404, 'GET /fr/about -> 404');
  assert((await frRes.text()).includes('This rose has no petals here'), 'the unknown locale serves the 404 page');
  const zhNeg = await fetch(BASE + '/about', { headers: { 'accept-language': 'zh-CN,zh;q=0.9' }, redirect: 'manual' });
  assert(zhNeg.status === 302 && zhNeg.headers.get('location') === '/zh/about', 'a zh Accept-Language redirects to /zh/about');
  assert(zhNeg.headers.get('vary') === 'Accept-Language', 'the redirect varies on Accept-Language');
  const frNeg = await fetch(BASE + '/about', { headers: { 'accept-language': 'fr' }, redirect: 'manual' });
  assert(frNeg.status === 200, 'a preference matching no dictionary serves the default locale in place (no redirect)');
  const starNeg = await fetch(BASE + '/about', { headers: { 'accept-language': '*' }, redirect: 'manual' });
  assert(starNeg.status === 200, 'the * wildcard (no preference) does not redirect either');
  const noNeg = await fetch(BASE + '/about', { redirect: 'manual' });
  assert(noNeg.status === 200, 'no Accept-Language header: /about renders as-is');
  const arRes = await fetch(BASE + '/ar/about');
  assert(arRes.status === 200, 'GET /ar/about -> 200');
  const arHtml = await arRes.text();
  assert(arHtml.includes('<html lang="ar" dir="rtl">'), 'the ar document is right-to-left');
  assert(arHtml.includes('هذه الصفحة تتحدث لغتك'), 'the ar document carries the ar dictionary');
  assert(arHtml.includes('مرحبًا، Rosefn'), 'the ar document interpolates the variable');
  assert(arHtml.includes('<title>حول، مترجم - Rosefn</title>'), 'the ar document head is localized');
  assert(arHtml.includes('لا توقيعات بعد في سجل الزوار'), 'the ar =0 arm renders');
  assert(arHtml.includes('توقيع واحد في سجل الزوار'), 'the ar one arm renders');
  assert(arHtml.includes('7 توقيعات في سجل الزوار'), 'the ar few arm renders (7 is "few" in Arabic)');
  assert(arHtml.includes('أنت الزائر رقم 3 اليوم'), 'the ar selectordinal renders');
  assert(arHtml.includes('مسجّل الدخول بصفة الوردة'), 'the ar select arm renders');
  const packRes = await fetch(BASE + '/locales/ar.json');
  assert(packRes.status === 200, 'GET /locales/ar.json -> 200');
  assert((packRes.headers.get('content-type') || '').includes('json'), 'the pack is served as JSON');
  assert((await packRes.text()).includes('about.plural'), 'the pack file carries the ar dictionary');
  const postsBefore = (dom.window as any).__postCount();
  dom.window.history.pushState(null, '', '/zh/about');
  dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  await tick();
  assert(app.textContent!.includes('这一页说你的语言'), 'client-side navigation paints the zh locale');
  assert(dom.window.document.title === '关于,已本地化 - Rosefn', 'the localized head is applied on navigation');
  dom.window.history.pushState(null, '', '/en/about');
  dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  await tick();
  assert(app.textContent!.includes('This page speaks your language'), 'client-side navigation paints the en locale');
  const switched = (dom.window as any).__posts.slice(postsBefore);
  assert(switched.every((u: string) => u.includes('/locales/')), 'the preloaded locale switch costs zero requests (only a pack dictionary may arrive, and only once)');
  const packFetches = () => (dom.window as any).__posts.filter((u: string) => u.includes('/locales/ar.json')).length;
  dom.window.history.pushState(null, '', '/ar/about');
  dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  await tick();
  await tick();
  assert(app.textContent!.includes('هذه الصفحة تتحدث لغتك'), 'client-side navigation paints the packed ar locale');
  assert(packFetches() === 1, `the packed locale costs exactly one request per session (${packFetches()})`);
  const total = (dom.window as any).__postCount();
  dom.window.history.pushState(null, '', '/en/about');
  dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  await tick();
  dom.window.history.pushState(null, '', '/ar/about');
  dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  await tick();
  assert(app.textContent!.includes('هذه الصفحة تتحدث لغتك'), 'the packed locale repaints from memory');
  assert((dom.window as any).__postCount() === total, 'the cached pack costs zero further requests');
  assert(dom.window.document.documentElement.getAttribute('dir') === 'rtl', 'the RTL direction is applied on navigation');
  dom.window.history.pushState(null, '', '/');
  dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  await tick();
  assert(dom.window.document.documentElement.getAttribute('dir') !== 'rtl', 'leaving the RTL locale restores the LTR default');
}

{
  for (const p of ['/about?x=1', '/blog/1?ref=twitter', '/garden?a=b&c=d', '/fresh?utm_source=x', '/?q=hello']) {
    const r = await fetch(BASE + p);
    assert(r.status === 200, `GET ${p} -> 200 (the query never changes the route)`);
  }
  const miss = await fetch(BASE + '/nope?q=1');
  assert(miss.status === 404, 'an unknown pathname is still a 404, query or not');
  const api = await fetch(BASE + '/api/echo?say=hi');
  const apiJson = await api.json() as Record<string, string>;
  assert(api.status === 200 && apiJson.said === 'hi', 'the api handler reads the query from its Request');
  assert(apiJson.viaQuery === 'hi', 'and through $query() too');
}

{
  const bare = await fetch(BASE + '/search');
  const bareHtml = await bare.text();
  assert(bare.status === 200, 'GET /search -> 200');
  assert(bareHtml.includes('name="q"'), 'the native GET form is in the document');
  assert((bareHtml.match(/<script/g) || []).length === 0, 'P1-3: a native form does not force the bundle - the route ships zero script tags');
  assert(!bareHtml.includes('id="app"'), 'P1-1: the zero-JS document has no #app wrapper');
  assert(!bareHtml.includes('font-family'), 'P1-1: the zero-JS document carries no demo stylesheet');
  assert(bareHtml.includes('Type a word'), 'the empty-query state renders');

  const rose = await fetch(BASE + '/search?q=rose');
  const roseHtml = await rose.text();
  const roseText = roseHtml.replace(/<!--\u27e6[^>]*?\u27e7-->/g, '');
  assert(rose.status === 200, 'GET /search?q=rose -> 200 (the query reaches the render)');
  assert(roseHtml.includes('<title>Search: rose - Rosefn</title>'), '$query() feeds the document head');
  assert(roseText.includes('2 result(s) for'), 'the query filters the corpus');
  assert(roseHtml.includes('<strong>first post</strong>'), 'P1-2: {@html} emits the trusted markup verbatim');
  assert(!roseHtml.includes('&lt;strong&gt;'), 'P1-2: and it is not escaped');
  const anchor = await fetch(BASE + '/search?q=thorn');
  assert((await anchor.text()).includes('<a href="/thorn">no script</a>'), 'P1-2: trusted markup keeps its own links');
  const none = await fetch(BASE + '/search?q=zzzz');
  const noneText = (await none.text()).replace(/<!--\u27e6[^>]*?\u27e7-->/g, '');
  assert(noneText.includes('0 result(s)'), 'a query with no matches says so');
  const garden = await fetch(BASE + '/garden');
  const gardenHtml = await garden.text();
  assert(!gardenHtml.includes('id="app"'), 'P1-1: the garden document has no #app wrapper either');
  assert(!gardenHtml.includes('font-family'), 'P1-1: and no demo stylesheet');
  assert(gardenHtml.includes('The Garden'), 'the garden still renders its content');
}

{
  const streamed = await fetch(BASE + '/');
  assert(!(await streamed.text()).includes('data-hooked="1"'), 'P0-2: a streamed route is not force-buffered by a hook (the stream stays the stream)');
  const buffered = await fetch(BASE + '/buffered');
  const bufferedHtml = await buffered.text();
  assert(buffered.status === 200, 'GET /buffered -> 200');
  assert(bufferedHtml.includes('data-hooked="1"'), 'P0-2: a buffer = true route goes through the buffered path, where onResponse CAN rewrite the body');
  assert(bufferedHtml.includes('buffered body'), 'the buffered route renders its content');
}

console.log(`\nAll end-to-end checks passed - one request, zero hydration, fine-grained DOM - ${checks} assertions.`);
