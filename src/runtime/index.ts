// Rosefn Runtime - Zero-hydration, compile-time reactivity Target: < 2KB gzipped

type Subscriber = () => void;
type Cleanup = () => void;
type SignalEntry = { value: unknown; subs: Set<Subscriber> };

let currentEffect: (() => void) | null = null;

let signalMap: Map<string, SignalEntry> =
  (globalThis as any).__rosefn_signalMap ?? new Map();
(globalThis as any).__rosefn_signalMap = signalMap;

function entry(key: string, initial: unknown): { value: unknown; subs: Set<Subscriber> } {
  const e = signalMap.get(key) ?? { value: initial, subs: new Set<Subscriber>() };
  signalMap.set(key, e);
  return e;
}

export function state<T>(key: string, initial: T): [() => T, (v: T) => void] {
  ownerKeys()?.add(key);
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

const cleanups = new Set<Cleanup>();

let fxOwner: object | null = null;
const fxByOwner = new WeakMap<object, Set<Cleanup>>();
const keysByOwner = new WeakMap<object, Set<string>>();
const fxSet = (): Set<Cleanup> => {
  if (!fxOwner) return cleanups;
  let s = fxByOwner.get(fxOwner);
  if (!s) { s = new Set(); fxByOwner.set(fxOwner, s); }
  return s;
};
const ownerKeys = (): Set<string> | null => {
  if (!fxOwner) return null;
  let s = keysByOwner.get(fxOwner);
  if (!s) { s = new Set(); keysByOwner.set(fxOwner, s); }
  return s;
};

// Attribute everything the current render creates to `container` (null = the document's global bookkeeping).
export function setFxOwner(container: object | null): void {
  fxOwner = container;
}

// Dispose everything ONE container created - its effects, its onCleanups, the state keys its render seeded.
export function resetContainerFx(container: object): void {
  const set = fxByOwner.get(container);
  if (set) {
    set.forEach((fn: Cleanup) => fn());
    fxByOwner.delete(container);
  }
  const keys = keysByOwner.get(container);
  if (keys) {
    keys.forEach((k: string) => signalMap.delete(k));
    keysByOwner.delete(container);
  }
  dataCache.clear();
  pendingDeltas.clear();
}

export function effect(fn: () => void): Cleanup {
  const wrapped: Subscriber = () => {
    try {
      fn();
    } catch {
      
    }
  };
  const prev = currentEffect;
  currentEffect = wrapped;
  fn();
  currentEffect = prev;
  const cleanup: Cleanup = () => {
    signalMap.forEach((e: { subs: Set<Subscriber> }) => e.subs.delete(wrapped));
    fxSet().delete(cleanup);
  };
  fxSet().add(cleanup);
  return cleanup;
}

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

type Close = (s?: unknown) => unknown;

export function textMark(closes: Close[], fn: Close, pair?: boolean, arg?: unknown): string {
  const i = closes.push(fn) - 1;
  return `<!--\u27e6m:${i}\u27e7-->` + esc(fn(arg)) + (pair ? `<!--\u27e6/m:${i}\u27e7-->` : '');
}

export function attrMark(closes: Close[], fn: Close, name: string, arg?: unknown): string {
  const i = closes.push(fn) - 1;
  return `${name}="${esc(fn(arg))}" data-b="${i}:${name}"`;
}

export function ifMark(
  closes: Close[],
  cond: Close,
  fn: (s: unknown, c: Close[]) => unknown,
  scope?: unknown
): string {
  let snap: { html: string; closes: Close[] } | null = null;
  const i = closes.push(() => {
    if (!cond()) {
      snap = null;
      return null;
    }
    if (!snap) {
      snap = { html: String(fn(scope, closes)), closes };
    }
    return snap;
  }) - 1;
  const r = closes[i]() as { html: string } | null;
  return `<!--\u27e6i:${i}\u27e7-->` + (r ? r.html : '') + `<!--\u27e6/i:${i}\u27e7-->`;
}

export function eachMark(closes: Close[], items: Close, fn: (s: unknown, c: Close[]) => unknown): string {
  const i = closes.push(() => (items() as unknown[]).map((v) => {
    return { html: String(fn(v, closes)), closes, scope: v };
  })) - 1;
  let h = `<!--\u27e6l:${i}\u27e7-->`;
  for (const r of closes[i]() as Array<{ html: string }>) h += r.html;
  return h + `<!--\u27e6/l:${i}\u27e7-->`;
}

export function headMark(closes: Close[], fn: Close): string {
  const i = closes.push(fn) - 1;
  return `<!--\u27e6h:${i}\u27e7-->` + fn() + `<!--\u27e6/h:${i}\u27e7-->`;
}

/**
 * P1-2 (bug report): TRUSTED HTML - the explicit reverse of esc(). `{@html x}`
 * emits the value verbatim, so a CMS's rich text renders as markup instead of
 * as escaped source.
 *
 * The markers are an {#if} block's on purpose: wire() already knows how to
 * adopt the server's nodes in place (identity preserved - an embedded iframe
 * does not reload) and to swap the range for a fresh parse when the value
 * changes. Reusing that machinery costs this function and nothing else: no
 * new marker kind, no new wire branch, no bytes in a document that never
 * uses it. The close returns the same {html, closes} shape an {#if} block
 * does, with the RENDER's array - trusted html is usually opaque markup
 * with no markers inside, but when a loader's value was itself rendered
 * inside this same pass (a theme skin built from another composable) the
 * markers it carries belong to this array, and a nested wire() pass must be
 * able to resolve them. `arg` is the enclosing block's scope value, exactly
 * as textMark takes it: a `{@html row.body}` inside an {#each} resolves
 * against the row.
 */
export function rawMark(closes: Close[], fn: Close, arg?: unknown): string {
  const i = closes.push((s?: unknown) => ({ html: String((fn as (a?: unknown) => unknown)(s) ?? ''), closes })) - 1;
  const r = closes[i](arg) as { html: string };
  return `<!--\u27e6i:${i}\u27e7-->` + r.html + `<!--\u27e6/i:${i}\u27e7-->`;
}

/**
 * A named slot's block. The child rendered its slot content into the
 * render's shared array scoped to the slot object; the block wraps it in
 * markers from the SAME index space, so the ids stay unique across the whole
 * composition (a plain <slot/> inlines the children html directly and needs
 * none of this). Lives here rather than in the compiler's emitted helper
 * string so the array is the one the rest of the render uses.
 */
export function slotBlockMark(
  closes: Close[],
  hit: { o: Record<string, unknown>; fn: (o: unknown, c: Close[]) => unknown } | null
): string {
  if (!hit) return '';
  const i = closes.push(() => {
    if (!hit) return null;
    return { html: String(hit.fn(hit.o, closes)), closes, scope: hit.o };
  }) - 1;
  return `<!--\u27e6i:${i}\u27e7-->` + String(hit.fn(hit.o, closes)) + `<!--\u27e6/i:${i}\u27e7-->`;
}

const MARK_RE = /^\u27e6([milh]):(\d+)\u27e7$/;
const END_RE = /^\u27e6\/([milh]):(\d+)\u27e7$/;

const wired = new WeakSet<Node>();

/** Parse an html string into a DocumentFragment. */
export function tpl(html: string): DocumentFragment {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content;
}

const HEAD_ATTR = 'data-rosefn-head';

export const handlers: Record<string, (e: Event) => void> =
  (globalThis as { __rosefn_handlers?: Record<string, (e: Event) => void> }).__rosefn_handlers ??= {};

/**
 * Apply one route's whole <head> (every block of its chain, page first) to the
 * document: <title> replaces the title, <meta>/<link>/<base> are matched by
 * name/property/rel/charset. First occurrence of a key wins, so a page
 * overrides its layouts - the same rule the server's mergeHeadBlocks applies,
 * which is why the two halves agree without talking to each other.
 *
 * The managed set is REBUILT from the block rather than patched element by
 * element: a route's head is the whole truth, so anything the previous route
 * provided and this one does not is dropped, and a key that moved tags is
 * replaced instead of duplicated. It is also a third of the code.
 */
export function applyHead(html: string): void {
  const seen = new Set<string>();
  const positional = new Map<string, number>();
  const frag = tpl(html);
  const title = frag.querySelector('title');
  if (title) {
    let cur = document.head.querySelector('title');
    if (!cur) {
      cur = document.createElement('title');
      document.head.appendChild(cur);
    }
    cur.textContent = title.textContent ?? '';
  }
  for (const el of Array.from(document.head.querySelectorAll(`[${HEAD_ATTR}]`))) el.remove();
  for (const el of Array.from(frag.children)) {
    if (el.tagName === 'TITLE') continue;
    const tag = el.tagName.toLowerCase();
    const identity = el.getAttribute('name')
      ?? el.getAttribute('property')
      ?? el.getAttribute('rel')
      ?? el.getAttribute('charset');
    let managed: string;
    if (identity) managed = `${tag}:${identity}`;
    else if (el.id) managed = `${tag}:${el.id}`;
    else {
      const n = positional.get(tag) ?? 0;
      positional.set(tag, n + 1);
      managed = `${tag}:#${n}`;
    }
    if (seen.has(managed)) continue;
    seen.add(managed);
    el.setAttribute(HEAD_ATTR, managed);
    document.head.appendChild(el);
  }
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
    const div = document.createElement('div');
    div.appendChild(root);
    holder = div;
  }

  const created: Cleanup[] = [];
  const weff = (fn: () => void) => created.push(effect(fn));

  const comments: Comment[] = [];
  const walker = document.createTreeWalker(holder, NodeFilter.SHOW_COMMENT);
  while (walker.nextNode()) comments.push(walker.currentNode as Comment);

  const nested = new Set<Comment>();
  const headPair = new Set<Comment>();
  const open: number[] = [];
  for (let i = 0; i < comments.length; i++) {
    const m = (comments[i].nodeValue ?? '').match(MARK_RE);
    if (m && (m[1] === 'i' || m[1] === 'l' || m[1] === 'h')) {
      open.push(i);
      continue;
    }
    const em = (comments[i].nodeValue ?? '').match(END_RE);
    if (!em) continue;
    const key = em[1] + em[2];
    let at = -1;
    for (let k = open.length - 1; k >= 0; k--) {
      const om = (comments[open[k]].nodeValue ?? '').match(MARK_RE)!;
      if (om[1] + om[2] === key) { at = k; break; }
    }
    if (at < 0) continue;
    const om = (comments[open[at]].nodeValue ?? '').match(MARK_RE)!;
    if (om[1] === 'h') {
      headPair.add(comments[open[at]]);
      headPair.add(comments[i]);
    }
    for (let k = open[at] + 1; k < i; k++) nested.add(comments[k]);
    open.length = at;
  }
  for (const c of headPair) nested.delete(c);

  const ends = new Map<number, Comment>();
  for (const c of comments) {
    if (nested.has(c)) continue;
    const m = (c.nodeValue ?? '').match(END_RE);
    if (m) ends.set(+m[2], c);
  }

  const headBlocks: Array<{ idx: number; start: Comment; end: Comment; nodes: ChildNode[] }> = [];

  const ownsHead = root === document.getElementById('app');

  for (const c of comments) {
    if (nested.has(c) || wired.has(c) || !c.parentNode) continue;
    const m = (c.nodeValue ?? '').match(MARK_RE);
    if (!m) continue;
    const kind = m[1];
    const idx = +m[2];

    if (kind === 'h' && !ownsHead) continue;
    wired.add(c);

    if (kind === 'h') {
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
      let target = c.nextSibling;
      if (!target || target.nodeType !== 3) {
        target = document.createTextNode('');
        c.parentNode!.insertBefore(target, c.nextSibling);
      }
      const tn = target as Text;
      const end = ends.get(idx);
      if (end) {
        let n: ChildNode | null = tn.nextSibling;
        while (n && n !== end) {
          const nx = n.nextSibling;
          n.remove();
          n = nx;
        }
      }
      weff(() => {
        tn.nodeValue = String((closes[idx] as (s?: unknown) => unknown)(scope));
      });
    } else if (kind === 'i') {
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
        if (!r) {
          st.__ever = true;
          return;
        }
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
        const disp = wire(frag, r.closes, (r as { scope?: unknown }).scope ?? scope);
        const nodes = Array.from(frag.childNodes);
        const parent = anchor.parentNode!;
        for (const nd of nodes) parent.insertBefore(nd, end);
        st.__st = { nodes, disp };
      });
    } else {
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

  if (root === document.getElementById('app')) {
    if (headBlocks.length > 0) {
      const blocks = headBlocks;
      weff(() => {
        let html = '';
        for (const b of blocks) html += String((closes[b.idx] as (s?: unknown) => unknown)(scope));
        applyHead(html);
      });
      for (const b of blocks) {
        b.nodes.forEach((nd) => nd.remove());
        b.start.remove();
        b.end.remove();
      }
    } else if (root.nodeType !== 11) clearHead();
  }

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

export function clearRequestState(): void {
  signalMap.clear();
  dataCache.clear();
  pendingDeltas.clear();
}

let requestQuery: Record<string, string> = {};
let prefetchOverride: Record<string, string> | null = null;

export function $query(): Record<string, string> {
  if (prefetchOverride) return prefetchOverride;
  if (typeof location === 'undefined') return requestQuery;
  const q: Record<string, string> = {};
  new URLSearchParams(location.search).forEach((v, k) => { q[k] = v; });
  return q;
}

/** The per-request query object - the servers call this before every render. */
export function setRequestQuery(q: Record<string, string>): void {
  requestQuery = q;
}

/** The query of the route a prefetch is rendering, or null outside one. */
export function setPrefetchOverride(q: Record<string, string> | null): void {
  prefetchOverride = q;
}

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
 * Concurrent prefetches are queued by the caller (trade-off: hover prefetches
 * are rare and cheap).
 */
export async function isolateStateAsync<T>(
  fn: () => Promise<T>
): Promise<{ result: T; state: Map<string, SignalEntry>; mounts: Array<() => void>; cleanups: Set<Cleanup> }> {
  const savedSignals = signalMap;
  const savedData = dataCache;
  const savedDeltas = new Map(pendingDeltas);
  pendingDeltas.clear();
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
    pendingDeltas.clear();
    savedDeltas.forEach((d, k) => pendingDeltas.set(k, d));
    mountQueue.splice(0, 0, ...savedMounts);
    cleanups.clear();
    savedCleanups.forEach((fn: Cleanup) => cleanups.add(fn));
  }
}

