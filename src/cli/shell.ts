/**
 * HTML shell - the document wrapper for every rosefn page.
 *
 * The client bundle is INLINED into the document, so a full page load costs
 * exactly one request: the HTML itself. No other framework in the comparison
 * set achieves that - they all
 * ship a separate JS bundle, doubling the round-trips before first paint.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { createHash } from 'crypto';

const OUT_DIR = path.join(process.cwd(), 'dist');

let clientCache: { mtimeMs: number; source: string } | null = null;

// The bundle mode the last build decided ('inline' | 'split'). In
// split mode getClientSource() answers null - "nothing to inline" - so
// every shell caller (documents, headers, the streaming tag) follows the
// external-bundle path without a parameter threaded through each one.
let splitMode = false;
export function setBundleMode(mode: string): void {
  splitMode = mode === 'split';
}

/** Read dist/client.js with an mtime-based cache (dev server rebuilds it). */
export function getClientSource(): string | null {
  if (splitMode) return null; // mode B: the document references /client.js
  const file = path.join(OUT_DIR, 'client.js');
  try {
    const st = fs.statSync(file);
    if (!clientCache || clientCache.mtimeMs !== st.mtimeMs) {
      clientCache = { mtimeMs: st.mtimeMs, source: fs.readFileSync(file, 'utf-8') };
    }
    return clientCache.source;
  } catch {
    return null;
  }
}

let styleCache: { mtimeMs: number; source: string } | null = null;

/**
 * Read dist/styles.css (every component's scoped <style>, merged at build
 * time) with an mtime-based cache. '' when the app declares no component
 * styles - the document then carries only the shell's own STYLES.
 */
export function getStyles(): string {
  const file = path.join(OUT_DIR, 'styles.css');
  try {
    const st = fs.statSync(file);
    if (!styleCache || styleCache.mtimeMs !== st.mtimeMs) {
      styleCache = { mtimeMs: st.mtimeMs, source: fs.readFileSync(file, 'utf-8') };
    }
    return styleCache.source;
  } catch {
    return '';
  }
}

