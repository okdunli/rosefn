

import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { createHash } from 'crypto';

const OUT_DIR = path.join(process.cwd(), 'dist');

let clientCache: { mtimeMs: number; source: string } | null = null;

let splitMode = false;
export function setBundleMode(mode: string): void {
  splitMode = mode === 'split';
}

/** Read dist/client.js with an mtime-based cache (dev server rebuilds it). */
export function getClientSource(): string | null {
  if (splitMode) return null;
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

// Read dist/styles.css (every component's scoped <style>, merged at build time) with an mtime-based cache.
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

const BOOTSTRAP_SOURCE = `
// shell = false: the document's SSR content sits directly in <body> - no
// #app wrapper, no demo styles, so a real theme's CSS owns the document from
// the first byte (and a JS-less visitor never sees either). The bundle still
// runs, and it still needs its container: wrap the content once, here, before
// any theme script executes (module scripts run before DOMContentLoaded). The
// wrapper is a plain unstyled div, so the re-parent is visually inert; every
// later path - adoption, navigation, forms - is then the ordinary one.
let __app = document.getElementById('app');
if (!__app) {
  __app = document.createElement('div');
  __app.id = 'app';
  // scripts stay outside the wrapper, exactly where the dressed document
  // keeps them: the state element and the running module must survive a
  // navigation's innerHTML swap (they are the document's, not the route's).
  for (const node of Array.from(document.body.children)) {
    if (node.tagName !== 'SCRIPT') __app.appendChild(node);
  }
  document.body.appendChild(__app);
}
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
// Dev seam: the live signal graph, readable as JSON. Three callers, one
// implementation: the dev server's reload bridge snapshots it before a
// rebuild-triggered reload so the edit lands on the state the developer had,
// and the devtools extension (devtools/) reads it the same way - the signal
// graph plus the prefetch counters, which is the whole observable state of a
// running page. Both are DIRECT references (no wrapper arrow): the names take
// no arguments, so the call is identical and every document that carries the
// bundle pays eleven bytes for the pair instead of forty.
window.__rosefn = { state: serializeState, prefetch: prefetchStats };
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
// A NOT-FOUND document (the server stamps __notFound onto its state) boots
// into the app's own 404 route: the URL matches no route - or a catch-all
// whose resolver threw notFound(), whose key sits null in the resumed state
// and whose template would dereference it into a 500. startNotFound paints
// the not-found route from the resumed state instead (zero requests).
if (__state.__notFound) {
  startNotFound(__app, window.location.pathname);
} else if (__resumed) {
  start(__app, window.location.pathname);
} else if (__state.__route === window.location.pathname) {
  start(__app, window.location.pathname, true);
} else {
  start(__app, window.location.pathname);
}
`;
let BOOTSTRAP_CACHE: string | null = null;
function bootstrap(): string {
  if (BOOTSTRAP_CACHE === null) {
    if ((globalThis as any).__ROSEFN_SKIP_MINIFY) {
      BOOTSTRAP_CACHE = BOOTSTRAP_SOURCE;
    } else {
      try {
        BOOTSTRAP_CACHE = esbuild.transformSync(BOOTSTRAP_SOURCE, { minify: true }).code;
      } catch {
        BOOTSTRAP_CACHE = BOOTSTRAP_SOURCE;
      }
    }
  }
  return BOOTSTRAP_CACHE;
}

const CSP_TAIL = `style-src 'unsafe-inline'; img-src 'self' data: https://fastly.picsum.photos; font-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`;
let cspCache: { for: string | null; value: string } | null = null;
let EXTERNAL_BOOTSTRAP_CACHE: string | null = null;
function externalBootstrap(): string {
  if (EXTERNAL_BOOTSTRAP_CACHE === null) EXTERNAL_BOOTSTRAP_CACHE = `\nimport { start, startNotFound, prefetch, postForm, prefetchStats, serializeState } from '/client.js';\n${bootstrap()}`;
  return EXTERNAL_BOOTSTRAP_CACHE;
}
function inlineScript(client: string): string {
  const m = /\bexport\s*\{([^}]*)\}\s*;?\s*$/.exec(client);
  let body = client;
  let aliases = "";
  if (m) {
    body = client.slice(0, m.index) + client.slice(m.index + m[0].length);
    aliases = m[1]
      .split(",")
      .map((pair) => {
        const parts = pair.split(" as ").map((x) => x.trim());
        if (parts.length === 1 || parts[0] === parts[1]) return "";
        return parts[0] && parts[1] ? `var ${parts[1]} = ${parts[0]};` : "";
      })
      .join("");
  }
  return `\n${body}\n${aliases}\n${bootstrap()}`;
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
    const scriptSrc = client
      ? `'sha256-${createHash('sha256').update(inlineScript(client), 'utf-8').digest('base64')}'`
      : `'self' 'sha256-${createHash('sha256').update(externalBootstrap(), 'utf-8').digest('base64')}'`;
    cspCache = {
      for: client,
      value: `script-src ${scriptSrc}; ${CSP_TAIL}`,
    };
  }
  return { 'Content-Security-Policy': cspCache.value };
}

