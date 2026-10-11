/**
 * rosefn/test - the PUBLIC testing API, proven against the demo app.
 *
 * The framework's own suites (client/edge/e2e/go/cli/pack) drive the bundles
 * directly. This one drives them the way a USER does: through the single
 * `test()` entry point a project's own vitest file would import. If this
 * suite is green, a project can test its components, pages, middleware,
 * api routes and server actions with nothing but `rosefn/test`.
 *
 * What it proves, in order:
 *   1. a component target builds and renders with the given props
 *   2. a page target renders, with state the client can resume
 *   3. the middleware wall, the session cookie and locale negotiation
 *   4. api routes: public JSON, a guarded 401, the same call authorized
 *   5. server actions on the server half: success, ActionError, the cap
 *   6. mount() without a DOM says so instead of crashing obscurely
 *   7. the mounted half: a real submit -> in-place adopt, ONE request,
 *      zero hydration (untouched nodes keep their identity), an action
 *      error adopted in place, $action from no event, client-side nav
 *   8. restore() puts the process back the way it was
 *
 * Run: npx tsx tests/test-harness.ts
 */

import { JSDOM } from 'jsdom';
import { test } from '../src/cli/test.js';

let checks = 0;
const assert = (cond: boolean, msg: string) => {
  checks++;
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
};

const stripMarkers = (h: string) => h.replace(/<!--\u27e6[^>]*-->/g, '');

const card = await test('example/src/components/FactCard.rose', {
  props: { fact: 'components compile into the app' },
});
assert(card.route === '/__rosefn_test', 'a component target gets its own synthesized route');
const cardPage = await card.get();
assert(cardPage.status === 200, 'the synthesized route renders (200)');
assert(stripMarkers(cardPage.html).includes('components compile into the app'), 'the component renders with the given props');
assert(stripMarkers(cardPage.html).includes('<li class="fact">'), 'the component markup IS the page markup (no wrapper node)');
assert(stripMarkers(cardPage.html).includes('🌹'), 'the app layout still wraps a component test');

const home = await test('example/src/pages/index.rose');
assert(home.route === '/', 'a page target defaults to the page\'s own URL');
const homePage = await home.get();
assert(homePage.status === 200, 'the home page renders (200)');
assert(stripMarkers(homePage.html).includes('Welcome to Rosefn'), 'the page content is there');
assert(homePage.document.includes('id="__rosefn_state"'), 'the document carries the state script the client resumes');
assert(homePage.state.count === 0, 'the state parses out of the document (count starts at 0)');
assert(homePage.document.includes('<script'), 'the document ships the bundle (the page is interactive)');

const post = await test('example/src/pages/blog/[id].rose', { route: '/blog/2' });
assert(post.route === '/blog/2', 'a dynamic page target takes the concrete URL to render');
const postPage = await post.get();
assert(postPage.status === 200 && stripMarkers(postPage.html).includes('Blog Post #2'), 'the dynamic route renders the row for that URL');

const walled = await home.get('/vault');
assert(walled.status === 302 && walled.redirect === '/sign', 'the middleware wall redirects a session-less request');
const inside = await home.get('/vault', { cookies: { session: 'Ada' } });
assert(inside.status === 200, 'the session cookie opens the wall');
const negotiated = await home.get('/about', { headers: { 'accept-language': 'zh' } });
assert(negotiated.status === 302 && negotiated.redirect === '/zh/about', 'locale negotiation redirects to the visitor\'s language');
const unmatched = await home.get('/about', { headers: { 'accept-language': 'fr' } });
assert(unmatched.status === 200, 'a preference matching no dictionary serves the page in the default locale');

const hello = await home.api('GET', '/api/hello');
assert(hello.status === 200 && (hello.body as any)?.hello === 'Rosefn', 'a public api route answers JSON');
const secret = await home.api('GET', '/api/secret');
assert(secret.status === 401, 'the guarded api route refuses an anonymous call');
const mine = await home.api('GET', '/api/secret', { cookies: { session: 'Ada' } });
assert(mine.status === 200 && (mine.body as any)?.secret === 'the thorn is sharp', 'the same call with a session cookie answers');

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
const book = await test('example/src/pages/sign.rose', { dom });
assert(book.route === '/sign', 'a page target knows its route');
const signed = await book.post({ name: 'Margaret Hamilton' });
assert(signed.status === 200 && stripMarkers(signed.html).includes('Margaret Hamilton'), 'a POST runs the server action and re-renders with its effect');
const blank = await book.post({ name: '   ' });
assert(blank.status === 422 && stripMarkers(blank.html).includes('A signature needs a name.'), 'an ActionError keeps its status and shows its message');
assert(stripMarkers(blank.html).includes('Ada Lovelace'), 'the page still renders the store after the failure');

const bare = await test('example/src/pages/index.rose');
let mountError = '';
try {
  await bare.mount();
} catch (e) {
  mountError = String((e as Error).message);
}
assert(mountError.includes('needs a DOM'), 'mount() without a DOM explains what to pass');

const fetchBefore = globalThis.fetch;
const page = await book.mount();
assert(page.text('h1') === 'Guestbook 🌹', 'the mount adopts the SSR document');
assert(page.text('ul').includes('Margaret Hamilton'), 'the mounted page shows the store the server action wrote');
assert(page.requestCount() === 0, 'the mount itself costs no requests (the document was already rendered)');

const ulBefore = page.document.querySelector('ul');
await page.fill('input[name="name"]', 'Katherine Johnson');
await page.submit();
assert(page.text('ul').includes('Katherine Johnson'), 'a real submit adopts the action\'s response in place');
assert(page.requestCount() === 1, 'the in-place adopt cost exactly ONE request');
assert(page.text('h1') === 'Guestbook 🌹', 'the adopt swapped the page content, heading included');
assert(ulBefore !== null && page.document.querySelector('ul') !== null, 'the list is still a list after the adopt');

await page.fill('input[name="name"]', ' ');
await page.submit();
assert(page.text('#app').includes('A signature needs a name.'), 'an ActionError is adopted in place, message visible');
assert((page.state() as any).actionError?.code === 422, 'the adopted state carries the failure (code 422, field name)');
assert(page.requestCount() === 2, 'the failed action was still exactly one request');

await page.action('action', { name: 'Radia Perlman' });
assert(page.text('ul').includes('Radia Perlman'), '$action(name) runs the action from any event (here: none)');

await page.action('action', { name: 'Barbara Liskov' });
assert(page.text('#app').includes('guestbook is full'), 'the guard vetoes the sixth signature with its ActionError message');

await page.navigate('/');
assert(page.text('h1').includes('Welcome to Rosefn'), 'client-side navigation renders another route of the built app');
assert(page.requestCount() === 4, 'navigation re-rendered locally: no request for the new route');

const header = page.document.querySelector('header');
const heading = page.document.querySelector('h1');
assert(page.text('#app p strong') === '0', 'the navigated page starts at count 0');
await page.click('[data-on-click="increment"]');
assert(page.text('#app p strong') === '1', 'a click ran the handler and the state moved');
assert(page.document.querySelector('header') === header, 'fine-grained: the layout node the event did not touch keeps its identity');
assert(page.document.querySelector('h1') === heading, 'fine-grained: the heading keeps its identity too');

(page as any).restore();
assert((globalThis as any).document === undefined, 'restore() ungrafts the DOM globals');
assert(globalThis.fetch === fetchBefore, 'restore() puts the fetch proxy back to the process\'s own');

console.log(`\nAll rosefn/test checks passed - ${checks} assertions`);