// Bootstrap appended after the inlined bundle: client-side navigation.
// Distinct names avoid any collision with minified bundle identifiers.
// Minified once at module load - this text ships inside EVERY document, so
// every byte here is paid on every page load.
const BOOTSTRAP = esbuild.transformSync(`
const __app = document.getElementById('app');
// Native View Transitions around client-side navigation (progressive:
// browsers without the API navigate normally, no polyfill, no CSS required).
function __navigate(pathname) {
  const paint = () => start(__app, pathname);
  if (document.startViewTransition) {
    return document.startViewTransition(paint).updateCallbackDone;
  }
  return paint();
}
window.addEventListener('popstate', () => __navigate(window.location.pathname));
document.addEventListener('click', (e) => {
  const a = e.target.tagName === 'A' ? e.target : e.target.closest && e.target.closest('a');
  if (a && a.getAttribute('href') && a.getAttribute('href').startsWith('/')) {
    e.preventDefault();
    history.pushState(null, '', a.getAttribute('href'));
    __navigate(window.location.pathname);
  }
});
// Prefetch the target route's full render (including $data) on hover, keyboard
// focus, or touch - the click that follows paints from cache: no await, no
// request. Other frameworks prefetch data only; Rosefn prefetches the render
// because the inlined bundle already contains every route.
function __prefetchHandler(e) {
  const a = e.target.closest && e.target.closest('a[href^="/"]');
  if (a && prefetch) prefetch(a.getAttribute('href'), 'hover');
}
document.addEventListener('mouseover', __prefetchHandler);
document.addEventListener('focusin', __prefetchHandler);
document.addEventListener('touchstart', __prefetchHandler, { passive: true });
// Viewport + idle prefetch (viewport-triggered): once a link scrolls into view and the
// browser is idle, its route renders ahead of any interaction. trade-off: both
// APIs are feature-detected; without them the hover/focus/touch path above
// still covers every link.
if (prefetch && 'IntersectionObserver' in window && 'requestIdleCallback' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target); // one-shot per element; fresh links re-observe after nav
      requestIdleCallback(() => prefetch(e.target.getAttribute('href'), 'viewport'));
    }
  });
  // observing an already-observed element is a no-op, so re-sweeping is cheap
  const observeLinks = () => {
    for (const a of document.querySelectorAll('a[href^="/"]')) io.observe(a);
  };
  observeLinks();
  // navigation swaps the container's innerHTML: re-observe the fresh links
  const __rawNav = __navigate;
  __navigate = (p) => __rawNav(p).then(observeLinks, () => {});
}
// Progressive-enhancement forms: <form method="POST"> backed by a server
// action. With JS the submit is intercepted and handed to postForm (one
// request, in-place adopt). Without JS the browser performs the native POST
// and the server re-renders the page: the same form works with JavaScript
// disabled, which Server Actions in other frameworks do not.
document.addEventListener('submit', (e) => {
  const f = e.target;
  if (!f || f.tagName !== 'FORM' || f.hasAttribute('data-on-submit')) return;
  if ((f.getAttribute('method') || '').toLowerCase() !== 'post') return;
  e.preventDefault();
  postForm(new FormData(f));
});
// Dev seam: the live signal graph, readable as JSON. Two callers, one
// implementation: the dev server's reload bridge snapshots it before a
// rebuild-triggered reload so the edit lands on the state the developer had,
// and a devtools extension reads it the same way. It is the same
// serializeState the zero-hydration resume already ships, so the only new
// bytes are the assignment.
window.__rosefn = { state: () => serializeState() };
// initial=true: DOM is SSR output, resume state + wire markers (zero hydration).
// If the document was rendered for a DIFFERENT route (a static-file server's
// SPA fallback serves index.html for unknown paths), adopt nothing - let the
// client router render the requested route from scratch.
const __st = document.getElementById('__rosefn_state');
let __state = __st ? JSON.parse(__st.textContent || '{}') : {};
// The dev server's reload bridge hands the pre-reload signal graph back inside
// the next document (window.__rosefn_resume). The resumed values win over the
// fresh render's, but the ROUTE stays the one the server just rendered - and
// the route renders client-side from the bundle rather than adopting the SSR
// DOM, because a resumed list can be longer than the document's rows and
// adoption could not add them. Absent in every non-dev document.
const __resumed = window.__rosefn_resume ? JSON.parse(window.__rosefn_resume) : null;
if (__resumed) {
  const __route = __state.__route;
  __state = Object.assign(__state, __resumed);
  __state.__route = __route;
}
if (__resumed) {
  start(__app, window.location.pathname);
} else if (__state.__route === window.location.pathname) {
  start(__app, window.location.pathname, true);
} else {
  start(__app, window.location.pathname);
}
`, { minify: true }).code;

// The document inlines its entire runtime, so rosefn can ship a STRICT
// content security policy without 'unsafe-inline' in script-src - the one
// thing every compared framework cannot do by default (their separate,
// often dynamically-named bundles force 'unsafe-inline' or nonce plumbing).
// The policy hashes the exact bytes of the inline module script (bundle +
// bootstrap), so the page's own code runs and nothing else does
// . style-src stays 'unsafe-inline' because the scoped
// component styles are inline <style> blocks: CSS cannot execute, and
// hashing every route-dependent style block would cost more than it buys.
// img/font stay data: (assets are inlined), connect/form stay 'self'
// (a rosefn app is one origin), and object/base/frame are locked down.
// A route exporting `headers = { ... }` overrides any of this per route.
// Mode B and the edge's no-build case share the external shape:
// /client.js plus a tiny inline bootstrap. There the hash covers exactly
// the bootstrap's bytes and 'self' covers the external modules - still no
// 'unsafe-inline' anywhere.
// The policy tail, shared by both script-src shapes so the two can never
// drift: only the script source differs between them.
const CSP_TAIL = `style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`;
let cspCache: { for: string | null; value: string } | null = null;
// The exact bytes between the external bootstrap's script tags - the single
// source of truth shared by the tag and the CSP hash, same contract as
// inlineScript: the policy can never drift from what actually ships.
const EXTERNAL_BOOTSTRAP = `\nimport { start, prefetch, postForm } from '/client.js';\n${BOOTSTRAP}`;
// The exact bytes between the module script's tags - the single source of
// truth shared by the tag and the CSP hash, so the policy can never drift
// from what actually ships.
function inlineScript(client: string): string {
  return `\n${client}\n${BOOTSTRAP}`;
}
/**
 * A fresh CSP nonce: 128 bits from the platform RNG, base64 - the syntax the
 * header and the tag share . Web Crypto on purpose: the same helper
 * serves the Node server and the edge adapter, and an edge runtime has no
 * node:crypto. Minted per response and never reused: a nonce is only worth
 * anything an attacker cannot predict, and a repeated one would hand a
 * guessed value unlimited script execution.
 */
