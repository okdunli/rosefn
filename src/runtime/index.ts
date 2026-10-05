/**
 * rosefn Runtime - Zero-hydration, compile-time reactivity
 * Target: < 2KB gzipped
 */

// === Reactive Primitives ===

type Subscriber = () => void;
type Cleanup = () => void;
type SignalEntry = { value: unknown; subs: Set<Subscriber> };

let currentEffect: (() => void) | null = null;

// ponytail: global signal map, shared across all inlined modules
let signalMap: Map<string, SignalEntry> =
  (globalThis as any).__rosefn_signalMap ?? new Map();
(globalThis as any).__rosefn_signalMap = signalMap;

// One get-or-create helper shared by state / setState / resumeState.
function entry(key: string, initial: unknown): { value: unknown; subs: Set<Subscriber> } {
  const e = signalMap.get(key) ?? { value: initial, subs: new Set<Subscriber>() };
  signalMap.set(key, e);
  return e;
}

export function state<T>(key: string, initial: T): [() => T, (v: T) => void] {
  const e = entry(key, initial);

  const getter = () => {
    if (currentEffect) e.subs.add(currentEffect);
    return e.value as T;
  };

  const setter = (v: T) => {
    e.value = v;
    e.subs.forEach((fn: Subscriber) => fn());
  };

  return [getter, setter];
}

export function hasState(key: string): boolean {
  return signalMap.has(key);
}

export function setState<T>(key: string, value: T): void {
  const e = entry(key, value);
  e.value = value;
  e.subs.forEach((fn: Subscriber) => fn());
}

// Effects are tracked so client-side navigation can dispose the old ones.
// Each cleanup removes itself, so locally disposed effects do not leak.
const cleanups = new Set<Cleanup>();

export function effect(fn: () => void): Cleanup {
  const wrapped: Subscriber = () => {
    try {
      fn();
    } catch {
      // subscriber may be stale; ignore
    }
  };
  const prev = currentEffect;
  currentEffect = wrapped;
  fn();
  currentEffect = prev;
  const cleanup: Cleanup = () => {
    signalMap.forEach((e: { subs: Set<Subscriber> }) => e.subs.delete(wrapped));
    cleanups.delete(cleanup);
  };
  cleanups.add(cleanup);
  return cleanup;
}

// === HTML escaping (server-side interpolation safety) ===

const ESC_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

// === Reactive DOM wiring (client) ===

const MARK_RE = /^\u27e6([milh]):(\d+)\u27e7$/;
const END_RE = /^\u27e6\/([ilh]):(\d+)\u27e7$/;

// Comments already handled by a nested wire() pass (e.g. inside an adopted
// {#if} block) must not be re-processed by the outer pass with the wrong
// closes array. Node identity makes a WeakSet the cheapest guard.
const wired = new WeakSet<Node>();

/** Parse an html string into a DocumentFragment. */
export function tpl(html: string): DocumentFragment {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content;
}

// === Document head (<head> blocks) ===

// Marks the head elements rosefn manages, so stale ones can be removed when a
// route's head changes and user-authored <head> content is never touched.
// The SSR shell marks the elements it injects with the same attribute + key,
// so the runtime adopts them in place instead of creating duplicates on the
// first client-side navigation.
const HEAD_ATTR = 'data-rosefn-head';

/**
 * Apply one rendered <head> block to the document: <title> replaces the title,
 * <meta>/<link>/<base> are matched by name/property/rel/charset and updated
 * in place (or created). `provided` accumulates the keys of every block in the
 * route's head (a page renders inside its layouts, so several blocks apply per
 * navigation); keys it stops providing are dropped from the document.
 */
