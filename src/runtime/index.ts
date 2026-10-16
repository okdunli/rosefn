
// The LoRaWAN parser lives in its own module (it is pure and large enough to
// deserve one) but reaches pages through this module's surface.
export { parseLoRaWAN } from './lorawan.js';
export type { LoRaWANFrame, LoRaWANDataFrame, LoRaWANJoinRequest, LoRaWANJoinAccept, LoRaWANMessageType } from './lorawan.js';

// === Reactive Primitives ===
type Subscriber = () => void;
type Cleanup = () => void;
type SignalEntry = { value: unknown; subs: Set<Subscriber> };

let currentEffect: (() => void) | null = null;

// F43: while an $effect body runs, every signal read lands here (the entry OBJECT).
let trackingDeps: Set<SignalEntry> | null = null;

// Trade-off: global signal map, shared across all inlined modules
let signalMap: Map<string, SignalEntry> =
  (globalThis as any).__rosespan_signalMap ?? new Map();
(globalThis as any).__rosespan_signalMap = signalMap;

// One get-or-create helper shared by state / setState / resumeState.
function entry(key: string, initial: unknown): { value: unknown; subs: Set<Subscriber> } {
  const map = renderMaps().signals;
  const e = map.get(key) ?? { value: initial, subs: new Set<Subscriber>() };
  map.set(key, e);
  return e;
      // F43: $effect dep capture
}

export function state<T>(key: string, initial: T): [() => T, (v: T) => void] {
 // The key belongs to whoever is rendering, so a mount's navigation
  ownerKeys()?.add(key);
  const e = entry(key, initial);

  const getter = () => {
    if (currentEffect) {
      e.subs.add(currentEffect);
      if (trackingDeps) trackingDeps.add(e);
  /* no storage / private mode / quota: persistence is best-effort */
    }
    return e.value as T;
  };

  const setter = (v: T) => {
    // F36: a function value is a functional update - it receives the current value and returns the next one ($setState('n', (x) => x + 1)).
    const next = (typeof v === 'function' ? (v as (cur: T) => T)(e.value) : v) as T;
    e.value = next;
    // F43: notify UNTRACKED. Subscribers were subscribed by whoever owns them; a write's fan-out must not hand out new subscriptions.
    const prevEffect = currentEffect;
    const prevTracking = trackingDeps;
    currentEffect = null;
    trackingDeps = null;
    e.subs.forEach((fn: Subscriber) => fn());
    /* a throwing effect must not kill the route */
    currentEffect = prevEffect;
    trackingDeps = prevTracking;
    if (persistedKeys.has(key)) writeStorage(key, next);
  };

  return [getter, setter];
      
}

export function hasState(key: string): boolean {
  return renderMaps().signals.has(key);
      /* a stale cleanup must not kill the route */
}

// === Per-RENDER $data seeding === The compiled `$data(() => loader())` prologue is const __seeded = isSeeded("k"); const [get.
let seededKeys = new Set<string>();

export function isSeeded(key: string): boolean {
  return renderMaps().seeded.has(key);

}

export function markSeeded(key: string): void {
  renderMaps().seeded.add(key);
}

export function setState<T>(key: string, value: T): void {
  const e = entry(key, value);
  e.value = value;
  // F43: notify untracked (same reason as the per-render setter above).
  const prevEffect = currentEffect;
  const prevTracking = trackingDeps;
  currentEffect = null;
  trackingDeps = null;
  e.subs.forEach((fn: Subscriber) => fn());
  currentEffect = prevEffect;
  trackingDeps = prevTracking;
  if (persistedKeys.has(key)) writeStorage(key, value);
}

// F9 ($persist): keys declared with $persist survive reloads — every write lands in localStorage (JSON-encoded under a rosespan: prefix) and every client.
const persistedKeys = new Set<string>();

function writeStorage(key: string, v: unknown): void {
  try {
    (globalThis as { localStorage?: Storage }).localStorage?.setItem('rosespan:' + key, JSON.stringify(v));
  } catch {  }
}

// F9 ($persist): `let theme = $persist('dark')` — like $state, but the value survives reloads.
export function persistState<T>(key: string, initial: T): [() => T, (v: T) => void] {
  persistedKeys.add(key);
  let seeded = initial;
  let hasStored = false;
  try {
    const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem('rosespan:' + key);
    if (raw != null) {
      seeded = JSON.parse(raw) as T;
      hasStored = true;
    }
  } catch {  }
  
  const [get, set] = state(key, seeded);
  if (hasStored) set(seeded);
  // the stored value wins over the resumed server default
  return [get, set];
}

// F12: the error a {#boundary} just caught — a custom {:fallback} reads it ({$boundaryError()?.message}) to render its own failure UX.
let lastBoundaryError: Error | null = null;

export function $setBoundaryError(e: unknown): void {
  lastBoundaryError = e instanceof Error ? e : new Error(String(e));
}

export function $boundaryError(): Error | null {
  return lastBoundaryError;
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
    keys.forEach((k: string) => renderMaps().signals.delete(k));
    keysByOwner.delete(container);
  }
  renderMaps().data.clear();
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
    renderMaps().signals.forEach((e: { subs: Set<Subscriber> }) => e.subs.delete(wrapped));
    // $store() boxes live in a separate map: detach them too, or a live store
    // patch keeps re-running an unmounted effect (stale render + leak).
    STORES.forEach((e: { subs: Set<Subscriber> }) => e.subs.delete(wrapped));
    fxSet().delete(cleanup);
  };
  fxSet().add(cleanup);
  return cleanup;
}

// F43: `$effect(fn)` - the reactive effect rune. Client-only (SSR: a no-op, fn never fires).
export function $effect(fn: () => void | (() => void)): Cleanup {
  if (typeof document === 'undefined') return () => {};
  // SSR: no DOM, nothing changes
  const deps = new Set<SignalEntry>();
  let cleanup: (() => void) | undefined;
  let scheduled = false;
  let disposed = false;
  const detach = () => {
    deps.forEach((e: SignalEntry) => e.subs.delete(wrapped));
    deps.clear();
  };
  const run = () => {
    if (disposed) return;
    // F43: stay "scheduled" for the whole run.
    scheduled = true;
    detach();
    if (typeof cleanup === 'function') {
      try { (cleanup as () => void)(); } catch {  }
    }
    const prevEffect = currentEffect;
    const prevTracking = trackingDeps;
    currentEffect = wrapped;
    trackingDeps = deps;
    try {
      const ret = fn();
      cleanup = typeof ret === 'function' ? (ret as () => void) : undefined;
    } catch {  }
    currentEffect = prevEffect;
    trackingDeps = prevTracking;
    scheduled = false;
  };
  const wrapped: Subscriber = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(run);
  };
  const owner = fxSet();
  
  const dispose: Cleanup = () => {
    disposed = true;
    detach();
    if (typeof cleanup === 'function') {
      try { (cleanup as () => void)(); } catch {  }
    }
    owner.delete(dispose);
  };
  owner.add(dispose);
  queueMicrotask(run);
  // first run: after the synchronous render that created us
  return dispose;
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

// === Generated-code marker helpers === Every reactive marker in every generated module is emitted through these functions.
type Close = (s?: unknown) => unknown;

export function textMark(closes: Close[], fn: Close, pair?: boolean, arg?: unknown): string {
  const i = closes.push(fn) - 1;
  return `<!--\u27e6m:${i}\u27e7-->` + esc(fn(arg)) + (pair ? `<!--\u27e6/m:${i}\u27e7-->` : '');
}

export function attrValueString(name: string, v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (name === 'class') {
      return Object.entries(v).filter(([, x]) => x).map(([k]) => k).join(' ');
    }
    if (name === 'style') {
      return Object.entries(v)
        .filter(([, x]) => x != null && x !== false && x !== '')
        .map(([k, x]) => `${k}: ${x}`)
        .join('; ');
    }
    return JSON.stringify(v);
  }
  return String(v);
}

export function attrMark(closes: Close[], fn: Close, name: string, arg?: unknown): string {
  const i = closes.push(fn) - 1;
  return `${name}="${esc(attrValueString(name, fn(arg)))}" data-b${i}="${name}"`;
}

/**
 * Boolean attributes (F1): presence IS the value - `checked="false"` still
 * checks the box, so a reactive boolean attr can never ride attrMark. The
 * SSR side emits the bare attribute only when truthy, plus an index-suffixed
 * marker either way; wire()'s boolean branch flips the PROPERTY (the one
 * thing a live DOM obeys after user interaction) and mirrors the attribute
 * for no-JS parity.
 */