export function mintNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw);
}

/**
 * The document's CSP. Two shapes, chosen per response:
 *
 * - no nonce (the default): `script-src 'sha256-…'` over the exact bytes the
 *   tag will carry. Nothing else may run - the strongest policy rosefn has,
 *   and the reason a rosefn document needs no 'unsafe-inline'.
 * - a nonce (a route exporting `csp = { nonce: true }`):
 *   `script-src 'nonce-…' 'strict-dynamic'`. A hash dies the moment anything
 *   between the server and the browser touches the document - a CDN, a WAF,
 *   an A/B injector that adds one byte blocks the page's own bundle. A nonce
 *   survives that, and 'strict-dynamic' lets the page's own code load more
 *   code (a third-party loader, a lazily imported chunk), which is the reason
 *   a deployment reaches for a nonce in the first place. It is weaker in one
 *   way: whatever the document's script loads is trusted. That is the trade
 *   the route opts into, per route, not a framework default.
 */
export function securityHeaders(client: string | null, nonce = ''): Record<string, string> {
  if (nonce) return { 'Content-Security-Policy': `script-src 'nonce-${nonce}' 'strict-dynamic'; ${CSP_TAIL}` };
  if (!cspCache || cspCache.for !== client) {
    // client === null: split mode (or the edge without a built client.js).
    // 'self' covers the external modules and chunks, the hash covers the
    // inline bootstrap - the same no-unsafe-inline guarantee as inline mode.
    const scriptSrc = client
      ? `'sha256-${createHash('sha256').update(inlineScript(client), 'utf-8').digest('base64')}'`
      : `'self' 'sha256-${createHash('sha256').update(EXTERNAL_BOOTSTRAP, 'utf-8').digest('base64')}'`;
    cspCache = {
      for: client,
      value: `script-src ${scriptSrc}; ${CSP_TAIL}`,
    };
  }
  return { 'Content-Security-Policy': cspCache.value };
}

// An inline SVG favicon (the rose). Without it every browser requests
// /favicon.ico on every page load - one wasted request per visit. A route
// can override it with its own <link rel="icon"> in a <head> block.
const FAVICON = '<link rel="icon" href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'><text y=\'.9em\' font-size=\'90\'>🌹</text></svg>">';

// Shared by the buffered shell and the streaming shell-open so both produce
// byte-identical static markup.
const STYLES = `
    body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; }
    button { padding: 0.5rem 1rem; font-size: 1rem; margin-right: 0.5rem; }
    a { color: #e91e63; text-decoration: none; font-weight: bold; }
    a:hover { text-decoration: underline; }
    nav a { margin-right: 1rem; }
    .rh { border-bottom: 2px solid #e91e63; margin-bottom: 1.5rem; padding-bottom: 0.75rem; }
    .rb { font-size: 1.25rem; }
    .rn { display: inline-block; margin-left: 1.5rem; }
    .rf { margin-top: 2rem; color: #888; font-size: 0.85rem; }
    ::view-transition-old(root), ::view-transition-new(root) { animation-duration: .18s; }
  `;

