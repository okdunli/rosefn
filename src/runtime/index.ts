/**
 * rosefn Runtime - Zero-hydration, compile-time reactivity
 * Target: < 2KB gzipped
 */

// === Reactive Primitives ===

type Subscriber = () => void;
type Cleanup = () => void;
type SignalEntry = { value: unknown; subs: Set<Subscriber> };

let currentEffect: (() => void) | null = null;

// Trade-off: global signal map, shared across all inlined modules
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
 // The key belongs to whoever is rendering, so a mount's navigation
  // can drop exactly its own keys (see resetContainerFx).
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

// Effects are tracked so client-side navigation can dispose the old ones.
// Each cleanup removes itself, so locally disposed effects do not leak.
const cleanups = new Set<Cleanup>();

// Per-container ownership. A mount (dist/mount.js) renders a rosefn
// app inside a FOREIGN page, and a page can host several mounts - so the
// effect/cleanup/key bookkeeping cannot be one global set: one mount's
// navigation must not dispose another's reactivity, and the signal map is
// shared by design. While an owner is set, everything a render creates is
// attributed to it; the document path (no owner) keeps the global set and
// the global resetEffects()/clearRequestState() exactly as they were.
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

/** Attribute everything the current render creates to `container` (null = the
 *  document's global bookkeeping). The client entry sets this around every
 *  mount render and clears it after. */
export function setFxOwner(container: object | null): void {
  fxOwner = container;
}

/**
 * Dispose everything ONE container created - its effects, its onCleanups, the
 * state keys its render seeded, and the render caches - leaving every other
 * container (and the document) untouched. A mount's navigation calls this
 * instead of the global reset; the document path keeps the global pair.
 */
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
      // subscriber may be stale; ignore
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

// === Generated-code marker helpers ===
// Every reactive marker in every generated module is emitted through these
// five functions, so a site costs a call instead of the marker protocol
// spelled out inline (the demo bundle alone had 46 sites, each repeating the
// same 60-170 bytes). The protocol is unchanged: each helper pushes its
// closure and returns the markers around the value, so push order still
// equals marker order and wire() reads the same indices. The closures take
// the block scope as their argument exactly as before - wire() invokes them
// with it.

type Close = (s?: unknown) => unknown;

export function textMark(closes: Close[], fn: Close, pair?: boolean, arg?: unknown): string {
  const i = closes.push(fn) - 1;
  return `<!--\u27e6m:${i}\u27e7-->` + esc(closes[i](arg)) + (pair ? `<!--\u27e6/m:${i}\u27e7-->` : '');
}

export function attrMark(closes: Close[], fn: Close, name: string, arg?: unknown): string {
  const i = closes.push(fn) - 1;
  return `${name}="${esc(closes[i](arg))}" data-b="${i}:${name}"`;
}

export function ifMark(
  closes: Close[],
  cond: Close,
  fn: (s: unknown, c: Close[]) => unknown,
  scope?: unknown
): string {
  const i = closes.length;
  // The content renders the FIRST time the block shows, never before: the
  // eager version crashed `{#if user()}{user().name}{/if}`, because it
  // rendered the body while the condition was still false. A block that
  // never shows costs nothing.
  //
  // The memo is per SHOWING, not per render: this close outlives the render
  // that created it (the client's {#if} effect calls it on every toggle),
  // so memoizing across a hide would replay the content as it was when the
  // block was last open - losing everything that changed meanwhile (an
  // item added to a list inside the block, a flag the user flipped while
  // it was hidden). Hiding forgets the render; the next showing re-renders.
  let snap: { html: string; closes: Close[] } | null = null;
  closes.push(() => {
    if (!cond()) {
      snap = null;
      return null;
    }
    if (!snap) {
      const c: Close[] = [];
      snap = { html: String(fn(scope, c)), closes: c };
    }
    return snap;
  });
  const r = closes[i]() as { html: string } | null;
  return `<!--\u27e6i:${i}\u27e7-->` + (r ? r.html : '') + `<!--\u27e6/i:${i}\u27e7-->`;
}