/** Adopt a prefetched route's signal entries (objects keep their subs). */
export function restoreState(entries: Map<string, SignalEntry>): void {
  signalMap.clear();
  entries.forEach((e: SignalEntry, k: string) => signalMap.set(k, e));
}

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

let refreshHook: (() => Promise<void>) | null = null;

export function setRefreshHook(fn: () => Promise<void>): void {
  refreshHook = fn;
}

export function refresh(): Promise<void> {
  return refreshHook ? refreshHook() : Promise.resolve();
}

const mountQueue: Array<() => void> = [];

export function onMount(fn: () => void): void {
  if (typeof document === 'undefined') return;
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
  fxSet().add(fn);
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

let LOCALES: Record<string, Record<string, string>> = {};
let DEFAULT_LOCALE = 'en';
let LOCALE_PACKS: string[] = [];

export function setLocales(dicts: Record<string, Record<string, string>>, def: string): void {
  LOCALES = dicts;
  DEFAULT_LOCALE = def;
}

/** The locales the build left out of this bundle (generated code calls this). */
export function setLocalePacks(langs: string[]): void {
  LOCALE_PACKS = langs;
}

/** Merge a dictionary that arrived at runtime - a fetched pack, or an app's own import(). */
export function loadLocale(lang: string, dict: Record<string, string>): void {
  LOCALES[lang] = { ...LOCALES[lang], ...dict };
}

/**
 * Resolve once `lang`'s dictionary is present: immediately for an inline
 * locale, after one fetch for a runtime pack, never for an unknown one (the
 * URL is the contract - the server 404s it). A failed fetch leaves the locale
 * unresolved and $t falls back to the default language; the next navigation
 * retries. This is the seam a bundled-per-locale app can bypass entirely by
 * calling loadLocale() itself.
 */
export async function ensureLocale(lang: string): Promise<void> {
  if (LOCALES[lang] || !LOCALE_PACKS.includes(lang)) return;
  try {
    const res = await fetch(`/locales/${encodeURIComponent(lang)}.json`);
    if (res.ok) loadLocale(lang, await res.json());
  } catch {
    // offline, or the pack is missing: the inline dictionaries still render
  }
}

export function localeList(): string[] {
  return Object.keys(LOCALES);
}

export function isLocale(lang: string): boolean {
  return Object.hasOwn(LOCALES, lang) || LOCALE_PACKS.includes(lang);
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

/** The signal `redirect()` throws. */
export class RoseRedirect extends Error {
  readonly __rosefn = 'redirect';
  constructor(readonly path: string, readonly status = 307) {
    super(`redirect to ${path}`);
  }
}

/** The signal `notFound()` throws. */
export class RoseNotFound extends Error {
  readonly __rosefn = 'notFound';
  constructor() {
    super('notFound()');
  }
}

/**
 * Send the visitor somewhere else: the response becomes a 30x with this
 * Location. Call it from a page's `$data` body (a wall, a renamed slug, a
 * canonical URL) or from an api handler. A route that calls it is buffered by
 * the compiler, so the status can still be set.
 */
export function redirect(path: string, status = 307): never {
  throw new RoseRedirect(path, status);
}

/**
 * Answer 404 with the app's own 404 route (pages/404.rose) instead of the
 * built-in page. Call it from a page's `$data` body when the slug resolves to
 * nothing - the status is a real 404 and the body is the app's design, which
 * is the one thing a middleware wall cannot do from outside the render.
 */
export function notFound(): never {
  throw new RoseNotFound();
}

/**
 * Reading direction of a locale. The set of right-to-left scripts is closed
 * (Arabic, Hebrew and their relatives), so a base-tag test covers every
 * language that uses them - no per-app config, and the document's <html dir>
 * is server-rendered correct for no-JS visitors. A regex LITERAL, not a
 * string .split(): esbuild drops side-effect-free initializers, so an app
 * whose scripts never call localeDir ships neither it nor the table.
 */
const RTL_RE = /^(ar|fa|he|ur|ps|sd|ug|yi|ckb|dv|ks|prs|haz|mzn|nqo)/;
/** 'rtl' for a right-to-left locale, '' otherwise - '' is the html default. */
export function localeDir(lang: string): string {
  return RTL_RE.test(lang) ? 'rtl' : '';
}

const ICU_RE = /\{([\w$]+),\s*(plural|selectordinal|select),\s*((?:\s*[=\w]+\s*\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g;
const BRANCH_RE = /([=\w]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;

/** The CLDR category of `n` in `locale`, or null where Intl has no answer. */
function pluralCategory(locale: string, ordinal: boolean, n: number): string | null {
  try {
    return new Intl.PluralRules(locale, ordinal ? { type: 'ordinal' } : undefined).select(n);
  } catch {
    return null;
  }
}

/** Expand every ICU block of a message; leave the rest (and {name} holes) alone. */
function expandIcu(msg: string, vars: Record<string, string | number> | undefined, locale: string): string {
  return msg.replace(ICU_RE, (whole, arg: string, kind: string, branchText: string) => {
    const branches: Record<string, string> = {};
    for (const m of branchText.matchAll(BRANCH_RE)) branches[m[1]] = m[2];
    if (!branches.other) return whole;
    const v = vars?.[arg];
    if (kind === 'select') return branches[typeof v === 'string' && branches[v] ? v : 'other'];
    const num = typeof v === 'number' ? v : Number(v);
    const cat = isFinite(num)
      ? (branches['=' + num] ? '=' + num : pluralCategory(locale, kind === 'selectordinal', num) ?? 'other')
      : 'other';
    return (branches[cat] ?? branches.other).replace(/#/g, String(v));
  });
}

/**
 * Translate a key for the current language. The [lang] route param arrives
 * as state before the render (the same seeding as any dynamic param), and
 * reading it through the signal getter makes $t reactive: switching locale
 * re-runs the marker, so only the translated nodes repaint.
 */
export function $t(key: string, vars?: Record<string, string | number>): string {
  const [lang] = state('lang', DEFAULT_LOCALE);
  const dict = LOCALES[lang()] ?? LOCALES[DEFAULT_LOCALE] ?? {};
  const msg = dict[key];
  let out = expandIcu(typeof msg === 'string' ? msg : key, vars, lang());
  if (vars) for (const k in vars) out = out.split(`{${k}}`).join(String(vars[k]));
  return out;
}

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

export class ActionError extends Error {
  /** the HTTP status the response carries (400/401/403/409/422/...) */
  code: number;
  /** the form field the failure belongs to, when it belongs to one */
  field?: string;
  constructor(message: string, code = 400, field?: string) {
    super(message);
    this.name = 'ActionError';
    this.code = code;
    this.field = field;
  }
}

/** The JSON-safe shape the dispatch seeds into state (what `$actionError()` returns). */
export type ActionErrorInfo = { action: string; message: string; code: number; field?: string };

/**
 * The failure of the action that produced the response being rendered, or
 * null. It is ordinary state under the key `actionError`, so the client's
 * resumeState() restores it and the post-adopt re-render sees exactly what
 * the server saw - one read, both sides, no hydration payload.
 *
 * Read it as data (`{#if $actionError()}<p>{$actionError().message}</p>{/if}`)
 * or let a {#boundary} contain it ($actionErrorOrThrow below).
 */
export function $actionError(): ActionErrorInfo | null {
  const e = signalMap.get('actionError');
  if (!e) return null;
  if (currentEffect) e.subs.add(currentEffect);
  return (e.value as ActionErrorInfo | null) ?? null;
}

/**
 * What a {#boundary} whose content depends on an action calls first: when the
 * action that produced this response failed, throw - the boundary's own catch
 * turns it into the fallback, so the section degrades to the error message
 * instead of rendering a widget built on work that never happened.
 */
export function $actionErrorOrThrow(): void {
  const info = $actionError();
  if (info) throw new ActionError(info.message, info.code, info.field);
}

/** The {#boundary} fallback: the action's own message when the failure is a business one. */
export function $boundaryFallback(err: unknown): string {
  if (err instanceof ActionError) return `<p class="rosefn-action-error">${esc(err.message)}</p>`;
  return '<p>This section failed to render.</p>';
}

export type StateDeltaOp = 'append' | 'prepend' | 'merge';

export class StateDelta {
  constructor(public op: StateDeltaOp, public value: unknown) {}
}

/** Append (or prepend) items to a list-valued state key. */
export const $append = (value: unknown): StateDelta => new StateDelta('append', value);
export const $prepend = (value: unknown): StateDelta => new StateDelta('prepend', value);
/** Shallow-merge an object into an object-valued state key. */
export const $merge = (value: Record<string, unknown>): StateDelta => new StateDelta('merge', value);

const pendingDeltas = new Map<string, StateDelta>();

/** Record the deltas of the action that just ran (the dispatch calls this). */
export function setStateDelta(key: string, delta: StateDelta): void {
  pendingDeltas.set(key, delta);
}

/**
 * Apply every pending delta to the live state and clear them. The generated
 * render calls this once, right after its state declarations - and only the
 * SSR side ever emits the call: a delta is recorded by a server dispatch, so
 * on the client (post-adopt re-render, client-side navigation, refresh) the
 * map is empty and this is a no-op. That is also why a delta can never apply
 * twice: the value it produced is what the state script carried, and the
 * client resumes THAT instead of recomputing it.
 */
export function applyStateDeltas(): void {
  if (pendingDeltas.size === 0) return;
  for (const [key, delta] of [...pendingDeltas]) {
    pendingDeltas.delete(key);
    applyStateDelta(key, delta);
  }
}

/** Apply one delta to the live state. */
export function applyStateDelta(key: string, delta: StateDelta): void {
  const cur = signalMap.get(key)?.value;
  if (delta.op === 'merge') {
    setState(key, { ...(cur as Record<string, unknown> | undefined), ...(delta.value as Record<string, unknown>) });
    return;
  }
  const list = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const merged =
    delta.op === 'append' ? [...list(cur), ...list(delta.value)] : [...list(delta.value), ...list(cur)];
  setState(key, merged);
}

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

export function reportVitals(): void {
  if (typeof window === 'undefined' || typeof performance === 'undefined') return;
  const live: Record<string, number> = {};
  (window as unknown as { __rosefn_vitals?: Record<string, number> }).__rosefn_vitals = live;
  const send = (name: string, value: number) => {
    live[name] = value;
    window.dispatchEvent(new CustomEvent('rosefn:vitals', { detail: { name, value, route: location.pathname } }));
  };
  const nav = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
  if (nav) send('ttfb', Math.round(nav.responseStart));
  const paints = performance.getEntriesByType?.('paint') ?? [];
  const fcp = paints.find((p) => p.name === 'first-contentful-paint');
  if (fcp) send('fcp', Math.round(fcp.startTime));
  const PO = (window as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  if (!PO) return;
  let cls = 0;
  let inp = 0;
  const flush = () => {
    if (cls) send('cls', Math.round(cls * 1000) / 1000);
    if (inp) send('inp', Math.round(inp));
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  new PO((list) => {
    for (const e of list.getEntries() as Array<PerformanceEntry & { value?: number; duration?: number; interactionId?: number }>) {
      if (e.entryType === 'layout-shift' && !(e as unknown as { hadRecentInput?: boolean }).hadRecentInput) cls += e.value ?? 0;
      if (e.entryType === 'event' && e.interactionId) inp = Math.max(inp, e.duration ?? 0);
      if (e.entryType === 'largest-contentful-paint') send('lcp', Math.round(e.startTime));
    }
  }).observe({ entryTypes: ['layout-shift', 'event', 'largest-contentful-paint'] });
}