export function applyHead(html: string, provided: Set<string>): void {
  const frag = tpl(html);
  for (const el of Array.from(frag.children)) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'title') {
      // Manage the title element directly: the document.title setter would
      // update the FIRST title element in tree order - the inert placeholder
      // wire() is about to remove from the page body.
      let titleEl = document.head.querySelector('title');
      if (!titleEl) {
        titleEl = document.createElement('title');
        document.head.appendChild(titleEl);
      }
      titleEl.textContent = el.textContent ?? '';
      continue;
    }
    if (tag !== 'meta' && tag !== 'link' && tag !== 'base') continue;
    const key = el.getAttribute('name')
      ?? el.getAttribute('property')
      ?? el.getAttribute('rel')
      ?? el.getAttribute('charset');
    if (!key) continue;
    const managed = `${tag}:${key}`;
    provided.add(managed);
    let target = document.head.querySelector(`[${HEAD_ATTR}="${managed}"]`);
    if (!target) {
      target = document.createElement(tag);
      target.setAttribute(HEAD_ATTR, managed);
      document.head.appendChild(target);
    }
    for (const a of Array.from(el.attributes)) target.setAttribute(a.name, a.value);
    target.textContent = el.textContent;
  }
  // Drop managed meta/link/base the new head no longer provides. The title
  // persists across routes that don't declare one (standard SPA behavior).
  document.head.querySelectorAll(`[${HEAD_ATTR}]`).forEach((el) => {
    if (!provided.has(el.getAttribute(HEAD_ATTR)!)) el.remove();
  });
}

/** Drop every rosefn-managed head element (routes without <head> blocks). */
export function clearHead(): void {
  document.head.querySelectorAll(`[${HEAD_ATTR}]`).forEach((el) => el.remove());
}

/**
 * Wire reactive markers inside `root` to the closures in `closes`.
 * Works on the live SSR DOM (adoption) and on freshly parsed fragments.
 * Returns a disposer for every effect it created.
 */