export function boolAttrMark(closes: Close[], fn: Close, name: string, arg?: unknown): string {
  const i = closes.push(fn) - 1;
  return (fn(arg) ? ` ${name}=""` : '') + ` data-b${i}="!${name}"`;
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

interface EachRow {
  html: string;
  closes: unknown[];
  scope?: unknown;
  keyed?: boolean;
  key?: string;
  nodes?: Node[];
  disp?: Cleanup;
  norm?: string;
}
const EACH_REUSE_FORBID = /data-(?:on|use|bind-this|transition|animate)|data-rosespan-c|data-rv-island/;
const EACH_HTML_NORM = (h: string): string => h.replace(/\u27e6\/?[a-z]+:\d+\u27e7/g, '').replace(/data-b\d+/g, 'data-b');
const normHtml = (row: EachRow): string => (row.norm ??= EACH_HTML_NORM(row.html));

export function eachMark(closes: Close[], items: Close, fn: (s: unknown, c: Close[]) => unknown, key?: (s: unknown, vi: number) => unknown): string {
  const i = closes.push(() => (items() as unknown[]).map((v, vi) => {
    return { html: String(fn(v, closes, vi)), closes, scope: v, keyed: !!key, key: key ? String(key(v, vi)) : undefined };
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

const pendingIslandObservers = new Set<IntersectionObserver>();

const TPL_CACHE_MAX = 512;
const tplCache = new Map<string, HTMLTemplateElement>();

/** Parse an html string into a DocumentFragment. Parsed templates are cached per string and cloned per call, so repeated renders (keyed each rows, if-branch re-entry) skip the innerHTML parse. */
export function tpl(html: string): DocumentFragment {
  let t = tplCache.get(html);
  if (!t) {
    t = document.createElement('template');
    t.innerHTML = html;
    if (tplCache.size >= TPL_CACHE_MAX) {
      const oldest = tplCache.keys().next().value;
      if (oldest !== undefined) tplCache.delete(oldest);
    }
    tplCache.set(html, t);
  }
  return t.content.cloneNode(true) as DocumentFragment;
}

const HEAD_ATTR = 'data-rosespan-head';

export const handlers: Record<string, (e: Event) => void> =
  (globalThis as { __rosespan_handlers?: Record<string, (e: Event) => void> }).__rosespan_handlers ??= {};

let actionDispatch: ((name: string, e: Event) => void) | null = null;
export function setActionDispatcher(fn: (name: string, e: Event) => void): void {
  actionDispatch = fn;
}

const directBound = new WeakMap<Element, Set<string>>();

/**
 * F5: `use:NAME` element actions - the plugin point for DOM behaviors
 * (tooltips, dropdowns, canvas glue) that themes and plugins register once
 * per module: directives.tooltip = (el) => { ...; return cleanup? }. wire()
 * invokes each action for its element when the route adopts; the returned
 * cleanup (if any) rides the same disposal set as every other effect.
 * Parameters travel as data-* attributes the action reads - keeping them out
 * of the reactive graph keeps the action contract one argument.
 */
export const directives: Record<string, (el: Element, param?: unknown) => void | (() => void) | { update?: (p: unknown) => void; destroy?: () => void }> =
  (globalThis as { __rosespan_directives?: Record<string, (el: Element, param?: unknown) => void | (() => void) | { update?: (p: unknown) => void; destroy?: () => void }> })
    .__rosespan_directives ??= {};

const actionRecords = new WeakMap<Element, { update?: (p: unknown) => void; destroy?: () => void }>();

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

/** Drop every rosespan-managed head element (routes without <head> blocks). */
export function clearHead(): void {
  document.head.querySelectorAll(`[${HEAD_ATTR}]`).forEach((el) => el.remove());
}

/**
 * Wire reactive markers inside `root` to the closures in `closes`.
 * Works on the live SSR DOM (adoption) and on freshly parsed fragments.
 * Returns a disposer for every effect it created.
 */
const TRANSITION_POSES: Record<string, { transform?: string; filter?: string; opacity: string }> = {
  fade: { opacity: '0' },
  slide: { transform: 'translateY(20px)', opacity: '0' },
  fly: { transform: 'translateX(-30px) rotate(-5deg)', opacity: '0' },
  zoom: { transform: 'scale(0.8)', opacity: '0' },
  'slide-up': { transform: 'translateY(30px)', opacity: '0' },
  'slide-down': { transform: 'translateY(-30px)', opacity: '0' },
  'slide-left': { transform: 'translateX(30px)', opacity: '0' },
  'slide-right': { transform: 'translateX(-30px)', opacity: '0' },
  scale: { transform: 'scale(0.7)', opacity: '0' },
  spin: { transform: 'rotate(-90deg)', opacity: '0' },
  blur: { filter: 'blur(8px)', opacity: '0' },
  stagger: { transform: 'translateY(10px)', opacity: '0' },
};

function parseTransitionParams(pstr: string): { duration?: number; delay?: number; easing?: string } {
  const out: { duration?: number; delay?: number; easing?: string } = {};
  if (!pstr) return out;
  const trimmed = pstr.trim();
  if (/^\d+$/.test(trimmed)) { out.duration = Number(trimmed); return out; }
  const dM = /duration\s*:\s*(\d+)/.exec(pstr);
  if (dM) out.duration = Number(dM[1]);
  const dlM = /delay\s*:\s*(\d+)/.exec(pstr);
  if (dlM) out.delay = Number(dlM[1]);
  const eM = /easing\s*:\s*(['"])(.*?)\1/.exec(pstr);
  if (eM) out.easing = eM[2];
  return out;
}

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

  let islandSkip = false;
  if (ownsHead) {
    const islandEls = Array.from(
      (holder as Element).querySelectorAll('[data-rv-island]')
    ).filter((el) => !(el.parentElement && el.parentElement.closest('[data-rv-island]')));
    islandSkip = islandEls.length > 0;
    for (const isl of islandEls) {
      const fire = () => wire(isl, closes, scope);
      const mode = isl.getAttribute('data-rv-island-hydrate');
      if (mode === 'visible' && typeof IntersectionObserver !== 'undefined') {
        const io = new IntersectionObserver((entries) => {
          if (entries.some((en) => en.isIntersecting)) {
            io.disconnect();
            pendingIslandObservers.delete(io);
            fire();
          }
        });
        io.observe(isl);
        pendingIslandObservers.add(io);
      } else if (mode === 'idle' && typeof (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback === 'function') {
        (globalThis as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(() => fire());
      } else {
        fire();
      }
    }
  }

  for (const c of comments) {
    if (nested.has(c) || wired.has(c) || !c.parentNode) continue;
    const m = (c.nodeValue ?? '').match(MARK_RE);
    if (!m) continue;
    const kind = m[1];
    const idx = +m[2];

    if (islandSkip && kind !== 'h' && (c.parentNode as Element).closest?.('[data-rv-island]')) continue;

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
      const st = start as unknown as { __disp?: Cleanup; __kmap?: Map<string, EachRow> };
      weff(() => {
        if (st.__disp) {
          st.__disp();
          st.__disp = undefined;
        }
        const items = (closes[idx] as (s?: unknown) => unknown)(scope) as EachRow[];
        const parent = start.parentNode!;
        const keyed = items.length > 0 && items.every((r) => r.keyed);
        if (keyed) {
          const prev = st.__kmap ?? new Map<string, EachRow>();
          const counts = new Map<string, number>();
          for (const r of items) counts.set(r.key!, (counts.get(r.key!) ?? 0) + 1);
          const keep = new Set<Node>();
          const nextMap = new Map<string, EachRow>();
          const used = new Set<string>();
          const decisions: Array<{ row: EachRow; keepRow?: EachRow }> = [];
          for (const r of items) {
            const k = r.key!;
            let keepRow: EachRow | undefined;
            if (counts.get(k) === 1 && !used.has(k)) {
              const cand = prev.get(k);
              if (cand && normHtml(cand) === normHtml(r) && !EACH_REUSE_FORBID.test(r.html)) {
                keepRow = cand;
                used.add(k);
              }
            }
            decisions.push({ row: r, keepRow });
            if (keepRow) for (const nd of keepRow.nodes ?? []) keep.add(nd);
          }
          let n = start.nextSibling;
          while (n && n !== end) {
            const nx = n.nextSibling;
            if (!keep.has(n)) n.remove();
            n = nx;
          }
          const disps: Cleanup[] = [];
          for (const d of decisions) {
            if (d.keepRow) {
              disps.push(d.keepRow.disp!);
              nextMap.set(d.row.key!, d.keepRow);
              for (const nd of d.keepRow.nodes ?? []) parent.insertBefore(nd, end);
            } else {
              const frag = tpl(d.row.html);
              const disp = wire(frag, d.row.closes, d.row.scope);
              disps.push(disp);
              const nodes = Array.from(frag.childNodes);
              for (const nd of nodes) parent.insertBefore(nd, end);
              if (counts.get(d.row.key!) === 1) nextMap.set(d.row.key!, { ...d.row, nodes, disp });
            }
          }
          st.__kmap = nextMap;
          st.__disp = () => disps.forEach((d) => d());
          return;
        }
        st.__kmap = undefined;
        let n = start.nextSibling;
        while (n && n !== end) {
          const nx = n.nextSibling;
          n.remove();
          n = nx;
        }
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

  const all = (holder as Element).querySelectorAll('*');
  all.forEach((el) => {
    if (islandSkip && el.closest('[data-rv-island]')) return;
    for (const an of el.getAttributeNames()) {
      if (!an.startsWith('data-b')) continue;
      const idx = Number(an.slice(6));
      if (!Number.isFinite(idx)) continue;
      const attr = el.getAttribute(an)!;
      el.removeAttribute(an);
      const effect = () => String((closes[idx] as (s?: unknown) => unknown)(scope));
      if (attr === 'data-use-param') {
        weff(() => {
          const raw = effect();
          let p: unknown = raw;
          try { p = JSON.parse(raw); } catch { /* string param */ }
          actionRecords.get(el)?.update?.(p);
        });
        continue;
      }
      if (attr === 'value') {
        weff(() => {
          const v = effect();
          const out = v == null ? '' : v;
          const inp = el as unknown as HTMLInputElement;
          if (inp.value !== out) inp.value = out;
        });
      } else if (attr === 'data-selmulti') {
        weff(() => {
          const vals = effect().split(',');
          for (const o of Array.from((el as unknown as HTMLSelectElement).options)) {
            o.selected = vals.includes(o.value);
          }
        });
      } else if (attr.startsWith('!')) {
        const name = attr.slice(1);
        weff(() => {
          const v = (closes[idx] as (s?: unknown) => unknown)(scope);
          const live = !(v === false || v == null || v === '' || v === 'false' || v === 0);
          const target = el as unknown as Record<string, unknown>;
          if (target[name] !== live) target[name] = live;
          if (live) el.setAttribute(name, '');
          else el.removeAttribute(name);
        });
      } else {
        weff(() => {
          const out = attrValueString(attr, (closes[idx] as (s?: unknown) => unknown)(scope));
          if (el.getAttribute(attr) !== out) el.setAttribute(attr, out);
        });
      }
    }
  });

  const uses = (holder as Element).querySelectorAll('[data-use]');
  uses.forEach((el) => {
    if (islandSkip && el.closest('[data-rv-island]')) return;
    const name = el.getAttribute('data-use')!;
    const fn = directives[name];
    if (!fn) return;
    const rawParam = el.getAttribute('data-use-param');
    let initial: unknown = rawParam ?? undefined;
    if (typeof initial === 'string') {
      try { initial = JSON.parse(initial); } catch { /* plain string param */ }
    }
    const ret = fn(el, initial);
    if (typeof ret === 'function') created.push(ret);
    else if (ret && typeof ret === 'object') {
      actionRecords.set(el, { update: ret.update, destroy: ret.destroy });
      if (ret.destroy) created.push(ret.destroy);
    }
  });

  const refs = (holder as Element).querySelectorAll('[data-bind-this]');
  refs.forEach((el) => {
    if (islandSkip && el.closest('[data-rv-island]')) return;
    const key = el.getAttribute('data-bind-this')!;
    setState(key, el);
    created.push(() => setState(key, null));
  });

  const trans = (holder as Element).querySelectorAll('[data-transition]');
  if (trans.length > 0) {
    trans.forEach((el) => {
      if (islandSkip && el.closest('[data-rv-island]')) return;
      const transAttr = el.getAttribute('data-transition')!;
      const parts = transAttr.split('|');
      for (const part of parts) {
        const segs = part.split(':');
        const dir = segs[0] === 'in' || segs[0] === 'out' ? segs[0]! : '';
        const name = (dir ? segs[1] : segs[0]) ?? '';
        const pstr = (dir ? segs.slice(2) : segs.slice(1)).join(':');
        const params = parseTransitionParams(pstr);
        const duration = params.duration != null ? Number(params.duration) : 300;
        if (dir === 'out') {
          const pose = TRANSITION_POSES[name];
          if (pose) {
            const parent = el.parentElement;
            const idx = parent ? Math.max(0, Array.from(parent.children).indexOf(el)) : 0;
            const vDelay = params.delay != null ? Number(params.delay) : null;
            const delay = name === 'stagger'
              ? (vDelay != null ? Math.max(0, vDelay) : idx * (duration / 10))
              : (vDelay != null ? vDelay : 0);
            const easing = params.easing || 'ease';
            created.push(() => {
              const parts = [pose.transform ? `transform ${duration}ms ${easing} ${delay}ms` : '', pose.filter ? `filter ${duration}ms ${easing} ${delay}ms` : '', `opacity ${duration}ms ${easing} ${delay}ms`].filter(Boolean);
              el.style.transition = parts.join(', ');
              if (pose.transform) el.style.transform = pose.transform;
              if (pose.filter) el.style.filter = pose.filter;
              el.style.opacity = pose.opacity;
              setTimeout(() => {
                el.style.transform = '';
                el.style.filter = '';
                el.style.opacity = '';
                el.style.transition = '';
              }, duration + delay);
            });
          } else {
            const custom = (globalThis as any).__rosespanTransitions?.[name];
            if (custom) {
              const ret = custom(el, duration, 'out');
              if (typeof ret === 'function') created.push(ret);
            }
          }
          continue;
        }
        const exitStart = created.length;
        const pose = TRANSITION_POSES[name];
        if (pose) {
          const parent = el.parentElement;
          const idx = parent ? Math.max(0, Array.from(parent.children).indexOf(el)) : 0;
          const vDelay = params.delay != null ? Number(params.delay) : null;
          const delay = name === 'stagger'
            ? (vDelay != null ? Math.max(0, vDelay) : idx * (duration / 10))
            : (vDelay != null ? vDelay : 0);
          const easing = params.easing || 'ease';
          const cssParts: string[] = [];
          if (pose.transform) cssParts.push(`transform ${duration}ms ${easing} ${delay}ms`);
          if (pose.filter) cssParts.push(`filter ${duration}ms ${easing} ${delay}ms`);
          cssParts.push(`opacity ${duration}ms ${easing} ${delay}ms`);
          const tcss = cssParts.join(', ');
          el.style.opacity = '0';
          if (pose.transform) el.style.transform = pose.transform;
          if (pose.filter) el.style.filter = pose.filter;
          el.style.transition = tcss;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.transform = '';
              el.style.filter = '';
              el.style.opacity = '1';
            });
          });
          created.push(() => {
            el.style.opacity = '0';
            if (pose.transform) el.style.transform = pose.transform;
            if (pose.filter) el.style.filter = pose.filter;
            setTimeout(() => {
              el.style.opacity = '';
              el.style.transform = '';
              el.style.filter = '';
              el.style.transition = '';
            }, duration + delay);
          });
        } else {
          const custom = (globalThis as any).__rosespanTransitions?.[name];
          if (custom) {
            const ret = custom(el, duration, dir || 'both');
            if (typeof ret === 'function') created.push(ret);
          }
        }
        if (dir === 'in') created.length = exitStart;
      }
    });
  }

  const anim = (holder as Element).querySelectorAll('[data-animate]');
  if (anim.length > 0) {
    anim.forEach((el) => {
      if (islandSkip && el.closest('[data-rv-island]')) return;
      const animAttr = el.getAttribute('data-animate')!;
      const parts = animAttr.split('|');
      for (const part of parts) {
        const [name] = part.split(':');
        const rest = part.slice(name.length + 1);
        const duration = Number((/(\d+)\s*\}?\s*$/.exec(rest) ?? [])[1]) || 300;
        if (name === 'flip') {
          const firstRect = el.getBoundingClientRect();
          const firstTop = firstRect.top;
          const firstLeft = firstRect.left;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const lastRect = el.getBoundingClientRect();
              const deltaTop = lastRect.top - firstTop;
              const deltaLeft = lastRect.left - firstLeft;
              if (Math.abs(deltaTop) < 0.5 && Math.abs(deltaLeft) < 0.5) return;
              el.style.transform = `translate(${-deltaLeft}px, ${-deltaTop}px)`;
              el.style.transition = 'none';
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  el.style.transition = `transform ${duration}ms ease`;
                  el.style.transform = '';
                });
              });
            });
          });
        } else if (name === 'pulse') {
          el.style.transform = 'scale(1)';
          el.style.transition = `transform ${duration}ms ease`;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.transform = 'scale(1.1)';
              setTimeout(() => {
                el.style.transform = 'scale(1)';
              }, duration);
            });
          });
        } else if (name === 'bounce') {
          el.style.transform = 'translateY(0)';
          el.style.transition = `transform ${duration}ms ease`;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.transform = 'translateY(-15px)';
              setTimeout(() => {
                el.style.transform = 'translateY(0)';
              }, duration);
            });
          });
        } else if (name === 'shake') {
          el.style.transform = 'translateX(0)';
          el.style.transition = `transform ${duration / 4}ms ease-in-out`;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.transform = 'translateX(-8px)';
              setTimeout(() => {
                el.style.transform = 'translateX(8px)';
                setTimeout(() => {
                  el.style.transform = 'translateX(-8px)';
                  setTimeout(() => {
                    el.style.transform = 'translateX(8px)';
                    setTimeout(() => {
                      el.style.transform = 'translateX(0)';
                      el.style.transition = '';
                    }, duration / 4);
                  }, duration / 4);
                }, duration / 4);
              }, duration / 4);
            }, duration / 4);
          });
        } else if (name === 'scale') {
          el.style.transform = 'scale(0.5)';
          el.style.opacity = '0';
          el.style.transition = `transform ${duration}ms ease, opacity ${duration}ms ease`;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.transform = '';
              el.style.opacity = '1';
            });
          });
          created.push(() => {
            el.style.transform = 'scale(0.5)';
            el.style.opacity = '0';
            setTimeout(() => {
              el.style.transform = '';
              el.style.opacity = '';
              el.style.transition = '';
            }, duration);
          });
        } else if (name === 'rotate') {
          el.style.transform = 'rotate(-180deg)';
          el.style.opacity = '0';
          el.style.transition = `transform ${duration}ms ease, opacity ${duration}ms ease`;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.transform = '';
              el.style.opacity = '1';
            });
          });
          created.push(() => {
            el.style.transform = 'rotate(-180deg)';
            el.style.opacity = '0';
            setTimeout(() => {
              el.style.transform = '';
              el.style.opacity = '';
              el.style.transition = '';
            }, duration);
          });
        } else if (name === 'fade-in') {
          el.style.opacity = '0';
          el.style.transition = `opacity ${duration}ms ease`;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.opacity = '1';
            });
          });
          created.push(() => {
            el.style.opacity = '0';
            setTimeout(() => {
              el.style.opacity = '';
              el.style.transition = '';
            }, duration);
          });
        } else if (name === 'fade-out') {
          el.style.opacity = '1';
          el.style.transition = `opacity ${duration}ms ease`;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.opacity = '0';
            });
          });
          created.push(() => {
            el.style.opacity = '1';
            setTimeout(() => {
              el.style.opacity = '';
              el.style.transition = '';
            }, duration);
          });
        } else if (name === 'stagger') {
          const parent = el.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children);
            const index = siblings.indexOf(el);
            const delay = index * (duration / 10);
            el.style.opacity = '0';
            el.style.transform = 'translateY(10px)';
            el.style.transition = `opacity ${duration}ms ease ${delay}ms, transform ${duration}ms ease ${delay}ms`;
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                el.style.opacity = '1';
                el.style.transform = '';
              });
            });
            created.push(() => {
              el.style.opacity = '0';
              el.style.transform = 'translateY(10px)';
              setTimeout(() => {
                el.style.opacity = '';
                el.style.transform = '';
                el.style.transition = '';
              }, duration + delay);
            });
          }
        } else if (name === 'zoom-in') {
          el.style.transform = 'scale(0)';
          el.style.opacity = '0';
          el.style.transition = `transform ${duration}ms ease, opacity ${duration}ms ease`;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.transform = '';
              el.style.opacity = '1';
            });
          });
          created.push(() => {
            el.style.transform = 'scale(0)';
            el.style.opacity = '0';
            setTimeout(() => {
              el.style.transform = '';
              el.style.opacity = '';
              el.style.transition = '';
            }, duration);
          });
        } else if (name === 'zoom-out') {
          el.style.transform = 'scale(1)';
          el.style.opacity = '1';
          el.style.transition = `transform ${duration}ms ease, opacity ${duration}ms ease`;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.transform = 'scale(0)';
              el.style.opacity = '0';
            });
          });
          created.push(() => {
            el.style.transform = 'scale(1)';
            el.style.opacity = '1';
            setTimeout(() => {
              el.style.transform = '';
              el.style.opacity = '';
              el.style.transition = '';
            }, duration);
          });
        } else if (name === 'slide-up-fade') {
          el.style.transform = 'translateY(30px)';
          el.style.opacity = '0';
          el.style.transition = `transform ${duration}ms ease, opacity ${duration}ms ease`;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.transform = '';
              el.style.opacity = '1';
            });
          });
          created.push(() => {
            el.style.transform = 'translateY(30px)';
            el.style.opacity = '0';
            setTimeout(() => {
              el.style.transform = '';
              el.style.opacity = '';
              el.style.transition = '';
            }, duration);
          });
        } else if (name === 'slide-down-fade') {
          el.style.transform = 'translateY(-30px)';
          el.style.opacity = '0';
          el.style.transition = `transform ${duration}ms ease, opacity ${duration}ms ease`;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.transform = '';
              el.style.opacity = '1';
            });
          });
          created.push(() => {
            el.style.transform = 'translateY(-30px)';
            el.style.opacity = '0';
            setTimeout(() => {
              el.style.transform = '';
              el.style.opacity = '';
              el.style.transition = '';
            }, duration);
          });
        } else if (name === 'flip-x') {
          el.style.transform = 'rotateX(90deg)';
          el.style.opacity = '0';
          el.style.transition = `transform ${duration}ms ease, opacity ${duration}ms ease`;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.transform = '';
              el.style.opacity = '1';
            });
          });
          created.push(() => {
            el.style.transform = 'rotateX(90deg)';
            el.style.opacity = '0';
            setTimeout(() => {
              el.style.transform = '';
              el.style.opacity = '';
              el.style.transition = '';
            }, duration);
          });
        } else if (name === 'flip-y') {
          el.style.transform = 'rotateY(90deg)';
          el.style.opacity = '0';
          el.style.transition = `transform ${duration}ms ease, opacity ${duration}ms ease`;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.transform = '';
              el.style.opacity = '1';
            });
          });
          created.push(() => {
            el.style.transform = 'rotateY(90deg)';
            el.style.opacity = '0';
            setTimeout(() => {
              el.style.transform = '';
              el.style.opacity = '';
              el.style.transition = '';
            }, duration);
          });
        } else if (name === 'spin') {
          el.style.transform = 'rotate(-360deg)';
          el.style.opacity = '0';
          el.style.transition = `transform ${duration}ms ease, opacity ${duration}ms ease`;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.transform = '';
              el.style.opacity = '1';
            });
          });
          created.push(() => {
            el.style.transform = 'rotate(-360deg)';
            el.style.opacity = '0';
            setTimeout(() => {
              el.style.transform = '';
              el.style.opacity = '';
              el.style.transition = '';
            }, duration);
          });
        } else if (name === 'pop') {
          el.style.transform = 'scale(0.3)';
          el.style.opacity = '0';
          el.style.transition = `transform ${duration}ms ease, opacity ${duration}ms ease`;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.transform = 'scale(1.1)';
              setTimeout(() => {
                el.style.transform = '';
              }, duration / 3);
            });
          });
          created.push(() => {
            el.style.transform = 'scale(0.3)';
            el.style.opacity = '0';
            setTimeout(() => {
              el.style.transform = '';
              el.style.opacity = '';
              el.style.transition = '';
            }, duration);
          });
        } else if (name === 'blink') {
          el.style.opacity = '0';
          el.style.transition = `opacity ${duration}ms ease`;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.opacity = '1';
            });
          });
          created.push(() => {
            el.style.opacity = '0';
            setTimeout(() => {
              el.style.opacity = '';
              el.style.transition = '';
            }, duration);
          });
        }
      }
    });
  }

  const DELEGATED_SET = new Set(['click', 'input', 'change', 'submit']);
  const evRoot = holder as Element;
  const evTargets = [evRoot, ...Array.from(evRoot.querySelectorAll('*'))];
  for (const el of evTargets) {
    if (!el.getAttributeNames) continue;
    if (islandSkip && el.closest && el.closest('[data-rv-island]')) continue;
    for (const an of el.getAttributeNames()) {
      const mm = /^data-on(w|d)?-(.+)$/.exec(an);
      if (!mm) continue;
      const ev = mm[2];
      if (!mm[1] && DELEGATED_SET.has(ev)) continue;
      const g = globalThis as { window?: EventTarget; document?: { defaultView?: EventTarget } & EventTarget };
      const win = g.window ?? g.document?.defaultView;
      const target: EventTarget | undefined = mm[1] === 'w' ? win : mm[1] === 'd' ? (g.document as EventTarget) : el;
      if (!target) continue;
      let seen = directBound.get(el);
      if (!seen) directBound.set(el, (seen = new Set()));
      if (seen.has(ev)) continue;
      seen.add(ev);
      const spec = el.getAttribute(an)!;
      const listener = (e: Event) => {
        if (!el.hasAttribute(an)) return;
        if (spec.startsWith('$action:')) {
          if (actionDispatch) actionDispatch(spec.slice('$action:'.length), e);
          return;
        }
        const h = handlers[spec];
        if (h) h(e);
      };
      target.addEventListener(ev, listener, ev === 'scroll' ? { passive: true } : undefined);
      created.push(() => {
        target.removeEventListener(ev, listener);
        const s = directBound.get(el);
        if (s) s.delete(ev);
      });
    }
  }

  if (holder !== root) {
    while (holder.firstChild) root.appendChild(holder.firstChild);
  }

  return () => created.forEach((fn) => fn());
}