// The stylesheet ships inside every document, so its source formatting is a
// tax on every route: collapse whitespace outside strings once, here. The
// alternation leaves quoted content alone; selectors survive because no
// space is written around their combinators or pseudo colons above.
const STYLES_MIN = STYLES.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^"']+/g, (m) =>
  m[0] === '"' || m[0] === "'" ? m : m.replace(/\s+/g, ' ').replace(/\s*([:;{},])\s*/g, '$1').trim()
).trim();

/**
 * Merge the route chain's <head> blocks (document order: page first, then its
 * layouts) into one clean <head> fragment. First occurrence wins per key, so a
 * page overrides its layouts - matching the client's reverse-order applyHead.
 *
 * Bug report 2026.9.22 11:46: the keyed whitelist used to be title plus
 * meta/link/base and NOTHING else, so a `<style>` block, a
 * `<script type="application/ld+json">` data block and a `<noscript>`
 * fallback were dropped here in silence - the compiler collected them, the
 * merge threw them away, and a CMS theme system had no way to ship its
 * per-request CSS. Every head element now passes through: the keyed
 * singletons keep their name/property/rel/charset identity, and everything
 * else is keyed by id when it has one and by tag+position when it does not,
 * so two layouts' <style> blocks coexist and a page still overrides its
 * layout's. Passthrough elements carry HEAD_ATTR too (the attribute the
 * runtime manages) so a client-side navigation replaces or drops them like
 * any other managed element instead of leaking the previous route's CSS
 * into every route visited after it.
 */