export function wire(root: Node, closes: Array<unknown>, scope?: unknown): Cleanup {
  let holder: Node = root;
  if (root.nodeType === 11) {
    // DocumentFragment: wrap so querySelectorAll sees the root element too
    const div = document.createElement('div');
    div.appendChild(root);
    holder = div;
  }

  const created: Cleanup[] = [];
  const weff = (fn: () => void) => created.push(effect(fn));

  const comments: Comment[] = [];
  const walker = document.createTreeWalker(holder, NodeFilter.SHOW_COMMENT);
  while (walker.nextNode()) comments.push(walker.currentNode as Comment);

  const ends = new Map<number, Comment>();
  for (const c of comments) {
    const m = (c.nodeValue ?? '').match(END_RE);
    if (m) ends.set(+m[2], c);
  }

  // Head blocks are collected during the walk and applied afterwards in
  // REVERSE document order: a page renders inside its layout's <slot/>, so its
  // block comes first in the document - applying last makes the page win.
  // `provided` is shared by every block of this route so a layout-only key
  // (e.g. a generator meta) survives alongside the page's own keys.
  const headBlocks: Array<{ idx: number; start: Comment; end: Comment; nodes: ChildNode[] }> = [];
  const headProvided = new Set<string>();

  for (const c of comments) {
    if (wired.has(c) || !c.parentNode) continue;
    wired.add(c);
    const m = (c.nodeValue ?? '').match(MARK_RE);
    if (!m) continue;
    const kind = m[1];
    const idx = +m[2];

    if (kind === 'h') {
      // Document head: the closure re-renders the <head> block (no inner
      // markers), so one effect drives title/meta for this route.
      const end = ends.get(idx);
      if (!end) continue;
      const nodes: ChildNode[] = [];
      let n: ChildNode | null = c.nextSibling;
      while (n && n !== end) {
        const nx = n.nextSibling;
        nodes.push(n);
        n = nx;
      }
      headBlocks.push({ idx, start: c, end, nodes });
    } else if (kind === 'm') {
      // Text: update the text node that follows the marker comment
      let target = c.nextSibling;
      if (!target || target.nodeType !== 3) {
        target = document.createTextNode('');
        c.parentNode!.insertBefore(target, c.nextSibling);
      }
      const tn = target as Text;
      weff(() => {
        tn.nodeValue = String((closes[idx] as (s?: unknown) => unknown)(scope));
      });
    } else if (kind === 'i') {
      // Conditional block: first run adopts the server-rendered content in
      // place (node identity preserved); later runs swap in a fresh clone.
      const anchor = c;
      const end = ends.get(idx);
      if (!end) continue;
      const st = anchor as unknown as { __st?: { nodes: Node[]; disp: Cleanup }; __ever?: boolean };
      weff(() => {
        if (st.__st) {
          st.__st.nodes.forEach((n) => (n as ChildNode).remove());
          st.__st.disp();
          st.__st = undefined;
        }
        const r = (closes[idx] as (s?: unknown) => unknown)(scope) as { html: string; closes: unknown[] } | null;
        if (!r) return;
        // First run adopts the server-rendered content (move out, wire, move
        // back - identity preserved); later runs clone the block template.
        // In both cases the nodes land just before the end anchor.
        let frag: DocumentFragment;
        if (st.__ever) {
          frag = tpl(r.html);
        } else {
          st.__ever = true;
          frag = document.createDocumentFragment();
          let n = anchor.nextSibling;
          while (n && n !== end) {
            const nx = n.nextSibling;
            frag.appendChild(n);
            n = nx;
          }
        }
        const disp = wire(frag, r.closes, scope);
        const nodes = Array.from(frag.childNodes);
        const parent = anchor.parentNode!;
        for (const nd of nodes) parent.insertBefore(nd, anchor.nextSibling);
        st.__st = { nodes, disp };
      });
    } else {
      // List: rebuild items between the start and end anchors
      const start = c;
      const end = ends.get(idx);
      if (!end) continue;
      const st = start as unknown as { __disp?: Cleanup };
      weff(() => {
        if (st.__disp) {
          st.__disp();
          st.__disp = undefined;
        }
        const items = (closes[idx] as (s?: unknown) => unknown)(scope) as Array<{ html: string; closes: unknown[]; scope?: unknown }>;
        let n = start.nextSibling;
        while (n && n !== end) {
          const nx = n.nextSibling;
          n.remove();
          n = nx;
        }
        const parent = start.parentNode!;
        const disps: Cleanup[] = [];
        for (const r of items) {
          const frag = tpl(r.html);
          disps.push(wire(frag, r.closes, r.scope));
          for (const nd of Array.from(frag.childNodes)) parent.insertBefore(nd, end);
        }
        st.__disp = () => disps.forEach((d) => d());
      });
    }
  }

  // Apply head blocks in reverse document order (page over layout), then drop
  // the inert placeholder nodes from the page body. A top-level wire with no
  // head blocks (route without <head>) clears the previous route's managed
  // head; nested wires (if/each blocks) never contain head blocks.
  for (let i = headBlocks.length - 1; i >= 0; i--) {
    const { idx, start, end, nodes } = headBlocks[i];
    weff(() => applyHead(String((closes[idx] as (s?: unknown) => unknown)(scope)), headProvided));
    nodes.forEach((nd) => nd.remove());
    start.remove();
    end.remove();
  }
  if (headBlocks.length === 0 && root.nodeType !== 11) clearHead();

  // Attributes: data-b="K:attrName"
  const els = (holder as Element).querySelectorAll('[data-b]');
  els.forEach((el) => {
    const spec = el.getAttribute('data-b')!;
    const sep = spec.indexOf(':');
    const idx = +spec.slice(0, sep);
    const attr = spec.slice(sep + 1);
    el.removeAttribute('data-b');
    weff(() => {
      el.setAttribute(attr, String((closes[idx] as (s?: unknown) => unknown)(scope)));
    });
  });

  if (holder !== root) {
    while (holder.firstChild) root.appendChild(holder.firstChild);
  }

  return () => created.forEach((fn) => fn());
}

export function resetEffects(): void {
  cleanups.forEach((fn) => fn());
  cleanups.clear();
}

// === Server Data Fetching ($data) ===

// ponytail: cache keyed by function source, cleared per request/navigation.
// Upgrade path: explicit keys if two $data calls share identical source.
let dataCache = new Map<string, Promise<unknown>>();