export function resetEffects(): void {
  cleanups.forEach((fn) => fn());
  cleanups.clear();
  pendingIslandObservers.forEach((io) => io.disconnect());
  pendingIslandObservers.clear();
}

export function $data<T>(fn: () => T | Promise<T>): Promise<T> {
  const cache = renderMaps().data;
  const key = fn.toString();
  let p = cache.get(key);
  if (!p) {
    p = Promise.resolve(fn());
    cache.set(key, p);
  }
  return p as Promise<T>;
}

const bffCache: Map<string, Promise<unknown>> = new Map();

export function loader<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let p = bffCache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = fn().catch((e) => { bffCache.delete(key); throw e; });
    bffCache.set(key, p);
  }
  return p;
}

export async function aggregate<R extends Record<string, () => Promise<unknown>>>(loaders: R): Promise<{ [K in keyof R]: Awaited<ReturnType<R[K]>> }> {
  const keys = Object.keys(loaders) as (keyof R)[];
  const results = await Promise.all(keys.map((k) => loaders[k]()));
  const out = {} as { [K in keyof R]: Awaited<ReturnType<R[K]>> };
  keys.forEach((k, i) => { (out as Record<string, unknown>)[k as string] = results[i]; });
  return out;
}

export function clearRequestState(): void {
  renderMaps().signals.clear();
  renderMaps().data.clear();
  pendingDeltas.clear();
  renderMaps().seeded.clear();
  bffCache.clear();
}