export function eachMark(closes: Close[], items: Close, fn: (s: unknown, c: Close[]) => unknown): string {
  const i = closes.length;
  closes.push(() => (items() as unknown[]).map((v) => {
    const c: Close[] = [];
    return { html: String(fn(v, c)), closes: c, scope: v };
  }));
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
 * does, with an EMPTY closes array - trusted HTML is opaque markup, the
 * compiler never scans inside it, so there are no inner markers to wire.
 * `arg` is the enclosing block's scope value, exactly as textMark takes it:
 * a `{@html row.body}` inside an {#each} resolves against the row.
 */
export function rawMark(closes: Close[], fn: Close, arg?: unknown): string {
  const i = closes.push((s?: unknown) => ({ html: String((fn as (a?: unknown) => unknown)(s) ?? ''), closes: [] })) - 1;
  const r = closes[i](arg) as { html: string };
  return `<!--\u27e6i:${i}\u27e7-->` + r.html + `<!--\u27e6/i:${i}\u27e7-->`;
}

// === Reactive DOM wiring (client) ===

const MARK_RE = /^\u27e6([milh]):(\d+)\u27e7$/;
// `m` ends a text marker whose value is followed by literal text:
// the pair bounds exactly the value, so patching it cannot eat the prose.
const END_RE = /^\u27e6\/([milh]):(\d+)\u27e7$/;

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

// The delegated-event handler registry: every compiled module registers its
// handlers here (Object.assign(handlers, { ... })), and one listener per event
// type on the app container dispatches by name - including for freshly cloned
// nodes, which is why the registry is a shared global rather than per-module
// state. It lives in the runtime, not in each generated module: an initializer
// with a side effect (the `??=` assignment) defeats esbuild's tree-shaking, so
// a per-module copy would ship in every document even when nothing dispatches.
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
  // tag -> how many unkeyed elements of that tag came before (the server's
  // mergeHeadBlocks counts the same way over the same block order)
  const positional = new Map<string, number>();
  const frag = tpl(html);
  const title = frag.querySelector('title');
  if (title) {
    // Manage the title element directly: the document.title setter would
    // update the FIRST title element in tree order - the inert placeholder
    // wire() is about to remove from the page body.
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
    // Bug report 2026.9.22 11:46: a head element with no name/property/rel/
    // charset attribute used to be dropped here in silence, so a route's own
    // <style> block or JSON-LD <script> survived the server render and then
    // vanished on the first client-side navigation. Everything passes through
    // now: the keyed singletons keep their identity attribute, and the rest
    // are keyed by id or by tag+position - the same scheme (and the same
    // block order) mergeHeadBlocks uses on the server, so both sides agree.
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
    if (seen.has(managed)) continue; // first block wins: page over layout
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

  // Comments that live INSIDE an {#if}/{#each}/slot block belong to that
  // block's OWN wire pass (its render pushed them onto its own closes
  // array, where the same index means something else entirely). They are
  // collected here because the walker sees the whole subtree, but only the
  // block's recursive wire() may interpret them - so they are skipped below
  // and their end markers never enter this pass's `ends` map.
  //
  // Pairing is STRUCTURAL, not first-match: block markers are indexed per
  // closes array, and every block renders into its own array, so an inner
  // block routinely shares its parent's index - the first {#if} in a page
  // and the first {#if} inside it are both ⟦i:0⟧. Matching an open against
  // the first end marker in document order therefore paired the OUTER
  // start with the INNER end, and left the second row's markers (after
  // that end) for the outer pass to interpret with the wrong array. A
  // stack of open starts closes on the innermost block of the same kind
  // and index, which is what the document structure actually says.
  const nested = new Set<Comment>();
  const open: number[] = []; // positions of the open {#if}/{#each} starts
  for (let i = 0; i < comments.length; i++) {
    const m = (comments[i].nodeValue ?? '').match(MARK_RE);
    if (m && (m[1] === 'i' || m[1] === 'l')) {
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
    if (at < 0) continue; // an end with no open block: nothing to pair with
    for (let k = open[at] + 1; k < i; k++) nested.add(comments[k]);
    open.length = at; // pop this block and any inner block left unclosed
  }

  const ends = new Map<number, Comment>();
  for (const c of comments) {
    if (nested.has(c)) continue;
    const m = (c.nodeValue ?? '').match(END_RE);
    if (m) ends.set(+m[2], c);
  }

  // Head blocks are collected during the walk and applied afterwards as ONE
  // effect over the whole route's head: the blocks render in document order (a
  // page renders inside its layout's <slot/>, so its block comes first) into a
  // single string, and applyHead resolves the duplicates - page over layout,
  // the same first-wins rule the server's mergeHeadBlocks uses. One effect
  // instead of one per block: a head is a handful of elements, and rebuilding
  // it whole is smaller than patching it key by key.
  const headBlocks: Array<{ idx: number; start: Comment; end: Comment; nodes: ChildNode[] }> = [];

  for (const c of comments) {
    if (nested.has(c) || wired.has(c) || !c.parentNode) continue;
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
      // Text: update the text node that follows the marker comment. When the
      // marker is a PAIR (value followed by literal text), the end comment
      // bounds the value: anything a render left between the two is dropped,
      // so the prose around the value survives every patch.
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
        if (!r) {
          // Hidden. The client has now evaluated this block once, so from
          // here on whatever sits between the anchors is client-rendered:
          // a block the server left hidden has NOTHING to adopt, and its
          // first visible run must clone from the fresh render instead of
          // moving an empty range out and back.
          st.__ever = true;
          return;
        }
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
 // r.scope is set by a named slot's block: its content is
        // scoped to the object the child passed in, exactly like a list
        // item. An {#if} block returns no scope and keeps the enclosing one.
        const disp = wire(frag, r.closes, (r as { scope?: unknown }).scope ?? scope);
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

  // Apply head blocks, then drop the inert placeholder nodes from the page
  // body. A top-level wire with no head blocks (route without <head>) clears
  // the previous route's managed head; nested wires (if/each blocks) never
  // contain head blocks.
 // Only the DOCUMENT's app root owns <head>. A mount (dist/mount.js)
  // wires a container inside a FOREIGN page: the host's title and meta are
  // the host's, so a mounted route's head content stays in the container as
  // inert body nodes (its <style> still applies, which is the point) and is
  // never applied to - or cleared from - the host document.
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

// Trade-off: cache keyed by function source, cleared per request/navigation.
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
// set for this very render. Pending action deltas ARE cleared: they belong
// to the request that recorded them, and a delta that outlived its render
// would silently mutate the next request's page.
export function clearRequestState(): void {
  signalMap.clear();
  dataCache.clear();
  pendingDeltas.clear();
}

// === Request query (P0-1) ===
// The parsed query string of the request being rendered (?page=2&q=x ->
// {page:'2',q:'x'}) - the other half of the query-404 fix: routing matches
// the pathname, so a page that wants the query reads it here instead of
// parsing the URL itself. Server: the CLI sets it once per request before
// the render. Client: the browser's own URL is the request there, read live
// so every navigation sees its own query - except during a hover prefetch,
// which renders a DIFFERENT route than the one on screen, so the client
// entry overrides it for the duration of that render (prefetchOverride).
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
 * Concurrent prefetches are queued by the caller (trade-off: hover prefetches
 * are rare and cheap).
 */
export async function isolateStateAsync<T>(
  fn: () => Promise<T>
): Promise<{ result: T; state: Map<string, SignalEntry>; mounts: Array<() => void>; cleanups: Set<Cleanup> }> {
  const savedSignals = signalMap;
  const savedData = dataCache;
  const savedDeltas = new Map(pendingDeltas); // a prefetch render must not consume a delta
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
    savedDeltas.forEach((d, k) => pendingDeltas.set(k, d)); // restore what was pending
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
// a router refresh / a full invalidation. No hook (server
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

// === i18n: localized routes ===
// Every JSON file in src/locales/ is a language: { "key": "string" }. The
// bundle entries call setLocales() once at boot - server, edge and client
// alike - so $t resolves on both sides with no per-request plumbing, and a
// client-side switch between locales renders from the bundle: zero requests.
// A missing key renders the key itself: loud in dev, greppable in prod.
//
// Lifts the value format from "flat string with {name} holes" to the
// ICU MessageFormat subset real apps need - cardinal plurals, ordinals and
// selects - and lets an app leave a locale OUT of the bundle. The flat form
// stays the default and stays byte-identical: a message with no ICU syntax
// parses to one literal node and interpolates exactly as before, and every
// dictionary still ships inline unless rosefn.config.js says otherwise
// (i18n.preload). The one-request bet is the default; a thirty-language app
// pays one fetch per language per session instead of thirty bundles.
let LOCALES: Record<string, Record<string, string>> = {};
let DEFAULT_LOCALE = 'en';
// The locales this build did NOT bake in: they live at /locales/<lang>.json
// and ensureLocale() fetches one on first use. Empty in the default build -
// then every locale is inline and a switch costs nothing at all.
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
  // A pack counts as a known locale BEFORE it loads: the client router must
  // not 404 /ar/about while /locales/ar.json is still in flight.
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

// --- ICU MessageFormat, the subset real apps use ---------------------
//
//   {count, plural, =0 {No signatures yet} one {# item} other {# items}}
//   {n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}
//   {who, select, rose {her} thorn {its} other {their}}
//
// `#` is the count, `=N` an exact arm, and the plural CATEGORY comes from the
// platform (Intl.PluralRules) rather than a re-implementation of CLDR - so
// Arabic's zero/one/two/few/many/other arms all resolve, for free. A branch
// body may hold one level of {braces}, so a {name} hole inside a branch
// works: the interpolation pass at the bottom fills it after the expansion.
// Anything the grammar does not match (nested ICU, a missing `other` arm)
// renders verbatim - the same loud-degradation rule as a missing key.
//
// Trade-off: two regexes and a replace - no parse tree, no memoization. A
// message is a few dozen bytes and the scan is linear; the cached tree cost
// more code than it ever saved in time. The plural rules object is built per
// expansion for the same reason: Intl caches its own internals, and a cache
// here would be more code than the constructions it saves.
const ICU_RE = /\{([\w$]+),\s*(plural|selectordinal|select),\s*((?:\s*[=\w]+\s*\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g;
const BRANCH_RE = /([=\w]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;

/** The CLDR category of `n` in `locale`, or null where Intl has no answer. */
function pluralCategory(locale: string, ordinal: boolean, n: number): string | null {
  try {
    return new Intl.PluralRules(locale, ordinal ? { type: 'ordinal' } : undefined).select(n);
  } catch {
    return null; // no Intl.PluralRules, or an invalid tag: the English-ish fallback
  }
}

/** Expand every ICU block of a message; leave the rest (and {name} holes) alone. */
function expandIcu(msg: string, vars: Record<string, string | number> | undefined, locale: string): string {
  return msg.replace(ICU_RE, (whole, arg: string, kind: string, branchText: string) => {
    const branches: Record<string, string> = {};
    for (const m of branchText.matchAll(BRANCH_RE)) branches[m[1]] = m[2];
    if (!branches.other) return whole; // no fallback arm: not valid ICU, render it verbatim
    const v = vars?.[arg];
    if (kind === 'select') return branches[typeof v === 'string' && branches[v] ? v : 'other'];
    const num = typeof v === 'number' ? v : Number(v);
    // An =N arm wins over the category; a value with no number in it has no
    // category at all, so it takes the other arm - and # prints the value as
    // given, which is the loudest thing a typo'd count can do.
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

// --- the shared server store ----------------------------------------
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
// Trade-off: one driver (memory + cluster IPC) covers every single-machine
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

// --- server action errors, guards and incremental patches -----------
//
// The action model's three gaps, closed with one request-scoped mechanism.
//
//  1. A standardized failure object. An action that cannot do its job (bad
//     input, not signed in, a duplicate) throws ActionError; the dispatch
//     catches it, seeds the page's state with it and re-renders, so the page
//     answers with the failure VISIBLE (status = the error's code) instead of
//     a 500 or a silent no-op. A bug still propagates to the 500 page.
//  2. A guard. `export async function beforeAction(name, form)` runs before
//     every action of its page and vetoes with an ActionError - the
//     action-level permission check (a redirect stays the middleware's job).
//  3. Incremental patches. A patch value may be an OPERATION ($append and
//     friends) instead of a whole replacement, so growing a large list costs
//     one row instead of a second copy of the list.

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
  if (currentEffect) e.subs.add(currentEffect); // subscribe like a state read
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

// An incremental patch: an action's return value may map a key to an
// OPERATION instead of a whole replacement value, so appending one row to a
// thousand-row list costs one row instead of a second copy of the list.
//
// The dispatch RECORDS a delta and the page's own state declarations APPLY
// it - and that split is the whole design. The dispatch runs before the
// render, when this request's state does not exist yet, so there is nothing
// for a delta to be relative to; the declarations are what establish the
// value the page was going to render anyway (the $store snapshot, the $data
// result, the declared default). Applying the delta there makes it relative
// to exactly that, and the document still carries the merged result once -
// what disappears is the second full copy the action had to build.
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

// --- cookie helpers -------------------------------------------------
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

// === Client observability: the web-vitals hook ===
//
// A framework that sells TTFB, one request and zero hydration owes the app a
// way to prove it in production. `export const vitals = true` (root layout,
// like `prefetch`) makes the compiler import and call this once at boot, so
// an app that does not ask pays nothing - esbuild drops the whole block from
// a bundle that never references it.
//
// What it reports, and why this shape:
// - `ttfb`, `fcp`: one-shot paints, dispatched as soon as the browser has
//   them (the navigation and paint entries, already in the timeline).
// - `lcp`: dispatched on every new largest paint; the app keeps the last.
// - `cls`, `inp`: accumulated, dispatched when the page is hidden - the only
//   moment their value is final, which is exactly when a RUM backend wants
//   them. The running values stay readable on window.__rosefn_vitals for a
//   devtools extension.
// Every entry is one CustomEvent('rosefn:vitals') on window, so the app owns
// the transport (fetch, sendBeacon, a third-party RUM): the framework ships
// the measurement, not a pipeline.
// Trade-off: no percentile math, no session ids, no batching. INP is the worst
// interaction duration (the shape the spec uses) without the 98th-percentile
// session aggregation - a real app sends the events and lets its RUM do that.
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
  if (!PO) return; // a browser without observers still gets ttfb/fcp above
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