export function $data<T>(fn: () => T | Promise<T>): Promise<T> {
  const key = fn.toString();
  let p = dataCache.get(key);
  if (!p) {
    p = Promise.resolve(fn());
    dataCache.set(key, p);
  }
  return p as Promise<T>;
}

// Per-request isolation: state + data cache reset before each SSR render.
// The request context bag is NOT reset here: it is owned by the middleware
// pass (runMiddleware), which resets it once per request before the
// middleware runs - clearing it here would wipe what the middleware just
// set for this very render.
export function clearRequestState(): void {
  signalMap.clear();
  dataCache.clear();
}

// === Request context ===
// A per-request bag: pages/_middleware.rose fills it (getContext().user =
// ...) and $data, server actions and api handlers read it. Server-only by
// construction - the client bundle's copy stays empty because $data never
// runs there (state arrives serialized).
let requestContext: Record<string, unknown> = {};

export function getContext(): Record<string, unknown> {
  return requestContext;
}

/** Fresh bag for a new request - runMiddleware() calls this before the middleware. */
export function resetRequestContext(): void {
  requestContext = {};
}

/**
 * Run an async render against a THROWAWAY signal map + data cache + mount
 * queue + cleanup set, returning the rendered result plus the signal entries,
 * the onMount callbacks and the onCleanup disposers it produced.
 *
 * Used by link prefetch: rendering the hovered route ahead of navigation must
 * not touch the live page's state (or queue its mounts / register its
 * cleanups), but the paint that consumes the entry later needs exactly those
 * things - compiled getters close over entry OBJECTS, so restoreState()
 * transplants them wholesale instead of copying values, the captured mounts
 * replay after the prefetched DOM is wired, and adoptCleanups() re-registers
 * the captured disposers so the NEXT resetEffects() disposes them (a prefetch
 * render's cleanups firing early would dispose a route that was never
 * painted, and dropping them would leak the painted route's timers).
 * Concurrent prefetches are queued by the caller (ponytail: hover prefetches
 * are rare and cheap).
 */
export async function isolateStateAsync<T>(
  fn: () => Promise<T>
): Promise<{ result: T; state: Map<string, SignalEntry>; mounts: Array<() => void>; cleanups: Set<Cleanup> }> {
  const savedSignals = signalMap;
  const savedData = dataCache;
  const savedMounts = mountQueue.splice(0, mountQueue.length);
  const savedCleanups = new Set(cleanups);
  cleanups.clear();
  signalMap = new Map();
  dataCache = new Map();
  try {
    const result = await fn();
    return {
      result,
      state: signalMap,
      mounts: mountQueue.splice(0, mountQueue.length),
      cleanups: new Set(cleanups),
    };
  } finally {
    signalMap = savedSignals;
    dataCache = savedData;
    mountQueue.splice(0, 0, ...savedMounts); // prepend what was queued before
    cleanups.clear();
    savedCleanups.forEach((fn: Cleanup) => cleanups.add(fn));
  }
}

/** Adopt a prefetched route's signal entries (objects keep their subs). */
export function restoreState(entries: Map<string, SignalEntry>): void {
  signalMap.clear();
  entries.forEach((e: SignalEntry, k: string) => signalMap.set(k, e));
}

// === Serialization (for zero-hydration resume) ===

export function serializeState(): string {
  const obj: Record<string, unknown> = {};
  signalMap.forEach((v: { value: unknown }, k: string) => (obj[k] = v.value));
  return JSON.stringify(obj);
}

export function resumeState(json: string): void {
  try {
    const obj = JSON.parse(json);
    Object.entries(obj).forEach(([k, v]) => {
      entry(k, v).value = v;
    });
  } catch {
    // ignore corrupt state
  }
}

// === Client-side route refresh ===
// The client entry registers the re-render here at boot; components import
// refresh() like state() and call it from any handler - the client half of
// router.refresh() (Next.js) / invalidateAll() (SvelteKit). No hook (server
// render, or before the entry loads) -> a resolved no-op.
let refreshHook: (() => Promise<void>) | null = null;