/**
 * Run `fn` with request state no other in-flight render can observe or
 * destroy, then restore the caller's state.
 *
 * signalMap is a process-wide singleton (deliberate - every inlined module
 * shares one map), which is only safe while renders never overlap. They
 * DO overlap: prod-server warms every route in the background at startup, and
 * renderPageCached revalidates a stale cache entry in the background while the
 * foreground request is still streaming. Each of those renders used to open
 * with clearRequestState(), wiping whichever render was in flight; the
 * survivor then saw hasState()===true for a key it never seeded and
 * dereferenced the other render's null - "Cannot read properties of null
 * (reading 'bodyFix')", a 500 that hits a cold route and clears on refresh.
 *
 * Isolating here makes concurrent renders correct rather than merely unlikely.
 * The signal map and the seeded-key set are swapped on the resolved render maps
 * (renderMaps()), so under a context store each render chain gets its own pair;
 * without a store the swap is the old process-wide one, correct for the
 * single-render fallback. dataCache needs no swap at all under a store - it
 * already rides the async chain; see renderMaps().
 */
export async function isolateRender<T>(fn: () => Promise<T>): Promise<T> {
  const maps = renderMaps();
  const savedSignals = maps.signals;
  const savedSeeded = maps.seeded;
  maps.signals = new Map();
  maps.seeded = new Set();
  maps.data.clear();
  try {
    return await fn();
  } finally {
    maps.signals = savedSignals;
    maps.seeded = savedSeeded;
  }
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

/** Read the current per-request query (the SWR background refresh snapshots it so a
 *  concurrent request's setRequestQuery cannot leak the wrong query into a cached refresh). */
export function getRequestQuery(): Record<string, string> {
  return requestQuery;
}

/** The query of the route a prefetch is rendering, or null outside one. */
export function setPrefetchOverride(q: Record<string, string> | null): void {
  prefetchOverride = q;
}

let requestContext: Record<string, unknown> = {};

/** Pluggable per-async-chain store; see the comment above. */
type ContextStore = {
  getStore(): Record<string, unknown> | undefined;
  run<T>(store: Record<string, unknown>, fn: () => T): T;
};
let contextStore: ContextStore | null = null;

/**
 * The render-local maps for the CURRENT async chain.
 *
 * isolateRender() used to swap module-level `dataCache` / `signalMap` and
 * restore them in a finally. That is not isolation, it is a rename: `await`
 * yields, so two overlapping renders interleave and the second one saves the
 * FIRST one's fresh map as its "saved" value. Concretely, with A and B running:
 *
 *   A: saved = D0;  dataCache = DA
 *   B: saved = DA;  dataCache = DB        <- A's writes now land in DB
 *   A: restore dataCache = D0
 *   B: restore dataCache = DA            <- and A's map is live again
 *
 * So A and B shared one $data map, and $data is keyed on the thunk SOURCE
 * ALONE (the payload is not part of the key). Two renders of different paths
 * therefore shared one `chrome()` promise, and the second one was served the
 * first one's header - which is how the home page could come back with no menu
 * item highlighted, on roughly two cold starts out of three, while a warm
 * process was always correct.
 *
 * The fix is the same shape as the request context bag: keep the maps on the
 * async chain. Under a context store each request gets its own; without one
 * (edge, client) this is the single-render fallback and the old behaviour is
 * correct anyway.
 */
const RENDER_MAPS = Symbol('renderMaps');
type RenderMaps = { data: Map<string, Promise<unknown>>; signals: Map<string, SignalEntry>; seeded: Set<string> };
let fallbackRenderMaps: RenderMaps = { data: new Map(), signals: signalMap, seeded: seededKeys };

function renderMaps(): RenderMaps {
  const scoped = contextStore?.getStore();
  if (!scoped) return fallbackRenderMaps;
  let m = scoped[RENDER_MAPS] as RenderMaps | undefined;
  if (!m) {
    m = { data: new Map(), signals: new Map(), seeded: new Set() };
    scoped[RENDER_MAPS] = m;
  }
  return m;
}

/**
 * Install the async-local context store (Node passes an AsyncLocalStorage
 * adapter). Pass null to return to the module-level bag.
 */
export function installContextStore(store: ContextStore | null): void {
  contextStore = store;
}

export function getContext(): Record<string, unknown> {
  const scoped = contextStore?.getStore();
  return scoped ?? requestContext;
}

/**
 * Fresh bag for a new request - runMiddleware() calls this before the
 * middleware. Under a context store it must NOT assign the module-level
 * variable (that is the shared-state bug); it clears the current scope's bag
 * in place so the object identity the store handed out stays valid.
 */
export function resetRequestContext(): void {
  if (contextStore) {
    const scoped = contextStore.getStore();
    if (scoped) {
      for (const k of Object.keys(scoped)) delete scoped[k];
      return;
    }
  }
  requestContext = {};
}

/**
 * Run `fn` inside its own context bag. A Node host calls this around each
 * request; without a store this degrades to a save/restore of the module-level
 * bag, which is what the pre-AsyncLocalStorage code did.
 */
export function runWithContext<T>(fn: () => T): T {
  if (contextStore) return contextStore.run({}, fn);
  const saved = requestContext;
  requestContext = {};
  try {
    return fn();
  } finally {
    requestContext = saved;
  }
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
  const maps = renderMaps();
  const savedSignals = maps.signals;
  const savedSeeded = maps.seeded;
  const savedDeltas = new Map(pendingDeltas);
  pendingDeltas.clear();
  const savedMounts = mountQueue.splice(0, mountQueue.length);
  const savedCleanups = new Set(cleanups);
  cleanups.clear();
  maps.signals = new Map();
  maps.seeded = new Set();
  maps.data.clear();
  try {
    const result = await fn();
    return {
      result,
      state: maps.signals,
      mounts: mountQueue.splice(0, mountQueue.length),
      cleanups: new Set(cleanups),
    };
  } finally {
    maps.signals = savedSignals;
    maps.seeded = savedSeeded;
    pendingDeltas.clear();
    savedDeltas.forEach((d, k) => pendingDeltas.set(k, d));
    mountQueue.splice(0, 0, ...savedMounts);
    cleanups.clear();
    savedCleanups.forEach((fn: Cleanup) => cleanups.add(fn));
  }
}

/** Adopt a prefetched route's signal entries (objects keep their subs). */
export function restoreState(entries: Map<string, SignalEntry>): void {
  const map = renderMaps().signals;
  map.clear();
  entries.forEach((e: SignalEntry, k: string) => map.set(k, e));
}

export function serializeState(): string {
  const obj: Record<string, unknown> = {};
  renderMaps().signals.forEach((v: { value: unknown }, k: string) => {
    obj[k] = v.value;
  });
  return JSON.stringify(obj);
}

export function resumeState(json: string): void {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      const [keys, values] = parsed as [string[], unknown[]];
      for (let i = 0; i < keys.length; i++) {
        entry(keys[i], values[i]).value = values[i];
        renderMaps().seeded.add(keys[i]);
      }
    } else if (parsed && typeof parsed === 'object') {
      Object.entries(parsed as Record<string, unknown>).forEach(([k, v]) => {
        entry(k, v).value = v;
        renderMaps().seeded.add(k);
      });
    }
  } catch {
    // ignore corrupt state
  }
}