const FAVICON = '<link rel="icon" href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'><text y=\'.9em\' font-size=\'90\'>🌹</text></svg>">';

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
  const positional = new Map<string, number>();
  const put = (key: string, html: string) => {
    if (!byKey.has(key)) {
      byKey.set(key, html);
      order.push(key);
    }
  };
  for (const block of blocks) {
    for (const m of block.matchAll(/<title[^>]*>[\s\S]*?<\/title>/gi)) put('title', m[0]);
    for (const m of block.matchAll(/<(\w+)((?:\s+[\w:-]+(?:=(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(?:\/>|>([\s\S]*?)<\/\1\s*>|>)/gi)) {
      const tag = m[1].toLowerCase();
      if (tag === 'title') continue;
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
    : `<script type="module"${n} src="/client.js"></script>\n<script type="module"${n}>${externalBootstrap()}</script>`;
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
export function shellOpen(styles: string = getStyles(), lang = 'en', dir = '', shell = true): string {
  const styleTag = styles ? `\n  <style>${styles}</style>` : '';
  const demoStyles = shell ? `\n  <style>${STYLES_MIN}</style>` : '';
  const appOpen = shell ? `\n  <div id="app">` : '';
  return `<!DOCTYPE html>
<html lang="${lang}"${dir ? ` dir="${dir}"` : ''}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Rosefn</title>${demoStyles}${styleTag}
  ${FAVICON}
</head>
<body>${appOpen}`;
}

/** Build the document from an explicit client source (edge runtimes have no fs). */
export function buildShell(ssrHtml: string, stateJson: string, client: string | null, head: string[] = [], styles: string = getStyles(), js = true, lang = 'en', dir = '', nonce = '', shell = true): string {
  const clientTag = clientScriptTag(client, nonce);

  const mergedHead = mergeHeadBlocks(head);
  const headStamped = nonce
    ? mergedHead.replace(/<script\b([^>]*)>/gi, (m, attrs: string) => (/\bnonce=/.test(attrs) ? m : `<script${attrs} nonce="${nonce}">`))
    : mergedHead;
  let htmlAttrs = ` lang="${lang}"${dir ? ` dir="${dir}"` : ''}`;
  let bodyAttrs = '';
  const headClean = headStamped.replace(/<(html|body)\b([^>]*)>/gi, (_m, tag: string, attrs: string) => {
    const clean = attrs.replace(/\s*data-rosefn-head="[^"]*"/, '');
    if (tag === 'html') htmlAttrs = clean;
    else bodyAttrs = clean;
    return '';
  });
  const titleTag = /<title>/i.test(mergedHead) ? '' : '<title>Rosefn</title>';
  const iconTag = /rel=["']?icon/i.test(mergedHead) ? '' : `\n  ${FAVICON}`;
  const headTags = headClean ? `\n  ${headClean}` : '';
  const styleTag = styles ? `\n  <style>${styles}</style>` : '';
  const stateSafe = stateJson.replace(/</g, '\\u003c');
  const jsTail = js
    ? `\n  <script type="application/json" id="__rosefn_state">${stateSafe}</script>\n  ${clientTag}`
    : '';
  const open = js && shell ? '<div id="app">' : '';
  const close = js && shell ? '</div>' : '';
  const shellStyles = js && shell ? `\n  <style>${STYLES_MIN}</style>` : '';

  return `<!DOCTYPE html>
<html${htmlAttrs}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">${headTags}${iconTag}
  ${titleTag}${shellStyles}${styleTag}
</head>
<body${bodyAttrs}>
  ${open}${ssrHtml}${close}${jsTail}
</body>
</html>`;
}

/** Node entry: reads dist/client.js from disk (mtime-cached). */
export function getHtmlShell(ssrHtml: string, stateJson: string, head: string[] = [], js = true, lang = 'en', dir = '', nonce = '', shell = true): string {
  return buildShell(ssrHtml, stateJson, getClientSource(), head, getStyles(), js, lang, dir, nonce, shell);
}