export function setRefreshHook(fn: () => Promise<void>): void {
  refreshHook = fn;
}

export function refresh(): Promise<void> {
  return refreshHook ? refreshHook() : Promise.resolve();
}

// === Lifecycle ===
// Client-only. onMount queues a callback; the client entry flushes the queue
// after wire() completes - initial adoption, client-side navigation, prefetch
// paint, action adopt: every paint path. onCleanup registers a disposer into
// the same set effects use, so resetEffects() (called before every re-render)
// disposes the previous route's cleanups. On the server there is no DOM:
// onMount never queues and never fires.
const mountQueue: Array<() => void> = [];

export function onMount(fn: () => void): void {
  if (typeof document === 'undefined') return; // server render: nothing mounts
  mountQueue.push(fn);
}

/** Drop queued mounts - a failed render leaves stale callbacks behind. */
export function clearMounts(): void {
  mountQueue.length = 0;
}

/** Run and clear the queue; the client entry calls this after every wire(). */
export function flushMounts(): void {
  const q = mountQueue.splice(0, mountQueue.length);
  for (const fn of q) fn();
}

/** Register a disposer for the current render (the effects' cleanup channel). */
export function onCleanup(fn: Cleanup): void {
  cleanups.add(fn);
}

/**
 * Adopt a prefetched route's captured onCleanup disposers after its cached
 * paint lands: the next resetEffects() (before the following re-render) then
 * disposes them like any live route's. Without this the prefetched paint's
 * mounts would start timers nothing ever clears.
 */
export function adoptCleanups(fns: Iterable<Cleanup>): void {
  for (const fn of fns) cleanups.add(fn);
}

// === i18n: localized routes (innovation #27) ===
// Every JSON file in src/locales/ is a language: { "key": "string" }. The
// bundle entries call setLocales() once at boot - server, edge and client
// alike - so $t resolves on both sides with no per-request plumbing, and a
// client-side switch between locales renders from the bundle: zero requests.
// ponytail: flat keys + {name} interpolation only - no plurals, no ICU.
// A missing key renders the key itself: loud in dev, greppable in prod.
let LOCALES: Record<string, Record<string, string>> = {};
let DEFAULT_LOCALE = 'en';

export function setLocales(dicts: Record<string, Record<string, string>>, def: string): void {
  LOCALES = dicts;
  DEFAULT_LOCALE = def;
}

export function localeList(): string[] {
  return Object.keys(LOCALES);
}

export function isLocale(lang: string): boolean {
  return Object.prototype.hasOwnProperty.call(LOCALES, lang);
}

/**
 * Best match for an Accept-Language header among the known locales, or null
 * when it expresses no preference (absent, empty, or the `*` wildcard - which
 * Node's own fetch sends by default). A caller negotiates only on a real
 * preference; everything else serves the default locale's page in place.
 */
export function bestLocale(header: string | null | undefined): string | null {
  for (const part of (header || '').split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase();
    if (!tag || tag === '*') continue;
    if (isLocale(tag)) return tag;
    const base = tag.split('-')[0];
    if (isLocale(base)) return base;
  }
  return null;
}

/**
 * Translate a key for the current language. The [lang] route param arrives
 * as state before the render (the same seeding as any dynamic param), and
 * reading it through the signal getter makes $t reactive: switching locale
 * re-runs the marker, so only the translated nodes repaint.
 */
export function $t(key: string, vars?: Record<string, string>): string {
  const [lang] = state('lang', DEFAULT_LOCALE);
  const dict = LOCALES[lang()] ?? LOCALES[DEFAULT_LOCALE] ?? {};
  let s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
  if (vars) for (const k in vars) s = s.split(`{${k}}`).join(vars[k]);
  return s;
}