const SDUI_TAGS = ['div', 'span', 'a', 'p', 'img', 'ul', 'li', 'button', 'input', 'section', 'h1', 'h2', 'h3', 'nav', 'header', 'footer', 'form', 'label', 'strong', 'em', 'table', 'tr', 'td', 'code', 'pre', 'article', 'main', 'aside'];
const sduiTagToId = new Map(SDUI_TAGS.map((t, i) => [t, i]));
const sduiIdToTag = new Map(SDUI_TAGS.map((t, i) => [i, t]));

export interface SduiNode {
  t: string;
  p?: Record<string, string>;
  c?: SduiNode[];
}

export function encodeSdui(node: SduiNode): string {
  const enc = (n: SduiNode): unknown[] => [
    sduiTagToId.get(n.t) ?? n.t,
    n.p ?? {},
    (n.c ?? []).map(enc),
  ];
  return JSON.stringify(enc(node));
}

export function decodeSdui(json: string): SduiNode {
  const dec = (a: unknown): SduiNode => {
    const arr = a as [number | string, Record<string, string>, unknown[]];
    const raw = arr[0];
    const t = typeof raw === 'number' ? (sduiIdToTag.get(raw) ?? String(raw)) : String(raw);
    return { t, p: arr[1], c: (arr[2] ?? []).map(dec) };
  };
  return dec(JSON.parse(json));
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
  readonly __rosespan = 'redirect';
  constructor(readonly path: string, readonly status = 307) {
    super(`redirect to ${path}`);
  }
}