function mergeHeadBlocks(blocks: string[]): string {
  const byKey = new Map<string, string>();
  const order: string[] = [];
  // positional keys: tag -> how many unkeyed elements of that tag came before
  const positional = new Map<string, number>();
  // first occurrence wins: blocks arrive page-first (a page renders inside its
  // layouts' <slot/>), so the page's title/meta override the layouts'
  const put = (key: string, html: string) => {
    if (!byKey.has(key)) {
      byKey.set(key, html);
      order.push(key);
    }
  };
  for (const block of blocks) {
    // title carries content, so it needs its own pattern
    for (const m of block.matchAll(/<title[^>]*>[\s\S]*?<\/title>/gi)) put('title', m[0]);
    // One pass over every other head element: a void tag (meta/link/base),
    // a paired one (style/script/noscript, and any tag a route writes), or a
    // self-closed one. The closing alternative is tried before the bare `>`
    // so a paired element keeps its content and a void one still matches.
    for (const m of block.matchAll(/<(\w+)((?:\s+[\w:-]+(?:=(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(?:\/>|>([\s\S]*?)<\/\1\s*>|>)/gi)) {
      const tag = m[1].toLowerCase();
      if (tag === 'title') continue; // handled above, with its own key
      const attrs = m[2];
      const keyMatch = attrs.match(/\s(?:name|property|rel|charset)=(?:"([^"]*)"|'([^']*)')/i);
      const idMatch = attrs.match(/\sid=(?:"([^"]*)"|'([^']*)')/i);
      let key: string;
      if (keyMatch) key = `${tag}:${keyMatch[1] ?? keyMatch[2]}`;
      else if (idMatch) key = `${tag}:${idMatch[1] ?? idMatch[2]}`;
      else {
        key = `${tag}:#${positional.get(tag) ?? 0}`;
        positional.set(tag, (positional.get(tag) ?? 0) + 1);
      }
      // keyed tags carry their key (must match HEAD_ATTR in the runtime) so
      // the client adopts these SSR-injected elements in place on the first
      // navigation instead of creating duplicates
      const marked = m[0].replace(/^<\w+/, (t) => `${t} data-rosefn-head="${key}"`);
      put(key, marked);
    }
  }
  return order.map((k) => byKey.get(k)!).join('\n  ');
}

/**
 * The script tag carrying the inlined bundle (+ bootstrap), or the external
 * fallback. `nonce` stamps the same value the CSP header carries, so
 * a route running a nonce policy has its own code allowed to run; without it
 * the tag is byte-identical to what the sha256 in the header was computed
 * over. Both tags in split mode get it: the external module and the inline
 * bootstrap are the same trust root.
 */
export function clientScriptTag(client: string | null, nonce = ''): string {
  const n = nonce ? ` nonce="${nonce}"` : '';
  return client
    ? `<script type="module"${n}>${inlineScript(client)}</script>`
    : `<script type="module"${n} src="/client.js"></script>\n<script type="module"${n}>${EXTERNAL_BOOTSTRAP}</script>`;
}

/**
 * The static half of the document for streaming SSR: everything up to (and
 * including) the open `<div id="app">`. No route tags - the route's <head>
 * content is applied by the client at boot from the body's head markers.
 *
 * `lang`/`dir` are the document's locale and reading direction ( the
 * servers compute them from the [lang] segment with the server bundle's
 * docAttrs). The streaming path flushes this string BEFORE the render, so
 * the browser gets the language metadata in the first byte.
 */
export function shellOpen(styles: string = getStyles(), lang = 'en', dir = ''): string {
  const styleTag = styles ? `\n  <style>${styles}</style>` : '';
  return `<!DOCTYPE html>
<html lang="${lang}"${dir ? ` dir="${dir}"` : ''}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Rosefn</title>
  <style>${STYLES_MIN}</style>${styleTag}
  ${FAVICON}
</head>
<body>
  <div id="app">`;
}

/** Build the document from an explicit client source (edge runtimes have no fs). */
export function buildShell(ssrHtml: string, stateJson: string, client: string | null, head: string[] = [], styles: string = getStyles(), js = true, lang = 'en', dir = '', nonce = ''): string {
  const clientTag = clientScriptTag(client, nonce);

  const mergedHead = mergeHeadBlocks(head);
  // a route-provided <title> replaces the default one
  const titleTag = /<title>/i.test(mergedHead) ? '' : '<title>Rosefn</title>';
  // a route-provided icon replaces the inline favicon
  const iconTag = /rel=["']?icon/i.test(mergedHead) ? '' : `\n  ${FAVICON}`;
  const headTags = mergedHead ? `\n  ${mergedHead}` : '';
  const styleTag = styles ? `\n  <style>${styles}</style>` : '';
 // js=false (a route exporting csr = false): the document
  // ends at the container - no state script, no inlined bundle, zero
  // JavaScript. The route's render function still rides in the bundle for
  // client-side navigation and the SPA fallback; only this document is
  // JS-free. Scoped styles stay: CSS is not JavaScript.
  //
  // P1-1 (bug report): a JS-free document is also DEMO-FREE. The #app wrapper
  // and the shell's own stylesheet existed for the client (the bootstrap
  // renders into #app; STYLES dresses the framework's demo). With no script
  // in the document they are pure pollution: the wrapper inserts an element
  // between the page's own CSS selectors and its content (div > p becomes
  // div > #app > p) and the demo's pink links / body padding outrank the
  // route's theme.css on equal specificity. So a zero-JS document is exactly
  // the route's own markup - nothing wrapped, nothing injected.
  const jsTail = js
    ? `\n  <script type="application/json" id="__rosefn_state">${stateJson}</script>\n  ${clientTag}`
    : '';
  const open = js ? '<div id="app">' : '';
  const close = js ? '</div>' : '';
  const shellStyles = js ? `\n  <style>${STYLES_MIN}</style>` : '';

  return `<!DOCTYPE html>
<html lang="${lang}"${dir ? ` dir="${dir}"` : ''}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">${headTags}${iconTag}
  ${titleTag}${shellStyles}${styleTag}
</head>
<body>
  ${open}${ssrHtml}${close}${jsTail}
</body>
</html>`;
}

/** Node entry: reads dist/client.js from disk (mtime-cached). */
export function getHtmlShell(ssrHtml: string, stateJson: string, head: string[] = [], js = true, lang = 'en', dir = '', nonce = ''): string {
  return buildShell(ssrHtml, stateJson, getClientSource(), head, getStyles(), js, lang, dir, nonce);
}