// --- Phase 2: the shared server store ----------------------------------------
//
// Module scope (`export const store = {...}`) is per-PROCESS: under the
// cluster every worker holds its own copy, so a guestbook signed on worker
// A is invisible to worker B - the classic "it works in dev, loses data in
// production" bug. `$store` keeps the ergonomics of a plain object you read
// synchronously, while every write is broadcast to the other workers through
// a transport hook. Reads never wait on anything: each process holds the
// full state locally and a patch arrives asynchronously (milliseconds on one
// machine, and the transport seam is where a redis bus would plug in).
//
// ponytail: one driver (memory + cluster IPC) covers every single-machine
// deploy, which is exactly what `rosefn serve` gives you. A cross-machine
// driver is the documented next step - it needs a client library, and
// setStoreTransport() below is the seam it plugs into.

const STORES = new Map<string, { value: unknown }>();
let storeTransport: ((name: string, value: unknown) => void) | null = null;

/**
 * Install the cross-process transport. The generated server entry wires the
 * cluster channel; a standalone process (dev, preview) installs none - one
 * process is one copy, which is already correct. Pass null to detach.
 */
export function setStoreTransport(fn: ((name: string, value: unknown) => void) | null): void {
  storeTransport = fn;
}

/** Apply a patch that arrived from another process (the transport's receiver
 * calls this; a store nobody opened yet is ignored - it has no reader). */
export function applyStorePatch(name: string, value: unknown): void {
  const entry = STORES.get(name);
  if (entry) entry.value = value;
}

/**
 * A named store shared by every request in this process - and, through the
 * transport, by every worker. Read it inside `$data` or a server action:
 * those are the server-only paths. A bare read in a render body is a local
 * snapshot, and on the client (where the store map is per page load and no
 * patch ever arrives) that snapshot is the initial value.
 *
 * Values must be JSON-serializable: the transport serializes them, exactly
 * like the state patch that already rides in every document.
 */
export function $store<T>(name: string, initial: T): { get(): T; set(v: T): void; update(fn: (v: T) => T): void } {
  let entry = STORES.get(name);
  if (!entry) {
    entry = { value: initial };
    STORES.set(name, entry);
  }
  const box = entry;
  return {
    get: () => box.value as T,
    set: (v: T) => {
      box.value = v;
      storeTransport?.(name, v);
    },
    update: (fn: (v: T) => T) => {
      box.value = fn(box.value as T);
      storeTransport?.(name, box.value);
    },
  };
}

// --- Phase 1: cookie helpers -------------------------------------------------
//
// Sessions are the first thing every real app needs and the easiest thing to
// get subtly wrong (a missing HttpOnly is an XSS-readable session; a missing
// SameSite is a CSRF-readable one). These two are the whole cookie job with
// the safe defaults baked in, so nobody hand-rolls the header string.

/**
 * Parse the cookies of a request (server) or of this document (client, where
 * HttpOnly cookies are invisible by design - that is the point of HttpOnly).
 */
export function $cookies(request?: Request): Record<string, string> {
  const raw = request
    ? request.headers.get('cookie')
    : (typeof document !== 'undefined' ? document.cookie : '');
  const out: Record<string, string> = {};
  for (const part of (raw || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Build a Set-Cookie header VALUE for a session cookie with the safe
 * defaults: HttpOnly, SameSite=Lax, Path=/, a 7-day Max-Age. `secure` is the
 * one attribute a helper cannot infer (it depends on the deployment's TLS),
 * so pass it when serving over https - and SameSite=None forces Secure,
 * because every modern browser rejects that pairing otherwise.
 */
export function $sessionCookie(
  name: string,
  value: string,
  opts: { path?: string; maxAge?: number; sameSite?: 'Strict' | 'Lax' | 'None'; secure?: boolean; httpOnly?: boolean } = {}
): string {
  const { path = '/', maxAge = 60 * 60 * 24 * 7, sameSite = 'Lax', secure = false, httpOnly = true } = opts;
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    `SameSite=${sameSite}`,
    httpOnly ? 'HttpOnly' : '',
    secure || sameSite === 'None' ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}