/** The signal `notFound()` throws. */
export class RoseNotFound extends Error {
  readonly __rosespan = 'notFound';
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

const PLURAL_RULES = new Map<string, Intl.PluralRules>();

/** The CLDR category of `n` in `locale`, or null where Intl has no answer. */
function pluralCategory(locale: string, ordinal: boolean, n: number): string | null {
  try {
    const key = ordinal ? locale + '\u0000ord' : locale;
    let rules = PLURAL_RULES.get(key);
    if (!rules) {
      rules = new Intl.PluralRules(locale, ordinal ? { type: 'ordinal' } : undefined);
      PLURAL_RULES.set(key, rules);
    }
    return rules.select(n);
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

const STORES = new Map<string, { value: unknown; subs: Set<Subscriber> }>();
let storeTransport: ((name: string, value: unknown) => void) | null = null;

// A store write (or an applied patch) fans out to whoever read the store inside a
// tracked scope - the wire() effects that render {store.get()} / {#each store.get()}.
// Notify UNTRACKED, exactly like the signal setter: a write must not hand out new
// subscriptions, and a throwing effect must not kill the route.
function notifyStoreSubs(box: { subs: Set<Subscriber> }): void {
  if (box.subs.size === 0) return;
  const prevEffect = currentEffect;
  const prevTracking = trackingDeps;
  currentEffect = null;
  trackingDeps = null;
  box.subs.forEach((fn: Subscriber) => fn());
  currentEffect = prevEffect;
  trackingDeps = prevTracking;
}

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
  if (!entry) return;
  entry.value = value;
  notifyStoreSubs(entry);
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
    entry = { value: initial, subs: new Set<Subscriber>() };
    STORES.set(name, entry);
  }
  const box = entry;
  return {
    get: () => {
      if (currentEffect) {
        box.subs.add(currentEffect);
        if (trackingDeps) trackingDeps.add(box as unknown as SignalEntry);
      }
      return box.value as T;
    },
    set: (v: T) => {
      box.value = v;
      notifyStoreSubs(box);
      storeTransport?.(name, v);
    },
    update: (fn: (v: T) => T) => {
      box.value = fn(box.value as T);
      notifyStoreSubs(box);
      storeTransport?.(name, box.value);
    },
  };
}

// === Network listeners (isomorphic) ===
// $udp / $tcp / $listen / $websocket let an app open a socket and react to the
// outside world (LoRa gateways, MQTT-ish feeds, raw TCP devices, live dashboards)
// from inside a rosespan app. They only REGISTER a spec here; the host binds them
// via __startNetwork() at serve-worker boot - so a build, a prerender, or a dev
// hot-re-import never opens a socket. The registries live on globalThis: a dev
// re-import re-registers specs against the same live handles.
//
// A page's <script> runs per render, so the same key re-registers on every
// request. Re-registration therefore SWAPS the callbacks on the live handle
// (opts are read dynamically at event time) instead of closing the socket: no
// per-request churn, and a dev hot-reload's fresh closures take over immediately
// instead of leaving stale ones bound. On the client every handle is an inert
// no-op, so a page whose <script> opens a listener hydrates without a
// ReferenceError.
type NetOpts = Record<string, unknown>;
const __netSpecs: { kind: string; port: number; host?: string; opts: NetOpts }[] =
  (globalThis as any).__rosespan_netSpecs || ((globalThis as any).__rosespan_netSpecs = []);
const __netHandles: any[] = (globalThis as any).__rosespan_netHandles || ((globalThis as any).__rosespan_netHandles = []);
/** key ('kind:port:host') -> live handle. A Map, not a Set: re-registering a key (per-request render or dev hot re-import) swaps the callbacks in place. */
const __netBound: Map<string, any> = (globalThis as any).__rosespan_netBound || ((globalThis as any).__rosespan_netBound = new Map());

function __netBind(spec: { kind: string; port: number; host?: string; opts: NetOpts }): void {
  const key = spec.kind + ':' + spec.port + ':' + (spec.host || '');
  const prev = __netBound.get(key);
  if (prev) {
    // Live handle already bound: adopt the newest callbacks, keep the socket.
    prev.opts = spec.opts || {};
    return;
  }
  const o = spec.opts || {};
  if (spec.kind === 'udp') {
    const dg = (globalThis as any).__rosespan_dgram;
    if (!dg) return;
    const handle = { opts: o, sock: null as any };
    const sock = dg.createSocket('udp4');
    handle.sock = sock;
    sock.on('message', (msg: Buffer, rinfo: unknown) => (handle.opts.onMessage as (m: Buffer, r: unknown) => void)?.(msg, rinfo));
    sock.on('error', (err: Error) => { if (handle.opts.onError) (handle.opts.onError as (e: Error) => void)(err); else console.error('[rosespan] UDP error:', err); });
    sock.bind(spec.port, spec.host || '0.0.0.0');
    __netHandles.push(sock);
    __netBound.set(key, handle);
  } else if (spec.kind === 'tcp') {
    const nt = (globalThis as any).__rosespan_net;
    if (!nt) return;
    const handle = { opts: o, srv: null as any };
    const srv = nt.createServer((socket: any) => {
      (handle.opts.onConnection as (s: unknown) => void)?.(socket);
      socket.on('data', (data: Buffer) => (handle.opts.onData as (s: unknown, d: Buffer) => void)?.(socket, data));
      socket.on('error', () => {});
    });
    handle.srv = srv;
    srv.on('error', (err: Error) => console.error('[rosespan] TCP server error:', err));
    srv.listen(spec.port, spec.host || '0.0.0.0');
    __netHandles.push(srv);
    __netBound.set(key, handle);
  } else if (spec.kind === 'ws') {
    const http = (globalThis as any).__rosespan_http;
    const cryptoMod = (globalThis as any).__rosespan_crypto;
    if (!http || !cryptoMod) return;
    const clients = new Set<any>();
    const handle = {
      opts: o,
      clients: () => Array.from(clients),
      broadcast: (data: unknown) => { for (const c of clients) c.send(data); },
      close: () => { for (const c of Array.from(clients)) c.close(); try { srv.close(); } catch { /* already gone */ } },
    };
    const srv = http.createServer((_req: unknown, res: any) => { res.writeHead(426, { 'content-type': 'text/plain' }); res.end('Upgrade Required'); });
    srv.on('upgrade', (req: any, socket: any) => {
      const opts = handle.opts;
      if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !req.headers['sec-websocket-key']) { socket.destroy(); return; }
      const path = String(req.url || '/').split('?')[0];
      if (opts.path && path !== opts.path) { socket.destroy(); return; }
      const accept = cryptoMod.createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      try {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      } catch { socket.destroy(); return; }
      socket.setNoDelay(true);
      socket.setTimeout(0); // an upgraded socket is a long-lived channel: no request timeout
      const wrapped = __wsWrap(socket, clients, handle);
      clients.add(wrapped);
      (opts.onConnection as (ws: unknown) => void)?.(wrapped);
    });
    srv.on('error', (err: Error) => { if (handle.opts.onError) (handle.opts.onError as (e: Error) => void)(err); else console.error('[rosespan] WebSocket server error:', err); });
    srv.listen(spec.port, spec.host || '0.0.0.0');
    __netHandles.push(handle);
    __netBound.set(key, handle);
  } else if (spec.kind === 'mqtt') {
    const nt = (globalThis as any).__rosespan_net;
    if (!nt) return;
    const client = __mqttConnect(nt, spec.port, spec.host || 'localhost', o);
    __netHandles.push(client);
    __netBound.set(key, client);
  }
}
function __netReg(kind: string, port: number, host: string | undefined, opts: NetOpts): void {
  const spec = { kind, port, host, opts };
  __netSpecs.push(spec);
  if ((globalThis as any).__rosespan_netStarted === true) __netBind(spec);
}
/** Drop every pending spec for a key and close its live handle (app-level close()). */
function __netUnreg(kind: string, port: number, host: string | undefined): void {
  const key = kind + ':' + port + ':' + (host || '');
  const h = __netBound.get(key);
  if (h) {
    const live = (h as { sock?: { close?: () => void }; srv?: { close?: () => void }; close?: () => void });
    try { (live.close || live.sock?.close || live.srv?.close)?.call(live); } catch { /* already gone */ }
    __netBound.delete(key);
  }
  for (let i = __netSpecs.length - 1; i >= 0; i--) {
    const s = __netSpecs[i];
    if (s.kind === kind && s.port === port && (s.host || '') === (host || '')) __netSpecs.splice(i, 1);
  }
}
/** Bind every registered listener. Called once at serve-worker boot by the host. */
export function __startNetwork(): void {
  (globalThis as any).__rosespan_netStarted = true;
  for (const spec of __netSpecs) __netBind(spec);
}
/** Close every bound listener. Called on worker shutdown. */
export function __stopNetwork(): void {
  for (const h of __netHandles) {
    const live = h as { close?: () => void };
    try { live.close?.(); } catch { /* already gone */ }
  }
  __netHandles.length = 0;
  __netBound.clear();
}

// === WebSocket server (RFC 6455, zero-dependency) ===
// Minimal but complete enough for dashboards and device feeds: handshake,
// text/binary frames, continuation reassembly, ping/pong, close handshake.
// No extensions, no permessage-deflate - deliberately.
const __WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Parse as many complete frames as the buffer holds; return the tail (partial frame) for the next chunk. */
function __wsParseFrames(buf: Buffer): { frames: { fin: boolean; opcode: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { fin: boolean; opcode: number; payload: Buffer }[] = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (off + 4 > buf.length) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (off + 10 > buf.length) break;
      len = buf.readUInt32BE(p) * 4294967296 + buf.readUInt32BE(p + 4);
      p += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (p + maskLen + len > buf.length) break;
    let payload = buf.slice(p + maskLen, p + maskLen + len);
    if (masked) {
      const mask = buf.slice(p, p + 4);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    frames.push({ fin, opcode, payload });
    off = p + maskLen + len;
  }
  return { frames, rest: off > 0 ? buf.slice(off) : buf };
}

/** Encode one server->client frame (never masked, FIN always set for our single-frame sends). */
function __wsEncodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

/** Wrap an upgraded raw socket into the plan's WebSocket surface: send/close/on + message reassembly. Callbacks are read from the handle's opts at event time so a re-registration swaps them live. */
function __wsWrap(socket: any, clients: Set<any>, handle: { opts: NetOpts }): any {
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
  const emit = (ev: string, arg: unknown) => { for (const fn of listeners[ev] || []) fn(arg); };
  let msgOpcode = 0;
  let parts: Buffer[] = [];
  const wrapped = {
    remoteAddress: socket.remoteAddress,
    send: (data: unknown) => {
      if (socket.destroyed) return;
      let opcode = 1;
      let payload: Buffer;
      if (typeof data === 'string') { opcode = 1; payload = Buffer.from(data, 'utf8'); }
      else if (Buffer.isBuffer(data)) { opcode = 2; payload = data; }
      else { opcode = 1; payload = Buffer.from(String(data), 'utf8'); }
      socket.write(__wsEncodeFrame(opcode, payload));
    },
    close: () => {
      if (socket.destroyed) return;
      try { socket.write(__wsEncodeFrame(8, Buffer.from([0x03, 0xe8]))); } catch { /* already gone */ }
      socket.end();
    },
    on: (ev: string, fn: (arg: unknown) => void) => { (listeners[ev] || (listeners[ev] = [])).push(fn); },
  };
  (socket as any).__wsBuf = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    const sock = socket as any;
    sock.__wsBuf = sock.__wsBuf.length ? Buffer.concat([sock.__wsBuf, chunk]) : chunk;
    const { frames, rest } = __wsParseFrames(sock.__wsBuf as Buffer);
    sock.__wsBuf = rest;
    for (const f of frames) {
      if (f.opcode === 8) {
        wrapped.close();
      } else if (f.opcode === 9) {
        try { socket.write(__wsEncodeFrame(10, f.payload)); } catch { /* already gone */ }
      } else if (f.opcode === 10) {
        // pong: nothing to do
      } else if (f.opcode === 1 || f.opcode === 2) {
        if (msgOpcode !== 0) { socket.destroy(); return; } // protocol error: new data frame mid-message
        msgOpcode = f.opcode;
        parts = [f.payload];
        if (f.fin) { const msg = Buffer.concat(parts); const op = msgOpcode; msgOpcode = 0; parts = []; emit('message', op === 1 ? msg.toString('utf8') : msg); (handle.opts.onMessage as ((...a: unknown[]) => void) | undefined)?.(wrapped, op === 1 ? msg.toString('utf8') : msg); }
      } else if (f.opcode === 0) {
        if (msgOpcode === 0) { socket.destroy(); return; } // protocol error: continuation without a start
        parts.push(f.payload);
        if (f.fin) { const msg = Buffer.concat(parts); const op = msgOpcode; msgOpcode = 0; parts = []; emit('message', op === 1 ? msg.toString('utf8') : msg); (handle.opts.onMessage as ((...a: unknown[]) => void) | undefined)?.(wrapped, op === 1 ? msg.toString('utf8') : msg); }
      }
    }
  });
  socket.on('close', () => { clients.delete(wrapped); emit('close', null); (handle.opts.onClose as ((...a: unknown[]) => void) | undefined)?.(wrapped); });
  socket.on('error', (e: Error) => emit('error', e));
  return wrapped;
}

const __NOOP_NET = {
  send: () => {}, close: () => {}, write: () => {}, end: () => {}, destroy: () => {}, on: () => {},
  joinMulticast: () => {}, leaveMulticast: (): void => {},
  address: () => ({ port: 0, host: 'localhost', family: 'IPv4' }),
};
const __NOOP_WS = (port: number, host?: string) => ({
  close: (): void => {},
  clients: (): unknown[] => [],
  broadcast: (): void => {},
  address: () => ({ port, host: host || '0.0.0.0' }),
});

export function $udp(port: number, opts: NetOpts = {}): any {
  if (typeof document === 'undefined') __netReg('udp', port, opts.host as string | undefined, opts);
  return { ...__NOOP_NET, address: () => ({ port, host: (opts.host as string) || '0.0.0.0', family: 'IPv4' }) };
}

export function $tcp(portOrHost: number | string, opts: NetOpts = {}): any {
  if (typeof document !== 'undefined') return { ...__NOOP_NET };
  const isServer = typeof portOrHost === 'number' || opts.onConnection !== undefined
    || (opts.port !== undefined && opts.host !== undefined && opts.onConnect === undefined);
  if (isServer) {
    const port = typeof portOrHost === 'number' ? portOrHost : (opts.port as number);
    __netReg('tcp', port, opts.host as string | undefined, opts);
    return { ...__NOOP_NET, address: () => ({ port, host: (opts.host as string) || '0.0.0.0' }) };
  }
  const nt = (globalThis as any).__rosespan_net;
  if (!nt) return { ...__NOOP_NET };
  const host = typeof portOrHost === 'string' ? portOrHost : (opts.host as string);
  const sock = nt.createConnection({ host, port: opts.port as number });
  sock.on('connect', () => (opts.onConnect as (() => void) | undefined)?.());
  sock.on('data', (d: Buffer) => (opts.onData as (s: unknown, d: Buffer) => void)?.(sock, d));
  sock.on('close', () => (opts.onClose as (() => void) | undefined)?.());
  sock.on('error', (e: Error) => (opts.onError as (e: Error) => void)?.(e));
  __netHandles.push(sock);
  return sock;
}

export function $listen(port: number, opts: NetOpts = {}): any {
  if (typeof document !== 'undefined') return { ...__NOOP_NET, address: () => ({ port, host: (opts.host as string) || 'localhost' }) };
  const protocol = (opts.protocol as string) || 'http';
  if (protocol === 'udp') $udp(port, { host: opts.host, onMessage: opts.onData, onError: opts.onError });
  else if (protocol === 'tcp') $tcp(port, { host: opts.host, onConnection: opts.onConnection, onData: opts.onData });
  else if (protocol === 'websocket') $websocket(port, { host: opts.host, path: opts.path, onConnection: opts.onConnection });
  return { close: () => {}, address: () => ({ port, host: (opts.host as string) || '0.0.0.0' }) };
}

/**
 * $websocket - WebSocket server (RFC 6455).
 * Registers a spec like $udp/$tcp; the returned facade delegates to the live
 * handle once __startNetwork() binds it, so app code can broadcast/close at any
 * time (on the client the facade is an inert no-op).
 */
export function $websocket(port: number, opts: NetOpts = {}): any {
  const host = opts.host as string | undefined;
  if (typeof document !== 'undefined') return __NOOP_WS(port, host);
  __netReg('ws', port, host, opts);
  return {
    close: () => __netUnreg('ws', port, host),
    clients: () => {
      const h = __netBound.get('ws:' + port + ':' + (host || ''));
      return h ? (h.clients as () => unknown[])() : [];
    },
    broadcast: (data: unknown) => {
      const h = __netBound.get('ws:' + port + ':' + (host || ''));
      if (h) (h.broadcast as (d: unknown) => void)(data);
    },
    address: () => ({ port, host: host || '0.0.0.0' }),
  };
}

/**
 * $mqtt - MQTT 3.1.1 client (zero-dependency, like $websocket).
 * Registers a spec; __startNetwork() opens the TCP connection to the broker, so
 * a build/prerender never dials out. The facade delegates to the live client:
 * subscribe/publish work before CONNACK (packets queue and flush on connect).
 */
export function $mqtt(broker: string, opts: NetOpts = {}): any {
  const host = (opts.host as string) || __mqttHostOf(broker);
  const port = (opts.port as number) ?? __mqttPortOf(broker);
  if (typeof document !== 'undefined') return __NOOP_MQTT;
  __netReg('mqtt', port, host, opts);
  const key = 'mqtt:' + port + ':' + host;
  const bound = () => __netBound.get(key);
  return {
    connect: () => {
      const h = bound();
      if (h) return (h.connect as () => Promise<void>)();
      __netBind({ kind: 'mqtt', port, host, opts });
      const h2 = bound();
      return h2 ? (h2.connect as () => Promise<void>)() : Promise.reject(new Error('[rosespan] MQTT client unavailable (node:net not injected)'));
    },
    disconnect: () => { (bound() as { disconnect?: () => void } | undefined)?.disconnect?.(); },
    subscribe: (topic: string, sopts: NetOpts = {}) => { (bound() as { subscribe?: (t: string, s: NetOpts) => void } | undefined)?.subscribe?.(topic, sopts); },
    unsubscribe: (topic: string) => { (bound() as { unsubscribe?: (t: string) => void } | undefined)?.unsubscribe?.(topic); },
    publish: (topic: string, message: unknown, popts: NetOpts = {}) => { (bound() as { publish?: (t: string, m: unknown, p: NetOpts) => void } | undefined)?.publish?.(topic, message, popts); },
    get connected() { return (bound() as { connected?: boolean } | undefined)?.connected === true; },
  };
}

const __NOOP_MQTT = {
  connect: (): Promise<void> => Promise.resolve(),
  disconnect: (): void => {},
  subscribe: (): void => {},
  unsubscribe: (): void => {},
  publish: (): void => {},
  connected: false,
};

function __mqttHostOf(broker: string): string {
  return String(broker).replace(/^\w+:\/\//, '').split(':')[0] || 'localhost';
}
function __mqttPortOf(broker: string): number {
  const m = String(broker).match(/:(\d+)/);
  return m ? Number(m[1]) : 1883;
}

// === MQTT 3.1.1 codec (client side) ===
function __mqttStr(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  const out = Buffer.allocUnsafe(2 + b.length);
  out.writeUInt16BE(b.length, 0);
  b.copy(out, 2);
  return out;
}
function __mqttRemainingLen(len: number): Buffer {
  const out: number[] = [];
  do {
    let b = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) b |= 0x80;
    out.push(b);
  } while (len > 0);
  return Buffer.from(out);
}
function __mqttPacket(type: number, flags: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), __mqttRemainingLen(body.length), body]);
}
/** Incremental packet splitter: complete packets out, partial tail back (same discipline as the WS frame parser). */
function __mqttParsePackets(buf: Buffer): { packets: { type: number; flags: number; body: Buffer }[]; rest: Buffer } {
  const packets: { type: number; flags: number; body: Buffer }[] = [];
  let off = 0;
  for (;;) {
    if (off >= buf.length) break;
    const type = (buf[off] >> 4) & 0x0f;
    const flags = buf[off] & 0x0f;
    let mult = 1;
    let len = 0;
    let p = off + 1;
    for (;;) {
      if (p >= buf.length) return { packets, rest: buf.slice(off) };
      const b = buf[p++];
      len += (b & 0x7f) * mult;
      if ((b & 0x80) === 0) break;
      mult *= 128;
    }
    if (p + len > buf.length) return { packets, rest: buf.slice(off) };
    packets.push({ type, flags, body: buf.slice(p, p + len) });
    off = p + len;
  }
  return { packets, rest: Buffer.alloc(0) };
}
/** Topic filter match: exact segments, '+' one level, '#' the rest (must be last). */
function __mqttTopicMatch(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] === '+') continue;
    if (f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

function __mqttU16(id: number): Buffer {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16BE(id & 0xffff, 0);
  return b;
}

/**
 * Create the live MQTT client for a bound spec. Callbacks are read from
 * client.opts at event time (same swap-on-re-register discipline as the WS
 * handle). Packets sent before CONNACK queue and flush on connect.
 */
function __mqttConnect(nt: any, port: number, host: string, o: NetOpts): any {
  const sock = nt.createConnection({ host, port });
  const client: any = {
    opts: o,
    connected: false,
    subs: new Map<string, number>(),
    outbox: [] as Buffer[],
    nextId: 1,
    connAck: null as Promise<void> | null,
    __resolveConnAck: null as (() => void) | null,
    __rejectConnAck: null as ((e: Error) => void) | null,
    __keepalive: null as ReturnType<typeof setInterval> | null,
    __send: (buf: Buffer) => {
      if (client.connected) { try { sock.write(buf); } catch { /* already gone */ } }
      else client.outbox.push(buf);
    },
    connect: (): Promise<void> => client.connAck,
    close: () => client.disconnect(),
    disconnect: () => {
      try { sock.write(__mqttPacket(14, 0, Buffer.alloc(0))); } catch { /* already gone */ }
      sock.end();
    },
    subscribe: (topic: string, sopts: NetOpts = {}) => {
      client.subs.set(topic, (sopts.qos as number) || 0);
      client.__send(__mqttPacket(8, 2, Buffer.concat([__mqttU16(client.nextId++), __mqttStr(topic), Buffer.from([(sopts.qos as number) || 0])])));
    },
    unsubscribe: (topic: string) => {
      client.subs.delete(topic);
      client.__send(__mqttPacket(10, 2, Buffer.concat([__mqttU16(client.nextId++), __mqttStr(topic)])));
    },
    publish: (topic: string, message: unknown, popts: NetOpts = {}) => {
      const qos = (popts.qos as number) || 0;
      let head = __mqttStr(topic);
      if (qos > 0) head = Buffer.concat([head, __mqttU16(client.nextId++)]);
      const payload = typeof message === 'string' ? Buffer.from(message, 'utf8')
        : Buffer.isBuffer(message) ? message
        : Buffer.from(String(message), 'utf8');
      client.__send(__mqttPacket(3, (qos << 1) | (popts.retain ? 1 : 0), Buffer.concat([head, payload])));
    },
  };
  client.connAck = new Promise<void>((res, rej) => { client.__resolveConnAck = res; client.__rejectConnAck = rej; });
  // The facade's connect() is optional: an app that ignores it must not turn a
  // refused broker into an unhandled rejection that kills the process. The
  // no-op catch marks the promise handled while still rejecting for awaiters.
  client.connAck.catch(() => {});

  sock.on('connect', () => {
    let flags = o.clean !== false ? 0x02 : 0;
    const username = o.username as string | undefined;
    const password = o.password as string | undefined;
    if (username) flags |= 0x80;
    if (password) flags |= 0x40;
    const parts: Buffer[] = [__mqttStr('MQTT'), Buffer.from([4]), Buffer.from([flags]), __mqttU16((o.keepalive as number) ?? 60), __mqttStr((o.clientId as string) || ('rosespan_' + Math.random().toString(16).slice(2, 10)))];
    if (username) parts.push(__mqttStr(username));
    if (password) parts.push(__mqttStr(password));
    sock.write(__mqttPacket(1, 0, Buffer.concat(parts)));
    const ka = (o.keepalive as number) ?? 60;
    if (ka > 0) client.__keepalive = setInterval(() => { try { sock.write(__mqttPacket(12, 0, Buffer.alloc(0))); } catch { /* already gone */ } }, Math.max(250, ka * 500));
  });
  (sock as any).__mqttBuf = Buffer.alloc(0);
  sock.on('data', (chunk: Buffer) => {
    const s = sock as any;
    s.__mqttBuf = s.__mqttBuf.length ? Buffer.concat([s.__mqttBuf, chunk]) : chunk;
    const { packets, rest } = __mqttParsePackets(s.__mqttBuf as Buffer);
    s.__mqttBuf = rest;
    for (const pkt of packets) {
      if (pkt.type === 2) {
        if (pkt.body.length >= 2 && pkt.body[1] === 0) {
          client.connected = true;
          for (const q of client.outbox) { try { sock.write(q); } catch { /* already gone */ } }
          client.outbox.length = 0;
          client.__resolveConnAck?.();
          (client.opts.onConnect as (() => void) | undefined)?.();
        } else {
          const err = new Error('[rosespan] MQTT broker refused the connection (code ' + (pkt.body[1] ?? '?') + ')');
          client.__rejectConnAck?.(err);
          (client.opts.onError as ((e: Error) => void) | undefined)?.(err);
        }
      } else if (pkt.type === 3) {
        if (pkt.body.length < 2) continue;
        const tlen = pkt.body.readUInt16BE(0);
        const topic = pkt.body.slice(2, 2 + tlen).toString('utf8');
        let p = 2 + tlen;
        const qos = (pkt.flags >> 1) & 0x03;
        let pid = 0;
        if (qos > 0 && pkt.body.length >= p + 2) { pid = pkt.body.readUInt16BE(p); p += 2; }
        const payload = pkt.body.slice(p);
        for (const filter of client.subs.keys()) {
          if (__mqttTopicMatch(filter, topic)) { (client.opts.onMessage as ((t: string, m: Buffer) => void) | undefined)?.(topic, payload); break; }
        }
        if (qos === 1 && pid) client.__send(__mqttPacket(4, 0, __mqttU16(pid)));
      }
      // 9 SUBACK / 11 UNSUBACK / 13 PINGRESP: acknowledgement only, nothing to surface
    }
  });
  sock.on('close', () => {
    client.connected = false;
    if (client.__keepalive) { clearInterval(client.__keepalive); client.__keepalive = null; }
    client.__rejectConnAck?.(new Error('[rosespan] MQTT connection closed before CONNACK'));
  });
  sock.on('error', (err: Error) => {
    (client.opts.onError as ((e: Error) => void) | undefined)?.(err);
    if (!client.connected) client.__rejectConnAck?.(err);
  });
  return client;
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
export function $actionPending(): boolean {
  const entry = renderMaps().signals.get('actionPending');
  return entry ? entry.value === true : false;
}

export function $actionError(): ActionErrorInfo | null {
  const e = renderMaps().signals.get('actionError');
  if (!e) return null;
  if (currentEffect) {
    e.subs.add(currentEffect);
    if (trackingDeps) trackingDeps.add(e);
  }
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
  if (err instanceof ActionError) return `<p class="rosespan-action-error">${esc(err.message)}</p>`;
  return '<p>This section failed to render.</p>';
}

export type StateDeltaOp = 'append' | 'prepend' | 'merge';

export class StateDelta {
  constructor(public op: StateDeltaOp, public value: unknown) {}
}

/** Append (or prepend) items to a list-valued state key. */
export const $append = (value: unknown): StateDelta => new StateDelta('a', value);
export const $prepend = (value: unknown): StateDelta => new StateDelta('p', value);
/** Shallow-merge an object into an object-valued state key. */
export const $merge = (value: Record<string, unknown>): StateDelta => new StateDelta('m', value);

const pendingDeltas = new Map<string, StateDelta>();

/** Record the deltas of the action that just ran (the dispatch calls this). */
export function setStateDelta(key: string, delta: StateDelta): void {
  pendingDeltas.set(key, delta);
}

/** Apply every pending delta to the live state and clear them. */
export function applyStateDeltas(): void {
  if (pendingDeltas.size === 0) return;
  for (const [key, delta] of [...pendingDeltas]) {
    pendingDeltas.delete(key);
    applyStateDelta(key, delta);
  }
}

/** Apply one delta to the live state. */
export function applyStateDelta(key: string, delta: StateDelta): void {
  const cur = renderMaps().signals.get(key)?.value;
  if (delta.op === 'm') {
    setState(key, { ...(cur as Record<string, unknown> | undefined), ...(delta.value as Record<string, unknown>) });
    return;
  }
  const list = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const merged = delta.op === 'a' ? [...list(cur), ...list(delta.value)] : [...list(delta.value), ...list(cur)];
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
  (window as unknown as { __rosespan_vitals?: Record<string, number> }).__rosespan_vitals = live;
  const send = (name: string, value: number) => {
    live[name] = value;
    window.dispatchEvent(new CustomEvent('rosespan:vitals', { detail: { name, value, route: location.pathname } }));
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
