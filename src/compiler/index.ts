/**
 * rosefn Compiler - Compile .rose components to SSR + client-resume JS
 *
 * Features: compile-time reactivity, zero-hydration resume, file-system
 * routing, nested layouts, server data fetching ($data) with request cache.
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import * as esbuild from 'esbuild';
import { RoseError, lineOf, lineAt } from './errors.js';
export { RoseError, lineOf, lineAt, errorInfo } from './errors.js';
export type { RoseErrorInfo } from './errors.js';

const COMPONENT_RE = /<script>([\s\S]*?)<\/script>/;
const TEMPLATE_RE = /<template>([\s\S]*?)<\/template>/;
const HEAD_RE = /<head>([\s\S]*?)<\/head>/;
const STYLE_RE = /<style>([\s\S]*?)<\/style>/;
const DECL_RE = /(?:let|const|var)\s+(\w+)[^=]*=\s*\$(state|data)\b/g;
const DECL_CAST_RE = /^\s+as\s+[^;\n]+/;
const SETSTATE_RE = /\$setState\(([^,]+),\s*([^)]+)\)/g;
const EVENT_RE = /on:(\w+)=\{([^}]+)\}/g;
const SLOT_RE = /<slot\s*\/?>/g;
/** A named slot: `<slot name="row" item={post} />` . The lookahead
 *  keeps the plain `<slot />` out of it - that one is the default slot. */
const SLOT_NAMED_RE = /<slot\s+((?=[^>]*\bname\s*=)[^>]*?)\/?>/g;

/**
 * Encode a named slot tag as the template expression
 * `__slot('row', [['item', (post)]])` - array pairs, because the template
 * scanner matches `{...}` without nested braces.
 */
function encodeSlotCall(attrs: string): string {
  const name = /\bname\s*=\s*["'](\w+)["']/.exec(attrs)?.[1];
  if (!name) throw new RoseError('E-TEMPLATE', '<slot> with attributes must declare a name: <slot name="row" ... />', { hint: 'a slot carrying attributes is a NAMED slot - it must declare which one: <slot name="row" item={post} />' });
  const pairs = [...attrs.matchAll(/\b(\w+)\s*=\s*\{([^}]*)\}/g)]
    .filter((m) => m[1] !== 'name')
    .map((m) => `['${m[1]}', (${m[2].trim()})]`);
  return `${JSON.stringify(name)}, [${pairs.join(', ')}]`;
}
const BOUNDARY_FALLBACK = '<p>This section failed to render.</p>';
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const TS_LOADER = { loader: { '.js': 'ts' as const } };

export interface CompileResult {
  ssr: string;
  client: string;
  stateKeys: string[];
  actionNames: string[];
 /** The page exports `beforeAction` (the action guard), or null */
  guardName: string | null;
  /** scoped CSS from the component's <style> block ('' when it has none) */
  style: string;
  /** the component exports `params` (dynamic-route prerender enumeration) */
  hasParams: boolean;
  /** api route: the module source (handlers stay exported verbatim) */
  api?: string;
  /** HTTP method names the api route exports (GET/POST/...) */
  apiMethods?: string[];
  /** api route exports `prerender = true` (bake its GET body at build time) */
  hasPrerender?: boolean;
  /** the component reads the request context (getContext()): it is dynamic */
  usesContext?: boolean;
  /** the component exports `revalidate = N` (ISR window in seconds) */
  revalidate?: number;
  /** the component exports `csr = false` (document ships without the client bundle) */
  csr?: boolean;
  /**
   * P0-2 (bug report): the component exports `buffer = true` - render it per
   * request on the BUFFERED path instead of streaming. A streamed response
   * commits its status and headers before the body exists, so an onResponse
   * hook cannot see (let alone replace) the document and a route that fails
   * mid-render still answers 200. This is the explicit opt-out: the route
   * keeps the exact same features, it just refuses to trade them for TTFB.
   * Implies dynamic: a baked file on disk is the one path a hook can never
   * run on, so `buffer = true` routes are never prerendered.
   */
  buffer?: boolean;
  /** the component exports `prefetch = 'off' | 'hover' | 'viewport' | 'all'` (app-global link-prefetch strategy) */
  prefetch?: string;
 /** The component exports `vitals = true` (app-global web-vitals reporting) */
  vitals?: boolean;
 /** the component exports `bundle = 'inline' | 'split'` (app-global client bundle mode) */
  bundle?: string;
 /** The static analysis says this component needs the client bundle */
  needsClient?: boolean;
 /** WHY it needs the client - the rules that fired, for the build report */
  clientReasons?: string[];
  /**
 * Shapes that MIGHT need JavaScript but the syntactic
   * predicate cannot prove, on a component that otherwise ships none (an
   * inline on* attribute, a javascript: URL, eval/new Function). Warnings,
   * never errors: the document still ships, but the build says it out loud.
   */
  jsWarnings?: string[];
  /** the component exports `headers = { ... }` (per-route response headers) */
  headers?: Record<string, string>;
  /**
 * The component exports `csp = { nonce: true }` - its documents get a
   * per-request nonce policy instead of the hashed one. Never prerendered: a
   * baked file cannot carry a fresh nonce.
   */
  cspNonce?: boolean;
  /**
 * The component's props - `export let title = 'x'` in its script.
   * A prop is a plain value the caller passes per invocation (never a
   * signal: the parent re-renders the child when a prop changes), so it is
   * read straight from the props object with its default as the fallback.
   */
  props?: Array<{ name: string; def: string | null }>;
  /**
 * `.rose` imports this component makes, resolved to module indices.
   * The specifiers are rewritten per bundle (ssr/client) by the generators,
   * so one source resolves against both module sets.
   */
  roseImports?: Array<{ name: string; specifier: string; index: number }>;
 /** This file lives in src/components/ (a reusable component, not a route) */
  isComponent?: boolean;
}

export interface RouteInfo {
  filePath: string;
  routePath: string;
  pattern: string;
  paramNames: string[];
  isLayout: boolean;
  /** pages/404.rose: the not-found page, not a matchable route */
  isNotFound: boolean;
  /** pages/500.rose: the error page for routes whose render throws */
  isError: boolean;
  /** pages/api/*.rose: a Web-standard handler route, not an HTML page */
  isApi: boolean;
  /** pages/_middleware.rose: the request interceptor, not a route */
  isMiddleware: boolean;
 /** src/components/*.rose: a reusable component, never a route */
  isComponent?: boolean;
}

interface Decl {
  name: string;
  kind: 'state' | 'data';
  expr: string;
  start: number;
  end: number;
}

/**
 * Rewrite bare state reads as getter calls: `count` -> `count()`.
 *
 * A regex cannot do this safely - it would rewrite state names inside string
 * literals (`.get('name')` -> `.get('name()')`), template text, and comments.
 * This scanner copies those verbatim and only rewrites identifier positions,
 * keeping the original exclusions: not after [\w$.] (property access) and not
 * before [\w$:(] (call, declaration, or object key).
 */
function callifyStateReads(script: string, names: string[]): string {
  if (names.length === 0) return script;
  const scan = (src: string): string => {
    let out = '';
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "'" || ch === '"') {
        let j = i + 1;
        while (j < src.length && src[j] !== ch) {
          if (src[j] === '\\') j++;
          j++;
        }
        out += src.slice(i, Math.min(j + 1, src.length));
        i = j + 1;
        continue;
      }
      if (ch === '`') {
        out += ch;
        i++;
        while (i < src.length && src[i] !== '`') {
          if (src[i] === '\\') {
            out += src.slice(i, i + 2);
            i += 2;
            continue;
          }
          if (src[i] === '$' && src[i + 1] === '{') {
            let depth = 1;
            let j = i + 2;
            while (j < src.length && depth > 0) {
              if (src[j] === '{') depth++;
              else if (src[j] === '}') depth--;
              if (depth === 0) break;
              j++;
            }
            out += '${' + scan(src.slice(i + 2, j)) + '}';
            i = j + 1;
            continue;
          }
          out += src[i];
          i++;
        }
        out += '`';
        i++;
        continue;
      }
      if (ch === '/' && src[i + 1] === '/') {
        const nl = src.indexOf('\n', i);
        const end = nl === -1 ? src.length : nl;
        out += src.slice(i, end);
        i = end;
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        const close = src.indexOf('*/', i + 2);
        const end = close === -1 ? src.length : close + 2;
        out += src.slice(i, end);
        i = end;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j < src.length && /[\w$]/.test(src[j])) j++;
        const word = src.slice(i, j);
        const prev = out.length ? out[out.length - 1] : '';
        const next = src[j] ?? '';
        const rewrite = names.includes(word)
          && !/[\w$.]/.test(prev)
          && !/[\w$:(]/.test(next);
        out += rewrite ? `${word}()` : word;
        i = j;
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  };
  return scan(script);
}

/**
 * The template-side twin of callifyStateReads: every `{...}` expression gets
 * the same bare-read rewrite, and nothing else does. A whole-template scan
 * would also rewrite the word in prose - `<p>likes {likes()}</p>` would print
 * "likes()" - so the pass walks expressions only. Block syntax ({#if …},
 * {#each …}) rides along: callifying `rows` in `{#each rows as row}` is
 * exactly what the each branch already expects (`rows()`).
 */
function callifyTemplateExprs(template: string, names: string[]): string {
  if (names.length === 0) return template;
  let out = '';
  let last = 0;
  for (const s of templateExprSpans(template)) {
    out += template.slice(last, s.start) + '{' + callifyStateReads(s.expr, names) + '}';
    last = s.end + 1;
  }
  return out + template.slice(last);
}

/**
 * The spans of a template's top-level `{ ... }` expressions, literal-aware.
 *
 * A flat `[^{}]+` regex cannot see that `{q() ? `a ${q()}` : 'b'}` is ONE
 * expression: it matched the `{q()}` inside the template literal instead, so
 * the compiler rewrote THAT and left the rest as prose - the served document
 * carried `Search: $rose` where the title should have said `Search: rose`.
 * A wrong page with no error anywhere is the worst failure mode a template
 * compiler has, so the scan below walks the source once, skipping quoted
 * strings and template literals (whose own `${ ... }` holes are balanced
 * separately), and reports the expression a reader sees.
 *
 * Shared by every pass that must agree on where an expression ends: the
 * compiler itself, the state-read rewrite, the {#each} item rename and the
 * named-slot prop rewrite.
 */
export function templateExprSpans(src: string): Array<{ start: number; end: number; expr: string }> {
  const spans: Array<{ start: number; end: number; expr: string }> = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === '{') {
      const end = scanExprEnd(src, i);
      if (end > i + 1) {
        spans.push({ start: i, end, expr: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return spans;
}

/** The index of the `}` that closes the `{` at `open`, or -1 when it never does. */
function scanExprEnd(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(src, i);
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(src, i);
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
    i++;
  }
  return -1;
}

/** Just past the closing quote of the string literal that starts at `i`. */
function skipQuoted(src: string, i: number): number {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') {
      j += 2;
      continue;
    }
    if (src[j] === q) return j + 1;
    j++;
  }
  return j;
}

/** Just past the closing backtick of the template literal at `i`, `${ }` holes balanced. */
function skipTemplate(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === '`') return j + 1;
    if (ch === '$' && src[j + 1] === '{') {
      const end = scanExprEnd(src, j + 1);
      j = end < 0 ? src.length : end + 1;
      continue;
    }
    j++;
  }
  return j;
}

/**
 * 's scanners are syntactic, and prose is not code: the demo's
 * own "the same zero-JS document." (a sentence ending, not a member access)
 * tripped the browser-only warning on a route that touches no browser API.
 * Drop both comment syntaxes - JS line and block comments, HTML comments -
 * outside string and template literals, so a URL inside a string can never
 * eat the rest of its line and a real member access can never hide inside a
 * comment. Only the advisory warnings read the result: the needsClient
 * predicate keeps scanning the raw source, because missing a real `on:`
 * wiring is a broken page while a stray warning is only noise.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const q = src[i];
    if (q === '"' || q === "'") {
      const end = skipQuoted(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (q === '`') {
      const end = skipTemplate(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (src.startsWith('/*', i)) {
      i += 2;
      while (i < src.length && !src.startsWith('*/', i)) i++;
      i = Math.min(i + 2, src.length);
      continue;
    }
    if (src.startsWith('<!--', i)) {
      i += 4;
      while (i < src.length && !src.startsWith('-->', i)) i++;
      i = Math.min(i + 3, src.length);
      continue;
    }
    out += src[i++];
  }
  return out;
}

/**
 * The <script> block of a .rose source, verbatim. `rosefn check` must
 * type-check exactly what the compiler will embed, so the extraction lives
 * here and both consumers share it - one regex, one truth.
 */
export function scriptOf(source: string): string | null {
  return source.match(COMPONENT_RE)?.[1] ?? null;
}

/**
 * The per-request bag the runtime hooks receive. Web-standard on purpose:
 * the same object reaches a hook on the Node server, the preview server and
 * the edge adapter, so hook code is written once and runs everywhere.
 * `state` is scratch space - one hook writes, a later hook (or the page,
 * through getContext()) reads.
 */
export interface RequestHookContext {
  request: Request;
  url: URL;
  method: string;
  pathname: string;
  state: Record<string, unknown>;
}

/**
 * The cross-machine store bridge, handed to a plugin's `onServe`. A
 * `$store` write in this worker calls `install`'s sender; a patch that
 * arrived from anywhere else enters through `deliver` and lands in the
 * same store map the pages read. The cluster's own IPC relay stays the
 * default on one machine - this is the seam a redis/NATS driver plugs
 * into, from the worker process where its client library lives.
 */
export interface StoreBridge {
  /** Install the sender: every $store write in this worker calls it. Pass null to detach. */
  install(send: ((name: string, value: unknown) => void) | null): void;
  /** Apply a patch that arrived from another process or machine. */
  deliver(name: string, value: unknown): void;
}

/**
 * A plugin, in two halves. `transform` runs at BUILD time over each
 * component's raw source. The rest run at RUNTIME: `onRequest`/`onResponse`
 * once per request (Node server, dev/preview and edge adapter alike),
 * `onServe`/`onShutdown` once per worker process under `rosefn serve`
 * (Node only - an edge runtime owns the lifecycle, there is no worker start
 * to hook).
 *
 * A runtime hook is bundled into dist/server.js together with the config
 * module that declares it, so its imports must load in the target runtime
 * (Node and edge both): keep node-only code out of rosefn.config.js.
 * `onServe`/`onShutdown` are the exception - the CLI loads the config in
 * the worker process itself, so a pool or a redis client may live there.
 */
export interface Plugin {
  name: string;
  transform?(code: string, filePath: string): string | Promise<string>;
  /** Before routing and middleware. Return a Response to short-circuit (auth wall, rate limit, maintenance page). */
  onRequest?(ctx: RequestHookContext): Response | void | Promise<Response | void>;
  /** After the response exists, before it is sent. Return a Response to replace it. */
  onResponse?(ctx: RequestHookContext, res: Response): Response | void | Promise<Response | void>;
  /** Worker start: open a connection pool, warm a cache, install a cross-machine store driver. */
  onServe?(meta: { port: number; workers: number; store: StoreBridge }): void | Promise<void>;
  /** Worker drain, before exit: close the pool. */
  onShutdown?(): void | Promise<void>;
}

/**
 * The i18n half of rosefn.config.js - a named export beside the
 * plugins:
 *
 *   export const i18n = { preload: ['en', 'zh'] };
 *
 * `preload` lists the locales baked into the CLIENT bundle. The default is
 * every locale: a language switch then costs zero requests, which is the
 * one-request bet taken to its conclusion. An app with many languages lists
 * the ones it wants inline; the rest are written to dist/locales/<lang>.json
 * and fetched on first use (ensureLocale in the runtime). The SERVER bundle
 * always carries every locale - it renders any language on demand, and its
 * size is nobody's hot path.
 */
export interface I18nConfig {
  preload?: string[];
}

export interface RosefnConfig {
  plugins: Plugin[];
  i18n: I18nConfig;
}

/**
 * Plugins live in `<root>/rosefn.config.js` as the default export: an array
 * of `{ name, transform, onRequest, onResponse, onServe, onShutdown }`.
 * `transform` runs over each component's raw source (template + script +
 * style, before any parsing) at build time; the runtime hooks are bundled
 * into dist/server.js by build() below. trade-off: transform alone covers
 * macros, custom syntax, includes and auto-imports - a transform can rewrite
 * anything, including the script block; the request/serve hooks cover auth,
 * logging and lifecycle, which no source rewrite can express. The import is
 * cache-busted per build so a config edit takes effect on the dev server's
 * next rebuild, and a missing file is simply "no config" (existence is
 * checked first, so a config with a syntax error still fails loudly).
 * One import, one evaluation: the i18n options ride in the same module.
 */
export async function loadConfig(root: string): Promise<RosefnConfig> {
  const file = path.join(root, 'rosefn.config.js');
  if (!fs.existsSync(file)) return { plugins: [], i18n: {} };
  const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  return {
    plugins: (mod.default as Plugin[] | undefined) ?? [],
    i18n: (mod.i18n as I18nConfig | undefined) ?? {},
  };
}

/** The plugins alone (the serve command's lifecycle hooks). */
export async function loadPlugins(root: string): Promise<Plugin[]> {
  return (await loadConfig(root)).plugins;
}

/**
 * The module registry the build hands every compileComponent call.
 * Maps a resolved .rose file to its module index and scope key, so an
 * `import Card from '../components/Card.rose'` can be rewritten to the
 * compiled module in BOTH bundles (the specifier differs per bundle, the
 * index does not). One map, built once per build from the full file list -
 * a component may import a component, so the graph is resolved before any
 * compilation starts.
 *
 * `slots` is the child's slot declaration (`<slot name="row" item={post}>`),
 * pre-scanned from its template: the parent needs the names the child passes
 * INTO a slot to resolve them in the slot content it writes, and compilation
 * order cannot guarantee the child is compiled first.
 */
export type RoseRegistry = Map<string, { index: number; scopeKey: string; slots: Array<{ name: string; props: string[] }> }>;

/**
 * Resolve every `.rose` import in a script against the registry. Returns the
 * rewritten script plus the (local name, specifier, index) triples, so the
 * generators can emit the right module path per bundle. An unresolvable
 * specifier fails the build naming the file and the import - a typo'd
 * component path must not silently ship a broken bundle.
 */
function resolveRoseImports(script: string, fromFile: string, registry: RoseRegistry): { script: string; imports: Array<{ name: string; specifier: string; index: number }> } {
  const imports: Array<{ name: string; specifier: string; index: number }> = [];
  const resolve = (spec: string, at: number): { index: number; scopeKey: string } => {
    const abs = path.resolve(path.dirname(fromFile), spec);
    const hit = registry.get(abs);
    if (!hit) {
      throw new RoseError(
        'E-IMPORT',
        `${path.basename(fromFile)}: cannot import '${spec}' - no .rose file at ${abs}. A component lives under src/components/ (or src/pages/) and is imported by relative path.`,
        {
          file: fromFile,
          line: lineOf(script, at),
          hint: `create ${abs} (a .rose component) or fix the import path - a .rose import resolves to a file, never to a package`,
        },
      );
    }
    return hit;
  };
  let rewritten = script.replace(/import\s+(\w+)\s+from\s*(['"])([^'"]+\.rose)\2/g, (whole, name, q, spec, at: number) => {
    const hit = resolve(spec, at);
    imports.push({ name, specifier: spec, index: hit.index });
    return `import { render as ${name} } from ${q}__rose_${hit.index}__${q}`;
  });
  rewritten = rewritten.replace(/import\s*(\{[^}]*\})\s+from\s*(['"])([^'"]+\.rose)\2/g, (whole, clause, q, spec, at: number) => {
    const hit = resolve(spec, at);
    const alias = /\bas\s+(\w+)/.exec(clause)?.[1] ?? 'render';
    imports.push({ name: alias, specifier: spec, index: hit.index });
    return `import ${clause} from ${q}__rose_${hit.index}__${q}`;
  });
  return { script: rewritten, imports };
}

/**
 * Rewrite the `__rose_N__` placeholders to this bundle's module paths. Both
 * bundles are generated from the same resolved script, so one placeholder
 * resolves to two different files - the only per-bundle difference in the
 * whole component pipeline.
 */
function rewriteRoseImports(script: string, kind: 'ssr' | 'client'): string {
  return script.replace(/from\s*(['"])__rose_(\d+)__\1/g, (_, q, n) => `from ${q}./comp-${n}.${kind}.js${q}`);
}

/**
 * The specifiers that can never reach a browser
 * bundle. Node builtins by prefix, plus the database drivers the docs tell
 * you to use - the packages a rosefn app reaches for on the server and
 * nowhere else.
 *
 * Trade-off: a specifier list, not a resolver. A package that merely LOOKS
 * server-side but bundles fine for the browser still builds (nothing is
 * lost); the list only has to catch what esbuild's browser platform would
 * refuse anyway, which is what turns a cryptic failure into a clear one.
 */
const NODE_ONLY_SPEC = /^(?:node:|(?:fs|path|os|crypto|http|https|net|tls|stream|child_process|worker_threads|dns|cluster|better-sqlite3|sqlite3|pg|mysql2|mongodb|redis|ioredis)$)/;

/** The node-only specifiers among a module's hoisted imports (type imports excluded: esbuild erases them). */
function nodeOnlyImports(importStmts: string): string[] {
  const out: string[] = [];
  for (const m of importStmts.matchAll(/import\s+(type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) continue;
    if (NODE_ONLY_SPEC.test(m[2])) out.push(m[2]);
  }
  return out;
}

/**
 * `on:event={fn}` -> `data-on-event="fn"`, plus the handler registry entries
 * the client module needs. One pass, two outputs, so the attribute and the
 * registry can never disagree.
 *
 * Brace-aware on purpose: a flat `on:(\w+)=\{([^}]+)\}` stopped at the FIRST
 * `}`, so an inline arrow (`on:click={() => $setState('n', n() + 1)}`) was
 * truncated at its own closing brace - which emitted
 * `Object.assign(handlers, { () => ... })` (a syntax error in the generated
 * module) and left a stray `}` in the markup. The scan below balances braces
 * and skips string and template literals, exactly like templateExprSpans.
 *
 * A handler that names a server action becomes `data-on-event="$action:name"`
 * and never reaches the client registry (the body is server-only). An inline
 * handler gets a synthetic name (`__hN`) and rides the registry as
 * `__hN: <expr>`: the registry statement is emitted inside render(), after
 * the state declarations, so the arrow closes over the same `count()`/`setN`
 * the rest of the page uses.
 */
function wireEventBindings(template: string, actionNames: Set<string>): {
  template: string;
  bindings: Array<{ event: string; fn: string }>;
} {
  const bindings: Array<{ event: string; fn: string }> = [];
  let out = '';
  let rest = template;
  for (;;) {
    const m = /\bon:(\w+)\s*=\s*\{/.exec(rest);
    if (!m) {
      out += rest;
      break;
    }
    out += rest.slice(0, m.index);
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < rest.length) {
      const ch = rest[i];
      if (ch === '"' || ch === "'") {
        i = skipQuoted(rest, i);
        continue;
      }
      if (ch === '`') {
        i = skipTemplate(rest, i);
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    const expr = rest.slice(m.index + m[0].length, i).trim();
    if (actionNames.has(expr)) {
      out += `data-on-${m[1]}="$action:${expr}"`;
    } else if (/^\w+$/.test(expr)) {
      out += `data-on-${m[1]}="${expr}"`;
      bindings.push({ event: m[1], fn: expr });
    } else {
      const name = `__h${bindings.length}`;
      out += `data-on-${m[1]}="${name}"`;
      bindings.push({ event: m[1], fn: `${name}: ${expr}` });
    }
    rest = rest.slice(i + 1);
  }
  return { template: out, bindings };
}

/**
 * Pre-scan a file's template for its slot declarations -
 * `<slot name="row" item={post}>` -> { name: 'row', props: ['item'] }.
 * Cheap regex on purpose: the parent's compiler needs the names the child
 * passes INTO a slot, before (and independently of) compiling the child.
 */
function scanSlotDecls(filePath: string): Array<{ name: string; props: string[] }> {
  let src: string;
  try {
    src = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const noScript = src.replace(COMPONENT_RE, '');
  const noBlocks = noScript.replace(STYLE_RE, '');
  const tpl = noBlocks.match(TEMPLATE_RE)?.[1] ?? noBlocks.replace(HEAD_RE, '').trim();
  const out: Array<{ name: string; props: string[] }> = [];
  for (const m of tpl.matchAll(/<slot\s+([^>]*?)\/?>/g)) {
    const name = /\bname\s*=\s*["'](\w+)["']/.exec(m[1]);
    if (!name) continue;
    const props = [...m[1].matchAll(/\b(\w+)\s*=\s*\{/g)].map((x) => x[1]).filter((n) => n !== 'name');
    out.push({ name: name[1], props });
  }
  return out;
}

/**
 * Lift `import` statements out of a script block to module scope. The
 * script body is embedded inside render(), where an import declaration is a
 * syntax error - and a component import is exactly what a page/component
 * script now carries. Line-based on purpose: multi-line imports are tracked
 * by brace/paren depth and end at their `from '...'` clause.
 */
function hoistImports(script: string): { imports: string; rest: string } {
  const imports: string[] = [];
  const rest: string[] = [];
  let buf: string[] | null = null;
  let depth = 0;
  const done = (line: string) => depth <= 0 && /from\s*['"][^'"]+['"]\s*;?\s*$/.test(line);
  for (const line of script.split('\n')) {
    if (buf) {
      buf.push(line);
      for (const ch of line) {
        if (ch === '{' || ch === '(') depth++;
        else if (ch === '}' || ch === ')') depth--;
      }
      if (done(line)) {
        imports.push(buf.join('\n'));
        buf = null;
      }
      continue;
    }
    if (/^\s*import\b/.test(line)) {
      buf = [line];
      depth = 0;
      for (const ch of line) {
        if (ch === '{' || ch === '(') depth++;
        else if (ch === '}' || ch === ')') depth--;
      }
      if (done(line)) {
        imports.push(line);
        buf = null;
      }
      continue;
    }
    rest.push(line);
  }
  if (buf) imports.push(buf.join('\n'));
  return { imports: imports.join('\n'), rest: rest.join('\n') };
}

export async function compileComponent(filePath: string, publicDir: string, scopeKey: string, isApi = false, plugins: Plugin[] = [], registry: RoseRegistry = new Map()): Promise<CompileResult> {
  let source = await fs.promises.readFile(filePath, 'utf-8');
  for (const p of plugins) {
    if (!p.transform) continue;
    try {
      source = await p.transform(source, filePath);
    } catch (err) {
      throw new RoseError(
        'E-PLUGIN',
        `plugin ${p.name} failed on ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`,
        { file: filePath, hint: 'the error above came from inside the plugin - fix its transform() (or remove the plugin from rosefn.config.js)' },
      );
    }
  }

  if (isApi) {
    const scriptMatch = source.match(COMPONENT_RE);
    const rawScript = scriptMatch?.[1] ?? '';
    const apiMethods = [...rawScript.matchAll(/(?:^|\n)\s*export\s+(?:async\s+)?function\s+(\w+)\s*\(/g)]
      .map((m) => m[1])
      .filter((name) => HTTP_METHODS.has(name));
    const usesContext = /getContext\s*\(/.test(rawScript);
    const hasPrerender = !usesContext && /(?:^|\n)\s*export\s+(?:const|let|var)\s+prerender\s*=\s*true\b/.test(rawScript);
    const hoisted = hoistImports(resolveRoseImports(rawScript, filePath, registry).script);
    const ownRuntimeImports = new Set(
      [...rawScript.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/runtime\.js['"]/g)]
        .flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean))
    );
    const helpers = API_RUNTIME_HELPERS.filter((n) => !ownRuntimeImports.has(n));
    const runtimeImport = helpers.length > 0 ? `import { ${helpers.join(', ')} } from './runtime.js';\n` : '';
    return {
      ssr: '',
      client: '',
      stateKeys: [],
      actionNames: [],
      guardName: null,
      style: '',
      hasParams: false,
      api: `${runtimeImport}${rewriteRoseImports(`${hoisted.imports}\n${hoisted.rest}`, 'ssr').trim()}`,
      apiMethods,
      hasPrerender,
      usesContext,
    };
  }

  const sourceNoScript = source.replace(COMPONENT_RE, '');
  const sourceNoHead = sourceNoScript.replace(HEAD_RE, '');
  const styleMatch = sourceNoHead.match(STYLE_RE);
  const scopedStyle = styleMatch?.[1] ? scopeCss(styleMatch[1], scopeKey) : '';
  const sourceNoBlocks = sourceNoHead.replace(STYLE_RE, '');

  const scriptMatch = source.match(COMPONENT_RE);
  const roseResolved = resolveRoseImports(scriptMatch?.[1] ?? '', filePath, registry);
  const rawScript = roseResolved.script;
  const roseImports = roseResolved.imports;
  const { imports: importStmts, rest: scriptNoImports } = hoistImports(rawScript);
  if (path.basename(filePath) !== '_middleware.rose') {
    for (const spec of nodeOnlyImports(importStmts)) {
      const at = importStmts.indexOf(spec);
      throw new RoseError(
        'E-NODE-ONLY',
        `${filePath}: cannot import '${spec}' in a page or component - it never reaches the browser. ` +
        `This module's script ships to the client (its $data bodies included), so move the import to ` +
        `src/pages/_middleware.rose or a pages/api/*.rose handler: those are server-only, and the rows ` +
        `travel to the page through getContext() / $data.`,
        {
          file: filePath,
          line: at >= 0 ? lineOf(importStmts, at) : undefined,
          hint: `'${spec}' is a server-only module: import it inside src/pages/_middleware.rose (or a pages/api/*.rose handler) instead - a page/component script ships to the browser`,
        },
      );
    }
  }
  const isComponent = registry.get(filePath)?.scopeKey.startsWith('components/') ?? false;
  if (isComponent && /\$data\s*\(/.test(rawScript)) {
    throw new RoseError(
      'E-EXPORT',
      `${filePath}: $data() is not allowed in a component - an imported component renders synchronously inside its parent. ` +
      `Fetch in the page's $data (or pages/_middleware.rose) and pass the value down as a prop: <Card user={user()}>.`,
      { file: filePath, hint: 'move the fetch to the page (or the middleware) and pass the value down as a prop' },
    );
  }
  const usesContext = /getContext\s*\(/.test(rawScript) || /\$store\s*\(/.test(rawScript) || /\$query\s*\(/.test(rawScript);
  const hasParams = /(?:^|\n)\s*export\s+(?:(?:const|let|var)\s+|(?:async\s+)?function\s+)params\b/.test(rawScript);
  const revalidateMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+revalidate\s*=\s*(\d+)\s*;?/);
  const revalidate = revalidateMatch ? Number(revalidateMatch[1]) : undefined;
  const prefetchMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+prefetch\s*=\s*['"`](\w+)['"`]\s*;?/);
  const prefetch = prefetchMatch ? prefetchMatch[1] : undefined;
  if (prefetch && !['off', 'hover', 'viewport', 'all'].includes(prefetch)) {
    throw new RoseError(
      'E-EXPORT',
      `${filePath}: export const prefetch must be 'off', 'hover', 'viewport' or 'all'`,
      { file: filePath, line: lineAt(rawScript, prefetchMatch), hint: "prefetch is the app-global link strategy, declared once in the root _layout.rose: 'off' | 'hover' (default) | 'viewport' | 'all'" },
    );
  }
  const vitalsMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+vitals\s*=\s*([^;\n]+)\s*;?/);
  const vitals = vitalsMatch ? vitalsMatch[1].trim() === 'true' : undefined;
  if (vitalsMatch && !vitals) {
    throw new RoseError(
      'E-EXPORT',
      `${filePath}: export const vitals must be true (or be absent - the hook ships only when an app asks for it)`,
      { file: filePath, line: lineAt(rawScript, vitalsMatch), hint: 'omit the export entirely, or set it to exactly true - the web-vitals hook is opt-in per app' },
    );
  }
  const bundleMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+bundle\s*=\s*['"`](\w+)['"`]\s*;?/);
  const bundle = bundleMatch ? bundleMatch[1] : undefined;
  if (bundle && !['inline', 'split'].includes(bundle)) {
    throw new RoseError(
      'E-EXPORT',
      `${filePath}: export const bundle must be 'inline' or 'split'`,
      { file: filePath, line: lineAt(rawScript, bundleMatch), hint: "'inline' (default) is the single-document mode; 'split' is mode B for large apps - route-level chunks, loaded on demand" },
    );
  }
  const csrMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+csr\s*=\s*(true|false)\s*;?/);
  const csr: boolean | undefined = csrMatch ? csrMatch[1] !== 'false' : undefined;
  const bufferMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+buffer\s*=\s*(true|false)\s*;?/);
  const buffer: boolean | undefined = bufferMatch ? bufferMatch[1] !== 'false' : undefined;
  if (csr === false) {
    const dead = /\son:[a-z]+\s*=/.exec(source) ?? /\b(?:onMount|onCleanup|refresh)\s*\(/.exec(rawScript);
    if (dead) {
      const deadSrc = dead === (/\son:[a-z]+\s*=/.exec(source) ?? undefined) ? source : rawScript;
      throw new RoseError(
        'E-EXPORT',
        `${filePath}: csr = false cannot ship ${dead[0].trim()} - event wiring, onMount/onCleanup and refresh() all need the client bundle. ` +
        `(Forms still work without JS: a native POST runs the server action.)`,
        {
          file: filePath,
          line: lineAt(deadSrc, dead),
          hint: 'drop csr = false (let the compiler decide), or remove the client-only code - a native <form method="POST"> server action works without the bundle',
        },
      );
    }
  }

  let headers: Record<string, string> | undefined;
  const headersLiteral = extractObjectLiteral(rawScript, 'headers');
  if (headersLiteral) {
    let value: unknown;
    try {
      value = new Function(`return ${headersLiteral}`)();
    } catch {
      throw new RoseError(
        'E-EXPORT',
        `${filePath}: export const headers must be an object literal`,
        { file: filePath, hint: "write it as one literal: export const headers = { 'x-robots-tag': 'noindex' }" },
      );
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value as object).some((v) => typeof v !== 'string')) {
      throw new RoseError(
        'E-EXPORT',
        `${filePath}: export const headers must be a flat map of string -> string`,
        { file: filePath, hint: 'every value must be a string literal (a number or an array fails here instead of shipping verbatim)' },
      );
    }
    headers = value as Record<string, string>;
  }

  let cspNonce: boolean | undefined;
  const cspLiteral = extractObjectLiteral(rawScript, 'csp');
  if (cspLiteral) {
    let value: unknown;
    try {
      value = new Function(`return ${cspLiteral}`)();
    } catch {
      throw new RoseError(
        'E-EXPORT',
        `${filePath}: export const csp must be an object literal`,
        { file: filePath, hint: 'write it as one literal: export const csp = { nonce: true }' },
      );
    }
    const nonce = (value as { nonce?: unknown } | null)?.nonce;
    if (nonce !== undefined && typeof nonce !== 'boolean') {
      throw new RoseError(
        'E-EXPORT',
        `${filePath}: csp.nonce must be a boolean`,
        { file: filePath, hint: 'csp.nonce is a switch: true (per-request nonce, the route becomes dynamic) or absent (the default hashed policy)' },
      );
    }
    cspNonce = nonce === true;
  }

  const { clean: scriptNoExports, exports: exportStmts, actions, props, guard } = extractExports(scriptNoImports);
  const script = scriptNoExports;
  const actionNames = new Set(actions.map((a) => a.name));

  const clientReasons: string[] = [];
  if (/\son:[a-z]+\s*=/.test(source)) clientReasons.push('event wiring (on:)');
  if (/<form[^>]*\son:[a-z]+\s*=/i.test(source) || /\$action:|data-on-/.test(source)) {
    clientReasons.push('a form bound to a client dispatch ($action)');
  }
  const lifecycle = rawScript.match(/\b(?:onMount|onCleanup|refresh|adopt|\$action|\$setState)\s*\(/);
  if (lifecycle) clientReasons.push(`${lifecycle[0].replace(/\s*\($/, '')}()`);
  const needsClient = clientReasons.length > 0;

  const jsWarnings: string[] = [];
  if (!needsClient) {
    const codeOnly = stripComments(source);
    const scriptCodeOnly = stripComments(rawScript);
    if (/\son[a-z]+\s*=\s*["'][^"']*["']/i.test(codeOnly)) {
      jsWarnings.push('an inline on* attribute (e.g. onclick="...") - it cannot fire without the bundle; use on:click or set csr = true');
    }
    if (/javascript:/i.test(codeOnly)) {
      jsWarnings.push('a javascript: URL - it needs the bundle to run; link to a real route');
    }
    if (/\b(?:eval|new Function)\s*\(/.test(scriptCodeOnly)) {
      jsWarnings.push('eval()/new Function() - client code the predicate cannot see');
    }
    if (/\b(?:document|window|localStorage|sessionStorage)\s*\.|\b(?:add|remove)EventListener\s*\(|\brequestAnimationFrame\s*\(|\bMutationObserver\b|\bnavigator\s*\.|\blocation\s*\.\s*(?:href|assign|replace|reload|pathname|search|hash|origin)\b|\b(?:setTimeout|setInterval)\s*\(/.test(scriptCodeOnly)) {
      jsWarnings.push('browser-only code (document./window./addEventListener/a timer/...) - a JS-free document never ships this script to the browser, so it throws on the server or runs there and never reaches the client; if the route needs the browser, set csr = true');
    }
  }

  const templateMatch = sourceNoBlocks.match(TEMPLATE_RE);
  const headContent = sourceNoScript.match(HEAD_RE)?.[1] ?? '';
  const rawTemplate = templateMatch
    ? templateMatch[1]
    : sourceNoBlocks.replace(COMPONENT_RE, '').trim();
  const template = scopedStyle
    ? injectScopeAttr(inlineImages(rawTemplate, publicDir), scopeKey)
    : inlineImages(rawTemplate, publicDir);

  const decls = extractDecls(script);
  const stateDecls = decls.filter((d) => d.kind === 'state');

  const setterNames = new Map<string, string>();
  stateDecls.forEach((s) => setterNames.set(s.name, `set${capitalize(s.name)}`));

  const declCode = (d: (typeof decls)[number]): string => {
    const key = isComponent ? `${scopeKey}:${d.name}` : d.name;
    if (d.kind === 'state') {
      return `const [${d.name}, ${setterNames.get(d.name)!}] = state(${JSON.stringify(key)}, ${d.expr});`;
    }
    const isFn = d.expr.includes('=>') || d.expr.startsWith('function');
    const fn = isFn ? d.expr : `() => (${d.expr})`;
    return `const __had_${d.name} = hasState(${JSON.stringify(key)});
const [${d.name}, set${capitalize(d.name)}] = state(${JSON.stringify(key)}, null);
if (!__had_${d.name}) set${capitalize(d.name)}(await $data(${fn}));`;
  };

  const nestedDecls: (typeof decls)[number][] = [];
  let spliced = '';
  let pos = 0;
  decls.forEach((d, i) => {
    const top = braceDepthAt(script, d.start) === 0;
    if (!top) nestedDecls.push(d);
    spliced += script.slice(pos, d.start) + (top ? `'__rvdecl${i}__';` : '');
    pos = d.end;
  });
  spliced += script.slice(pos);

  let cleanScript = spliced.replace(SETSTATE_RE, (_, key, val) => {
    const trimmedKey = key.trim().replace(/^['"`]|['"`]$/g, '');
    const setter = setterNames.get(trimmedKey) || `set${capitalize(trimmedKey)}`;
    return `${setter}(${val})`;
  });
  cleanScript = callifyStateReads(cleanScript, stateDecls.map((s) => s.name));
  cleanScript = cleanScript.replace(/'__rvdecl(\d+)__';/g, (_m, i) => declCode(decls[Number(i)]));

  const stateDeclsCode = nestedDecls.filter((d) => d.kind === 'state').map(declCode).join('\n');
  const dataDeclsCode = nestedDecls.filter((d) => d.kind === 'data').map(declCode).join('\n');

  const templateCalled = callifyTemplateExprs(template, stateDecls.map((s) => s.name));
  const wired = wireEventBindings(templateCalled, actionNames);
  const eventBindings = wired.bindings;

  const ssrTemplate = wired.template
    .replace(SLOT_NAMED_RE, (_w, attrs) => `{__slot(${encodeSlotCall(attrs)})}`)
    .replace(SLOT_RE, '{__slot__}');

  const stateKeys = decls.map((d) => d.name);

  const comps = new Map(roseImports.map((r) => {
    const abs = path.resolve(path.dirname(filePath), r.specifier);
    const hit = registry.get(abs)!;
    return [r.name, { index: hit.index, slots: hit.slots }] as const;
  }));
  const compiledTemplate = compileTemplate(ssrTemplate, 'h', '__c', null, 0, true, comps);
  const compiledHead = headContent.trim() ? compileHead(headContent) : '';
  const hasNamedSlots = /<slot\s+[^>]*\bname\s*=/.test(template);

  const ssrExports = actions.length > 0 ? `${exportStmts}\n${actions.map((a) => a.stmt).join('\n')}` : exportStmts;
  const ssrGuard = guard ? `\n${guard}` : '';
  const isMiddleware = path.basename(filePath) === '_middleware.rose';
  const ssr = isMiddleware
    ? `${RUNTIME_IMPORTS}\n\n${importStmts}\n\n${ssrExports}\n${ssrGuard}\n\n${cleanScript}\n`
    : generateSSR(cleanScript, compiledTemplate, stateDeclsCode, ssrExports, compiledHead, props, hasNamedSlots, importStmts, isComponent, ssrGuard, actions.length > 0, dataDeclsCode);
  const client = generateClient(cleanScript, compiledTemplate, stateDeclsCode, eventBindings, exportStmts, compiledHead, props, hasNamedSlots, importStmts, isComponent, dataDeclsCode);

  return {
    ssr: rewriteRoseImports(ssr, 'ssr'),
    client: rewriteRoseImports(client, 'client'),
    stateKeys,
    actionNames: [...actionNames],
    guardName: guard ? 'beforeAction' : null,
    style: scopedStyle,
    hasParams,
    usesContext,
    revalidate,
    csr,
    buffer,
    prefetch,
    vitals,
    bundle,
    needsClient,
    clientReasons,
    jsWarnings,
    headers,
    cspNonce,
    props,
    roseImports,
    isComponent,
  };
}

/**
 * Collapse a declaration block's whitespace outside strings. Every byte of
 * component CSS ships inside every document, so the source's formatting is a
 * tax paid on every route; collapsing it is free - declarations are not
 * whitespace-sensitive, and quoted strings (content: "a  b") are left
 * untouched by the alternation.
 */
function minifyDecls(block: string): string {
  return block
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^"']+/g, (m) =>
      m[0] === '"' || m[0] === "'" ? m : m.replace(/\s+/g, ' ').replace(/\s*([:;{},])\s*/g, '$1').trim()
    )
    .trim();
}

/**
 * Scope a component's CSS to its own subtree: every selector is prefixed
 * with the component's scope attribute, recursing into @media/@supports.
 * Trade-off: no full CSS parser - comma lists only, and @keyframes blocks
 * pass through unscoped (their from/to/to selectors are not selectors).
 * Global element rules (:root/html/body) belong in the shell's STYLES.
 */
function scopeCss(css: string, key: string): string {
  const attr = `[data-rosefn-c="${key}"]`;
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '';
  let prelude = '';
  let i = 0;
  while (i < clean.length) {
    const ch = clean[i];
    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < clean.length && depth > 0) {
        if (clean[j] === '{') depth++;
        else if (clean[j] === '}') depth--;
        j++;
      }
      const block = clean.slice(i + 1, j - 1);
      const sel = prelude.trim();
      if (sel.startsWith('@')) {
        out += `${sel}{${/^@(?:-[\w]+-)?keyframes/.test(sel) ? minifyDecls(block) : scopeCss(block, key)}}`;
      } else if (sel) {
        const scoped = sel.split(',').map((s) => `${attr} ${s.trim()}`).join(',');
        out += `${scoped}{${minifyDecls(block)}}`;
      }
      prelude = '';
      i = j;
      continue;
    }
    if (ch !== '}' && ch !== '\n' && ch !== '\r') prelude += ch;
    else if (ch === '}') prelude = '';
    i++;
  }
  return out.trim();
}

/**
 * Add the scope attribute to every top-level element of a template. Tag
 * depth is tracked with quoted-attribute awareness, so elements inside a
 * top-level {#if}/{#each} block are top-level at render time and get it too.
 */
function injectScopeAttr(template: string, key: string): string {
  const attr = ` data-rosefn-c="${key}"`;
  let out = '';
  let depth = 0;
  let i = 0;
  while (i < template.length) {
    const lt = template.indexOf('<', i);
    if (lt === -1) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, lt);
    let j = lt + 1;
    let quote = '';
    while (j < template.length) {
      const c = template[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    const tagText = template.slice(lt, j + 1);
    const closing = /^<\//.test(tagText);
    const nameMatch = tagText.match(/^<\/?([a-zA-Z][\w-]*)/);
    const selfClosing = /\/>$/.test(tagText) || (nameMatch && VOID_TAGS.has(nameMatch[1].toLowerCase()));
    if (nameMatch && !closing && depth === 0 && !selfClosing) {
      const injectAt = tagText.endsWith('/>') ? tagText.length - 2 : tagText.length - 1;
      out += tagText.slice(0, injectAt) + attr + tagText.slice(injectAt);
      depth++;
    } else {
      out += tagText;
      if (nameMatch) depth += closing ? -1 : selfClosing ? 0 : 1;
    }
    i = j + 1;
  }
  return out;
}

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'wbr']);

const EXPORT_RE = /^[ \t]*export\s+(?:(const|let|var)|(?:async\s+)?function)\s+(\w+)/gm;

/**
 * Lift top-level `export const/let/var/function` statements out of the script
 * body. They must be self-contained (no references to state or template
 * scope) - they exist for build-time consumers like dynamic-route `params`.
 *
 * Every exported ASYNC function is a SERVER-ONLY action (server-action semantics:
 * `export const params` and sync helpers stay shared, async exports are
 * server code). `action` is the conventional name a <form method="POST">
 * posts to; any other name is reachable from an event handler
 * (`on:click={like}` compiles to `$action('like')`) or a hidden form field.
 * Action bodies reach the SSR module but NEVER the client bundle.
 */
/**
 * Extract an exported object literal (`export const headers = { ... }`) by
 * name, with a balanced-brace scan so nested values survive the capture.
 * Returns the raw literal text, or null when the export is absent.
 */
function extractObjectLiteral(script: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\n)\\s*export\\s+(?:const|let|var)\\s+${name}\\s*=\\s*`).exec(script);
  if (!m) return null;
  let i = m.index + m[0].length;
  if (script[i] !== '{') return null;
  const start = i;
  let depth = 0;
  for (; i < script.length; i++) {
    const ch = script[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return script.slice(start, i);
}

export function extractExports(script: string): { clean: string; exports: string; actions: Array<{ name: string; stmt: string }>; props: Array<{ name: string; def: string | null }>; guard: string } {
  const stmts: string[] = [];
  const actions: Array<{ name: string; stmt: string }> = [];
  const props: Array<{ name: string; def: string | null }> = [];
  const guards: string[] = [];
  let out = '';
  let pos = 0;
  let m: RegExpExecArray | null;
  EXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_RE.exec(script))) {
    const kind = m[1];
    const start = m.index + m[0].indexOf('export');
    let i = start + m[0].length - m[0].indexOf('export');
    if (kind) {
      let depth = 0;
      while (i < script.length) {
        const ch = script[i];
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        } else if (depth === 0 && ch === ';') {
          i++;
          break;
        } else if (depth === 0 && ch === '\n') {
          const rest = script.slice(i + 1);
          if (!/^\s*[.([{+\-*/?:,=&|]/.test(rest)) {
            i++;
            break;
          }
        }
        i++;
      }
      if (script[i] === ';') i++;
    } else {
      while (i < script.length && script[i] !== '{') i++;
      let depth = 0;
      while (i < script.length) {
        const ch = script[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        i++;
      }
    }
    out += script.slice(pos, start);
    const stmt = script.slice(start, i).trim();
    const asyncFn = stmt.match(/^export\s+async\s+function\s+(\w+)/);
    const anyFn = stmt.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
    if (anyFn?.[1] === 'beforeAction') {
      guards.push(stmt);
    } else if (asyncFn) {
      actions.push({ name: asyncFn[1], stmt });
    } else if (kind === 'let') {
      const pm = stmt.match(/^export\s+let\s+(\w+)\s*(?:=\s*([\s\S]*?))?\s*;?$/);
      if (pm) props.push({ name: pm[1], def: pm[2]?.trim() ?? null });
      else stmts.push(stmt);
    } else {
      stmts.push(stmt);
    }
    pos = i;
  }
  out += script.slice(pos);
  return { clean: out, exports: stmts.join('\n'), actions, props, guard: guards.join('\n') };
}

function extractDecls(script: string): Decl[] {
  const decls: Decl[] = [];
  DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DECL_RE.exec(script))) {
    let j = m.index + m[0].length;
    const skipSpace = () => { while (j < script.length && /\s/.test(script[j])) j++; };
    skipSpace();
    if (script[j] === '<') {
      let depth = 0;
      while (j < script.length) {
        const ch = script[j];
        if (ch === '<') depth++;
        else if (ch === '>' && script[j - 1] !== '=') {
          depth--;
          if (depth === 0) { j++; break; }
        } else if (ch === '=' && script[j + 1] === '>') j++;
        j++;
      }
      skipSpace();
    }
    if (script[j] !== '(') continue;
    const open = j + 1;
    let depth = 1;
    let i = open;
    while (i < script.length && depth > 0) {
      const ch = script[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    let end = i;
    const cast = DECL_CAST_RE.exec(script.slice(i));
    if (cast) end = i + cast[0].length;
    if (script[end] === ';') end++;
    decls.push({
      name: m[1],
      kind: m[2] as 'state' | 'data',
      expr: script.slice(open, i - 1).trim(),
      start: m.index,
      end,
    });
  }
  return decls;
}

/**
 * Brace depth at `index`, with strings, template literals and comments
 * skipped so their braces never count. A declaration at depth 0 is a
 * top-level statement of the script: it may be replaced where it stands
 * (BUG.md 2026.9.22 - the TDZ fix). Anything deeper lives inside a function
 * body (an onMount callback) and must keep its scope.
 */
function braceDepthAt(src: string, index: number): number {
  let depth = 0;
  let i = 0;
  while (i < index) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < index) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          let d = 1;
          i += 2;
          while (i < index && d > 0) {
            if (src[i] === '{') d++;
            else if (src[i] === '}') d--;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close === -1 ? src.length : close + 2;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return depth;
}

/**
 * Compile a .rose template to statements that build an HTML string with
 * reactive markers, and push update closures into the shared `closes` array.
 *
 * Marker protocol (identical on server and client, so the client can adopt
 * the SSR DOM instead of re-rendering it):
 *   text:      <!--⟦m:K⟧-->value          wire() updates the following text node
 *   if block:  <!--⟦i:K⟧-->html<!--⟦/i:K⟧-->   wire() inserts/removes the block
 *   each list: <!--⟦l:K⟧-->items<!--⟦/l:K⟧-->  wire() rebuilds the list
 *   attr:      name="value" data-b="K:name"   wire() re-sets the attribute
 *
 * Text/attr values are HTML-escaped on the server; wire() writes raw values
 * because DOM text nodes and attributes are not HTML-parsed.
 *
 * `comps` maps an imported component's local name to its module index
 * and slot declarations. A `<Card title={x}>` tag compiles to a call of that
 * module's render() - the child pushes its markers into the SAME closes array
 * the parent is using, so one wire() pass covers the whole tree (the same
 * trick the layout chain already uses with children html).
 */

/**
 * Auto-call a BARE state read and nothing else. The callify pass has already
 * rewritten a bare name to `name()`, so what reaches here is that - or an
 * expression the developer wrote (a comparison, a member read, a call with
 * arguments). Appending () to THOSE is a crash the developer reads as a
 * framework bug: `{#if flash().name}` must not become `flash().name()`, and
 * `{#each rows.filter(ok) as row}` must not become `rows.filter(ok)()`.
 */
function autoCall(expr: string): string {
  const e = expr.trim();
  return /^[A-Za-z_$][\w$]*$/.test(e) ? `${e}()` : e;
}

/**
 * Find a `{#if ...}...{/if}`, `{#each ... as x}...{/each}` or
 * `{#boundary}...{/boundary}` block, NESTING-AWARE: the close tag that
 * ends the block is the one that BALANCES the opens inside it.
 *
 * A non-greedy regex cannot tell the two apart - it stops at the first
 * close tag, which is the INNER block's. The outer block then ends early,
 * its own close tag is left in the stream as prose, and the inner open
 * (now unclosed inside the truncated content) falls through to the
 * expression matcher and compiles to `(#if ...)` - the cryptic
 * "Unexpected #if" esbuild error. The scan below counts same-kind opens
 * as it walks, so an `{#if}` inside an `{#if}` (or an `{#each}` inside
 * an `{#each}`) is content, not a terminator.
 *
 * Returns a RegExpExecArray-shaped value (index + capture groups in the
 * same order the old regexes produced) so the call sites are unchanged.
 */
function findBlock(src: string, kind: 'if' | 'each' | 'boundary'): RegExpExecArray | null {
  const head = kind === 'boundary'
    ? /\{#boundary\}/g
    : kind === 'if'
      ? /\{#if\s+([^}]+)\}/g
      : /\{#each\s+([^}]+?)\s+as\s+(\w+)\}/g;
  const closeRe = new RegExp(`\\{/${kind}\\}`, 'g');
  let open: RegExpExecArray | null;
  while ((open = head.exec(src))) {
    const start = open.index;
    const afterOpen = start + open[0].length;
    let depth = 1;
    let i = afterOpen;
    for (;;) {
      head.lastIndex = i;
      closeRe.lastIndex = i;
      const nextOpen = head.exec(src);
      const nextClose = closeRe.exec(src);
      if (!nextClose) break;
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth++;
        i = nextOpen.index + nextOpen[0].length;
        continue;
      }
      i = nextClose.index + nextClose[0].length;
      if (--depth === 0) {
        const content = src.slice(afterOpen, nextClose.index);
        const groups = kind === 'boundary' ? [content] : kind === 'if' ? [open[1], content] : [open[1], open[2], content];
        const arr = [src.slice(start, i), ...groups] as unknown as RegExpExecArray;
        (arr as any).index = start;
        return arr;
      }
    }
    head.lastIndex = afterOpen;
  }
  return null;
}

/**
 * Compile a <head> block. Same template rules as the body - `{expr}` escapes,
 * `{#if}`/`{#each}`/`{@html}` all work - with two exceptions:
 *
 * - the interior of a `<style>`, `<script>` or `<noscript>` element is RAW
 *   TEXT, not template source. CSS braces are not rosefn expressions
 *   (`<style>.a { color: red }</style>` read as one giant `{...}` expression
 *   and broke the build the first time a route shipped a head-level style),
 *   and a `<script>`'s own syntax has the same problem.
 * - an HTML comment is a NOTE, not content: it is dropped. A note that
 *   mentions `<style>` ("ship a <style> here") must not be able to move where
 *   the stylesheet starts, and the server's head merge reads this output.
 *
 * Each markup segment compiles with its own depth so the block helper names
 * (`__b0_0`) can never collide inside the one head function they share.
 */
function compileHead(head: string): string {
  const RAW_OPEN = /<(style|script|noscript)\b[^>]*>/iy;
  let out = '';
  let buf = '';
  let seg = 0;
  let i = 0;
  const flush = () => {
    if (buf.trim()) out += compileTemplate(buf, '__hd', '__hc', null, seg++, false);
    buf = '';
  };
  while (i < head.length) {
    if (head.startsWith('<!--', i)) {
      const end = head.indexOf('-->', i + 4);
      i = end < 0 ? head.length : end + 3;
      continue;
    }
    RAW_OPEN.lastIndex = i;
    const open = RAW_OPEN.exec(head);
    if (open) {
      const tag = open[1].toLowerCase();
      const closeAt = head.toLowerCase().indexOf(`</${tag}`, i + open[0].length);
      const gt = closeAt < 0 ? -1 : head.indexOf('>', closeAt);
      const end = gt < 0 ? head.length : gt + 1;
      flush();
      out += emitChunk(head.slice(i, end), '__hd', '__hc', null);
      i = end;
      continue;
    }
    buf += head[i++];
  }
  flush();
  return out;
}

function compileTemplate(
  template: string,
  acc: string,
  closes: string,
  scope: string | null,
  depth: number,
  markers = true,
  comps: Map<string, { index: number; slots: Array<{ name: string; props: string[] }> }> = new Map()
): string {
  let result = '';
  let remaining = template;
  let blockId = 0;

  const nextId = () => `${depth}_${blockId++}`;

  while (remaining.length > 0) {
    const ifMatch = findBlock(remaining, 'if');
    const eachMatch = findBlock(remaining, 'each');
    const boundaryMatch = findBlock(remaining, 'boundary');
    const firstExpr = templateExprSpans(remaining)[0];
    const exprMatch = firstExpr
      ? Object.assign([remaining.slice(firstExpr.start, firstExpr.end + 1), firstExpr.expr], { index: firstExpr.start }) as unknown as RegExpExecArray
      : null;
    const compTag = comps.size > 0 ? findCompTag(remaining, comps) : null;

    const candidates: Array<{ type: string; match: RegExpExecArray; index: number; tag?: CompTag }> = [];
    if (ifMatch?.index !== undefined) candidates.push({ type: 'if', match: ifMatch, index: ifMatch.index });
    if (eachMatch?.index !== undefined) candidates.push({ type: 'each', match: eachMatch, index: eachMatch.index });
    if (boundaryMatch?.index !== undefined) candidates.push({ type: 'boundary', match: boundaryMatch, index: boundaryMatch.index });
    if (exprMatch?.index !== undefined) candidates.push({ type: 'expr', match: exprMatch, index: exprMatch.index });
    if (compTag) candidates.push({ type: 'comp', match: exprMatch!, index: compTag.start, tag: compTag });
    const earliest = candidates.length > 0
      ? candidates.reduce((a, b) => (a.index <= b.index ? a : b))
      : null;

    if (!earliest) {
      result += emitChunk(remaining, acc, closes, scope);
      break;
    }

    if (earliest.type === 'if') {
      const [, cond, content] = earliest.match;
      const before = remaining.substring(0, earliest.index);
      if (before) result += emitChunk(before, acc, closes, scope);
      const call = autoCall(cond);
      const id = nextId();
      const innerScope = scope ?? '__s';
      const inner = compileTemplate(content.trim(), 'h', '__c', innerScope, depth + 1, markers, comps);
      result += `const __b${id} = (__s, __c) => { let h = ''; ${inner} return h; };\n`;
      if (markers) {
        result += `${acc} += ifMark(${closes}, () => (${call}), __b${id}${scope ? `, ${scope}` : ''});\n`;
      } else {
        result += `${acc} += (${call}) ? __b${id}(${scope ?? 'undefined'}, []) : '';\n`;
      }
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    } else if (earliest.type === 'each') {
      const [, items, item, content] = earliest.match;
      const before = remaining.substring(0, earliest.index);
      if (before) result += emitChunk(before, acc, closes, scope);
      const call = autoCall(items);
      const id = nextId();
      const itemRe = new RegExp(`\\b${item}\\b`, 'g');
      let scoped = '';
      let lastSpan = 0;
      for (const s of templateExprSpans(content.trim())) {
        scoped += content.trim().slice(lastSpan, s.start) + '{' + s.expr.replace(itemRe, '__s') + '}';
        lastSpan = s.end + 1;
      }
      scoped += content.trim().slice(lastSpan);
      const inner = compileTemplate(scoped, 'h', '__c', '__s', depth + 1, markers, comps);
      result += `const __b${id} = (__s, __c) => { let h = ''; ${inner} return h; };\n`;
      if (markers) {
        result += `${acc} += eachMark(${closes}, () => (${call}), __b${id});\n`;
      } else {
        result += `${acc} += (${call}).map((${item}) => __b${id}(${item}, [])).join('');\n`;
      }
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    } else if (earliest.type === 'boundary') {
      const [, content] = earliest.match;
      const before = remaining.substring(0, earliest.index);
      if (before) result += emitChunk(before, acc, closes, scope);
      const id = nextId();
      const catchesAction = /\$action:|<form[\s>]/.test(content);
      const inner = compileTemplate(content.trim(), 'h', closes, scope, depth + 1, markers, comps);
      result += `const __b${id} = (__c) => { let h = ''; ${inner} return h; };\n`;
      result += `let __bd${id} = '';\n`;
      result += catchesAction
        ? `try { $actionErrorOrThrow(); __bd${id} = __b${id}(${closes}); } catch (e) { __bd${id} = $boundaryFallback(e); }\n`
        : `try { __bd${id} = __b${id}(${closes}); } catch { __bd${id} = ${JSON.stringify(BOUNDARY_FALLBACK)}; }\n`;
      result += `${acc} += __bd${id};\n`;
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    } else if (earliest.type === 'comp') {
      const tag = earliest.tag!;
      if (tag.start > 0) result += emitChunk(remaining.substring(0, tag.start), acc, closes, scope);
      const entry = comps.get(tag.name)!;
      const id = nextId();
      let childrenSrc = '';
      let rest: string;
      if (tag.selfClosing) {
        rest = remaining.substring(tag.end);
      } else {
        const closeIdx = findClose(remaining, tag.end, tag.name);
        if (closeIdx < 0) throw new RoseError('E-TEMPLATE', `unclosed <${tag.name}> - every component tag needs its matching close tag`, { hint: `add the matching </${tag.name}> (or close the tag with /> when it takes no children)` });
        childrenSrc = remaining.substring(tag.end, closeIdx);
        rest = remaining.substring(closeIdx + tag.name.length + 3);
      }
      const { def, named } = splitSlots(childrenSrc);
      const hasChildren = def.trim().length > 0;
      if (hasChildren) {
        result += `const __ch${id} = (__s, __c) => { let h = ''; ${compileTemplate(def, 'h', '__c', scope, depth + 1, markers, comps)} return h; };\n`;
      }
      const slotFns = named.map(([nm, src]) => {
        const decl = entry.slots.find((s) => s.name === nm);
        let content = src;
        for (const p of decl?.props ?? []) {
          const pRe = new RegExp(`\\b${p}\\b`, 'g');
          let out = '';
          let lastSpan = 0;
          for (const s of templateExprSpans(content)) {
            out += content.slice(lastSpan, s.start) + '{' + s.expr.replace(pRe, `__s.${p}`) + '}';
            lastSpan = s.end + 1;
          }
          content = out + content.slice(lastSpan);
        }
        return `${JSON.stringify(nm)}: (__s, __c) => { let h = ''; ${compileTemplate(content, 'h', '__c', '__s', depth + 1, markers, comps)} return h; }`;
      });
      const propsObj = parseCompAttrs(tag.attrs)
        .filter((a) => a.name !== 'slot')
        .map((a) => {
          const key = a.name.startsWith('on:') ? `on${capitalize(a.name.slice(3))}` : a.name;
          const val = a.kind === 'expr' ? `(${a.value})` : a.kind === 'str' ? JSON.stringify(a.value) : 'true';
          return `${JSON.stringify(key)}: ${val}`;
        })
        .join(', ');
      const childrenArg = hasChildren ? `__ch${id}(${scope ?? 'undefined'}, ${closes})` : `''`;
      result += `${acc} += ${tag.name}(${closes}, ${childrenArg}, { ${propsObj} }, { ${slotFns.join(', ')} });\n`;
      remaining = rest;
    } else {
      const [, expr] = earliest.match;
      const trimmed = expr.trim();
      const before = remaining.substring(0, earliest.index);
      if (trimmed === '__slot__') {
        if (before) result += emitChunk(before, acc, closes, scope);
        result += compileSlot(acc);
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      const slotCall = /^__slot\((['"])(\w+)\1, \[([\s\S]*)\]\)$/.exec(trimmed);
      if (slotCall) {
        if (before) result += emitChunk(before, acc, closes, scope);
        result += `${acc} += __slotBlock(${closes}, __sl, ${JSON.stringify(slotCall[2])}, [${slotCall[3]}]);\n`;
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      const rawMatch = /^@html\s+([\s\S]+)$/.exec(trimmed);
      if (rawMatch) {
        if (before) result += emitChunk(before, acc, closes, scope);
        const expr = rawMatch[1].trim();
        if (!markers) {
          result += `${acc} += String(${expr} ?? '');\n`;
        } else {
          const fn = scope ? `(${scope}) => (${expr})` : `() => (${expr})`;
          result += `${acc} += rawMark(${closes}, ${fn}${scope ? `, ${scope}` : ''});\n`;
        }
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      const attrMatch = before.match(/([\w-]+)=\s*$/);
      if (attrMatch) {
        const lit = before.slice(0, before.length - attrMatch[0].length);
        if (lit) result += emitChunk(lit, acc, closes, scope);
        result += emitAttr(attrMatch[1], trimmed, acc, closes, scope, markers);
      } else {
        if (before) result += emitChunk(before, acc, closes, scope);
        const after = remaining.substring(earliest.index + earliest.match[0].length);
        const pair = after.length > 0 && !/^<[a-zA-Z/!]/.test(after) && !after.startsWith('{');
        result += emitText(trimmed, acc, closes, scope, markers, pair);
      }
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    }
  }

  return result;
}

/** One component tag found in a template . */
interface CompTag {
  /** index of `<` in the searched string */
  start: number;
  /** index just past `>` */
  end: number;
  name: string;
  /** the raw attribute text between the tag name and `>` */
  attrs: string;
  selfClosing: boolean;
}

/**
 * Scan one tag from its `<` to its `>`, quote- and brace-aware so a `>` inside
 * an attribute expression (`title={a > b}`) does not end the tag. Returns the
 * index just past `>`, or -1 when the tag is never closed.
 */
function scanTagEnd(src: string, start: number): number {
  let j = start + 1;
  let quote = '';
  let brace = 0;
  while (j < src.length) {
    const c = src[j];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{') brace++;
    else if (c === '}') brace = Math.max(0, brace - 1);
    else if (c === '>' && brace === 0) return j + 1;
    j++;
  }
  return -1;
}

/** The earliest open tag whose name is an imported component . */
function findCompTag(src: string, comps: Map<string, unknown>): CompTag | null {
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) return null;
    const nm = /^<([a-zA-Z][\w-]*)/.exec(src.slice(lt, lt + 64));
    if (nm && comps.has(nm[1])) {
      const end = scanTagEnd(src, lt);
      if (end > 0) {
        const raw = src.slice(lt, end);
        const selfClosing = /\/>$/.test(raw);
        return { start: lt, end, name: nm[1], attrs: raw.slice(1 + nm[1].length, selfClosing ? -2 : -1), selfClosing };
      }
    }
    i = lt + 1;
  }
  return null;
}

/** Index of the `</name>` that closes the tag opened before `from` (-1: none). */
function findClose(src: string, from: number, name: string): number {
  const re = new RegExp(`<(/?)${name}(?=[\\s/>])`, 'g');
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const end = scanTagEnd(src, m.index);
    if (end < 0) return -1;
    if (m[1] === '/') {
      depth--;
      if (depth === 0) return m.index;
    } else if (!/\/>$/.test(src.slice(m.index, end))) depth++;
  }
  return -1;
}

interface CompAttr { name: string; kind: 'expr' | 'str' | 'bool'; value: string }

/** Parse a component tag's attributes into prop={expr} / prop="lit" / bool. */
function parseCompAttrs(attrs: string): CompAttr[] {
  const out: CompAttr[] = [];
  let i = 0;
  while (i < attrs.length) {
    const nm = /^\s*([\w:.-]+)/.exec(attrs.slice(i));
    if (!nm) break;
    i += nm[0].length;
    const eq = /^\s*=\s*/.exec(attrs.slice(i));
    if (!eq) {
      out.push({ name: nm[1], kind: 'bool', value: '' });
      continue;
    }
    i += eq[0].length;
    const ch = attrs[i];
    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < attrs.length && depth > 0) {
        if (attrs[j] === '{') depth++;
        else if (attrs[j] === '}') depth--;
        j++;
      }
      out.push({ name: nm[1], kind: 'expr', value: attrs.slice(i + 1, j - 1).trim() });
      i = j;
    } else if (ch === '"' || ch === "'") {
      const j = attrs.indexOf(ch, i + 1);
      out.push({ name: nm[1], kind: 'str', value: attrs.slice(i + 1, j < 0 ? attrs.length : j) });
      i = j < 0 ? attrs.length : j + 1;
    } else break;
  }
  return out;
}

/**
 * Reject a slot= that hides inside a named slot's content. The child only
 * ever looks at its DIRECT named children, so `<span slot="a"><b slot="a">`
 * would silently drop the inner one - say it at build time instead. The walk
 * is quote-aware (scanTagEnd), so an attribute value containing '>' cannot
 * fake a tag.
 */
function rejectNestedSlot(src: string, outer: string): void {
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) return;
    const nm = /^<(\/?)([a-zA-Z][\w-]*)/.exec(src.slice(lt, lt + 64));
    if (!nm) { i = lt + 1; continue; }
    const end = scanTagEnd(src, lt);
    if (end < 0) return;
    const hit = /\bslot\s*=\s*["'](\w+)["']/.exec(src.slice(lt, end));
    if (hit && nm[1] !== '/') {
      throw new RoseError('E-TEMPLATE', `slot="${hit[1]}" on <${nm[2]}> is nested inside slot="${outer}" - a slot must be a direct child of the component`, { hint: 'move the inner <slot> out of the outer one - a slot is a direct child of the component tag, never nested in another slot' });
    }
    i = end;
  }
}

/**
 * Split a component's children into the default slot and the named slots
 * (`<li slot="row">`). Only DIRECT children may be slot content: lifting an
 * element out of another element, or out of an {#if}/{#each} block, would
 * break the template around it - so that is a build error, not a silent
 * mis-render.
 */
function splitSlots(src: string): { def: string; named: Array<[string, string]> } {
  let def = '';
  const named = new Map<string, string>();
  let i = 0;
  let elemDepth = 0;
  let blockDepth = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const ob = src.indexOf('{#', i);
    const cb = src.indexOf('{/', i);
    const cands = [lt, ob, cb].filter((x) => x >= 0);
    if (cands.length === 0) {
      def += src.slice(i);
      break;
    }
    const next = Math.min(...cands);
    if (next > i) def += src.slice(i, next);
    if (next === ob || next === cb) {
      const close = src.indexOf('}', next);
      const token = src.slice(next, close < 0 ? src.length : close + 1);
      if (next === ob) blockDepth++;
      else blockDepth = Math.max(0, blockDepth - 1);
      def += token;
      i = next + token.length;
      continue;
    }
    const nm = /^<(\/?)([a-zA-Z][\w-]*)/.exec(src.slice(next, next + 64));
    if (!nm) {
      def += '<';
      i = next + 1;
      continue;
    }
    const end = scanTagEnd(src, next);
    if (end < 0) {
      def += src.slice(next);
      break;
    }
    const tagText = src.slice(next, end);
    const selfClosing = /\/>$/.test(tagText);
    const isVoid = VOID_TAGS.has(nm[2].toLowerCase());
    if (nm[1] === '/') {
      elemDepth = Math.max(0, elemDepth - 1);
      def += tagText;
      i = end;
      continue;
    }
    if (!selfClosing && !isVoid) elemDepth++;
    const slotName = /\bslot\s*=\s*["'](\w+)["']/.exec(tagText)?.[1];
    if (slotName && (elemDepth !== 1 || blockDepth !== 0)) {
      throw new RoseError('E-TEMPLATE', `slot="${slotName}" on <${nm[2]}> must be a direct child of the component - it is nested inside another element or an {#if}/{#each} block`, { hint: 'place <slot name="..."> directly inside the component tag - wrap the ELEMENTS around the slot, not the slot inside them' });
    }
    if (slotName) {
      const stripped = tagText.replace(/\s*slot\s*=\s*["']\w+["']/, '');
      if (selfClosing || isVoid) {
        named.set(slotName, (named.get(slotName) ?? '') + stripped);
      } else {
        const closeIdx = findClose(src, end, nm[2]);
        if (closeIdx < 0) throw new RoseError('E-TEMPLATE', `unclosed <${nm[2]}> inside slot="${slotName}"`, { hint: `add the matching </${nm[2]}> inside the slot content` });
        const tail = `</${nm[2]}>`;
        const inner = src.slice(end, closeIdx);
        rejectNestedSlot(inner, slotName);
        named.set(slotName, (named.get(slotName) ?? '') + stripped + inner + tail);
        elemDepth = Math.max(0, elemDepth - 1);
        i = closeIdx + tail.length;
        continue;
      }
      i = end;
      continue;
    }
    def += tagText;
    i = end;
  }
  return { def, named: [...named.entries()] };
}

/** Emit a static chunk (attributes are handled by the expr branch). */
function emitChunk(text: string, acc: string, closes: string, scope: string | null): string {
  if (!text) return '';
  return `${acc} += ${JSON.stringify(text)};\n`;
}

const IMG_RE = /<img\b(?:[^<>]|\{[^{}]*\})*>/g;
const IMG_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const INLINE_IMG_MAX = 4096;

function inlineImages(template: string, publicDir: string): string {
  return template.replace(IMG_RE, (tag) => {
    const src = tag.match(/\bsrc="(\/[^"{}]+)"/);
    if (!src) return tag;
    const ext = path.extname(src[1]).toLowerCase();
    const mime = IMG_MIME[ext];
    if (!mime) return tag;
    let file: Buffer;
    try {
      file = fs.readFileSync(path.join(publicDir, src[1]));
    } catch {
      return tag;
    }
    if (file.length > INLINE_IMG_MAX) return tag;
    const uri = ext === '.svg'
      ? `data:image/svg+xml,${file.toString('utf-8').replace(/%/g, '%25').replace(/#/g, '%23').replace(/"/g, '%22')}`
      : `data:${mime};base64,${file.toString('base64')}`;
    return tag.replace(src[0], `src="${uri}"`);
  });
}

/**
 * Emit a reactive text marker through the runtime's textMark(): the helper
 * pushes the closure and returns the marker pair around the escaped value.
 * A marker whose value is followed by literal text passes pair, so the wire
 * can bound exactly the value and leave the prose alone.
 */
function emitText(expr: string, acc: string, closes: string, scope: string | null, markers = true, pair = false): string {
  if (!markers) {
    return `${acc} += esc(${expr});\n`;
  }
  const fn = scope ? `(${scope}) => (${expr})` : `() => (${expr})`;
  let extra = pair ? ', 1' : scope ? ', 0' : '';
  if (scope) extra += `, ${scope}`;
  return `${acc} += textMark(${closes}, ${fn}${extra});\n`;
}

/** Emit a reactive attribute through the runtime's attrMark(). */
function emitAttr(attr: string, expr: string, acc: string, closes: string, scope: string | null, markers = true): string {
  if (!markers) {
    return `${acc} += '${attr}="' + esc(${expr}) + '"';\n`;
  }
  const fn = scope ? `(${scope}) => (${expr})` : `() => (${expr})`;
  const arg = scope ? `, ${scope}` : '';
  return `${acc} += attrMark(${closes}, ${fn}, '${attr}'${arg});\n`;
}

/**
 * <slot /> -> inline the children html. The page rendered first with the same
 * shared closes array, so the top-level wire() pass resolves its markers.
 */
function compileSlot(acc: string): string {
  return `${acc} += String(children);\n`;
}

const RUNTIME_IMPORTS = `import { state, setState, $data, hasState, esc, refresh, onMount, onCleanup, getContext, $query, $t, bestLocale, localeDir, ensureLocale, loadLocale, handlers, $cookies, $sessionCookie, $store, ActionError, $actionError, $actionErrorOrThrow, $boundaryFallback, $append, $prepend, $merge, applyStateDeltas, textMark, attrMark, ifMark, eachMark, headMark, rawMark } from './runtime.js';`;

const API_RUNTIME_HELPERS = RUNTIME_IMPORTS
  .replace(/^import\s*\{/, '')
  .replace(/\}\s*from[\s\S]*$/, '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * `export let title = 'x'` -> a per-invocation const read from the
 * caller's props object, defaulting to the declared value. Emitted at the top
 * of render(), BEFORE the state declarations: a prop may seed one
 * (`let open = $state(collapsed)`).
 */
function propsCode(props: Array<{ name: string; def: string | null }>): string {
  if (props.length === 0) return '';
  return props
    .map((p) => `const ${p.name} = __p.${p.name}${p.def ? ` ?? (${p.def})` : ''};`)
    .join('\n');
}

const SLOT_HELPER = `const __slot = (sl, name, pairs) => {
  const fn = sl[name];
  if (typeof fn !== 'function') return null;
  const o = {};
  for (let i = 0; i < pairs.length; i++) o[pairs[i][0]] = pairs[i][1];
  return { o, fn };
};
const __slotBlock = (closes, sl, name, pairs) => {
  const hit = __slot(sl, name, pairs);
  const idx = closes.length;
  closes.push(() => {
    if (!hit) return null;
    const c = [];
    return { html: String(hit.fn(hit.o, c)), closes: c, scope: hit.o };
  });
  return "<!--\\u27e6i:" + idx + "\\u27e7-->" + (hit ? String(hit.fn(hit.o, [])) : "") + "<!--\\u27e6/i:" + idx + "\\u27e7-->";
};`;

function generateSSR(script: string, templateFn: string, stateDeclsCode: string, exports = '', headFn = '', props: Array<{ name: string; def: string | null }> = [], namedSlots = false, imports = '', isComponent = false, guard = '', hasActions = false, dataDeclsCode = ''): string {
  const headCode = headFn
    ? `
const __head = () => { let __hd = ''; ${headFn} return __hd; };
__html += headMark(closes, __head);`
    : '';
  const actionState = hasActions ? `
const $setState = (key, value) => setState(key, value);` : '';
  return `
${RUNTIME_IMPORTS}

${imports}

${exports}
${guard}
${actionState}

${namedSlots ? SLOT_HELPER : ''}

export ${isComponent ? 'function' : 'async function'} render(closes, children, __props, __slots) {
  ${props.length > 0 ? 'const __p = __props || {};' : ''}
  ${namedSlots ? 'const __sl = __slots || {};' : ''}
  ${propsCode(props)}
  ${script}
  ${stateDeclsCode}
  ${dataDeclsCode}
 // The incremental patches of the action that produced THIS response,
  // applied to the state the declarations above just established (a no-op on
  // every path that is not a server action's re-render - see the runtime).
  ${isComponent ? '' : 'applyStateDeltas();'}
  const __root = (__c, children) => { let h = ''; ${templateFn} return h; };
  let __html = ${isComponent ? '' : 'await '}__root(closes, children);${headCode}
  return __html;
}
`;
}

function generateClient(
  script: string,
  templateFn: string,
  stateDeclsCode: string,
  eventBindings: Array<{ event: string; fn: string }>,
  exports = '',
  headFn = '',
  props: Array<{ name: string; def: string | null }> = [],
  namedSlots = false,
  imports = '',
  isComponent = false,
  dataDeclsCode = ''
): string {
  const handlerRegistry = eventBindings.length > 0
    ? `Object.assign(handlers, { ${eventBindings.map((b) => b.fn).join(', ')} });`
    : '';
  const clientSetState = eventBindings.length > 0
    ? `const $setState = (key, value) => setState(key, value);`
    : '';
  const headCode = headFn
    ? `
const __head = () => { let __hd = ''; ${headFn} return __hd; };
__html += headMark(closes, __head);`
    : '';

  return `
${RUNTIME_IMPORTS}

${imports}

${exports}
${clientSetState ? `\n${clientSetState}\n` : ''}
${namedSlots ? SLOT_HELPER : ''}

export ${isComponent ? 'function' : 'async function'} render(closes, children, __props, __slots) {
  ${props.length > 0 ? 'const __p = __props || {};' : ''}
  ${namedSlots ? 'const __sl = __slots || {};' : ''}
  ${propsCode(props)}
  ${script}
  ${stateDeclsCode}
  ${dataDeclsCode}
  ${handlerRegistry}
  const __root = (__c, children) => { let h = ''; ${templateFn} return h; };
  let __html = ${isComponent ? '' : 'await '}__root(closes, children);${headCode}
  return __html;
}
`;
}

/** The layout chain for a component (deepest first): every layout file in an
 *  ancestor directory. Shared by compose(), the zero-JS decision (#29) and
 *  the build report (#31). */
const layoutsOf = (infos: RouteInfo[], idx: number): number[] =>
  infos
    .map((li, i) => ({ li, i }))
    .filter(({ li }) => li.isLayout && isAncestorDir(li.filePath, infos[idx].filePath))
    .sort((a, b) => b.li.filePath.length - a.li.filePath.length)
    .map(({ i }) => i);

/**
 * 's decision as a pure function: does this route's document
 * ship without the client bundle? Shared by the route table (csr: false) and
 * the build report (#31), so the report can never disagree with the build.
 */
const routeShipsNoJs = (infos: RouteInfo[], compiled: CompileResult[], i: number): boolean => {
  if (compiled[i].csr === true) return false;
  if (compiled[i].needsClient) return false;
  return !layoutsOf(infos, i).some((li) => compiled[li].needsClient);
};

/**
 * The build's zero-JS lint report: one line per route with
 * its verdict and the exact reason - which component in the chain needs the
 * client bundle and why, or that nothing does. Pure: the same inputs the
 * route table is built from.
 */
export function buildReport(infos: RouteInfo[], compiled: CompileResult[]): string[] {
  return infos
    .map((info, i) => ({ info, i }))
    .filter(({ info }) => !info.isLayout && !info.isNotFound && !info.isError && !info.isApi && !info.isMiddleware && !info.isComponent)
     .map(({ info, i }) => {
      if (routeShipsNoJs(infos, compiled, i)) {
        return `${info.routePath}  zero-JS  nothing in the chain needs the client`;
      }
      const why = [i, ...layoutsOf(infos, i)]
        .filter((ci) => compiled[ci].needsClient)
        .map((ci) => `${(compiled[ci].clientReasons ?? ['needs the client']).join(' + ')} in ${path.basename(infos[ci].filePath)}`)
        .join('; ');
      const forced = compiled[i].csr === true ? ' (csr = true forces the bundle)' : '';
      return `${info.routePath}  client JS  ${why}${forced}`;
    });
}

/**
 * The mount entry - the migration door. A foreign
 * page (the legacy half of a micro-frontend, or an old app adopting rosefn
 * one route at a time) marks containers and includes this one file:
 *
 *   <div data-rosefn="/checkout"></div>
 *   <script type="module" src="/mount.js"></script>
 *
 * Each container fetches its route's own document - the same one-request,
 * zero-hydration shape a standalone page gets - adopts the server's DOM in
 * place, and navigates inside itself: the host page keeps its URL, its
 * history, its <head> and every node outside the container. It imports the
 * same /client.js the documents use (mode B's entry, or the inline build's
 * bundle), so there is no second runtime and no hydration.
 *
 * Written verbatim, not minified: it ships once per app (not once per
 * document) and the servers compress it like any other asset. The cost to a
 * normal rosefn document is zero bytes - nothing references it unless the
 * host page does.
 */
const MOUNT_ENTRY = `// Rosefn mount: embed this app inside a foreign page.
// <div data-rosefn="/route"></div> + <script type="module" src="/mount.js"></script>
// One fetch per container (the route's own document), zero hydration, and
// navigation that never touches the host page's URL, history or <head>.
import { start, postForm } from '/client.js';

for (const el of document.querySelectorAll('[data-rosefn]')) {
  const route = el.getAttribute('data-rosefn');
  const doc = await fetch(route).then((r) => (r.ok ? r.text() : ''));
  const parsed = new DOMParser().parseFromString(doc, 'text/html');
  // A JS-shipping document wraps its content in #app; a zero-JS route's
  // content is the body's own (no wrapper). Either way: the server's DOM,
  // minus the scripts it inlined.
  const app = parsed.getElementById('app');
  if (app) {
    el.innerHTML = app.innerHTML;
  } else {
    for (const node of Array.from(parsed.body.children)) {
      if (!/^(?:SCRIPT|LINK|STYLE)$/.test(node.tagName)) el.appendChild(node);
    }
  }
  // start() resumes from #__rosefn_state (zero hydration), so the state
  // script rides along inside the container - and is dropped once adopted.
  const state = parsed.getElementById('__rosefn_state');
  if (state) el.appendChild(state);
  // A static-file server's SPA fallback answers the shell for an unknown
  // path, and its #app holds a DIFFERENT route: adopt only a document the
  // server really rendered for this route, else render it from the bundle.
  const rendered = state ? JSON.parse(state.textContent || '{}').__route : null;
  await start(el, route, rendered === route);
  if (state) state.remove();
  // Navigation stays inside the mount: the listener bails for anything
  // outside the container, so the host page's own links keep working. The
  // attribute is kept in step with what is mounted - it is how a server
  // action inside the mount finds its route (and its container).
  el.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="/"]');
    if (!a || !el.contains(a)) return;
    e.preventDefault();
    el.setAttribute('data-rosefn', a.getAttribute('href'));
    start(el, a.getAttribute('href'), false);
  });
  // Progressive-enhancement forms work inside a mount too: the native POST
  // would replace the HOST page, so the submit is intercepted and adopted
  // in place - the same one-request, in-place contract as a standalone page.
  el.addEventListener('submit', (e) => {
    const f = e.target;
    if (!f || f.tagName !== 'FORM' || f.hasAttribute('data-on-submit')) return;
    if ((f.getAttribute('method') || '').toLowerCase() !== 'post') return;
    e.preventDefault();
    postForm(new FormData(f), el, el.getAttribute('data-rosefn'));
  });
}
`;

export async function buildProject(root: string, outDir: string): Promise<{ routes: RouteInfo[]; bundle: string }> {
  await fs.promises.mkdir(outDir, { recursive: true });

  const stale = (await fs.promises.readdir(outDir)).filter((f) =>
    /^(?:comp-\d+\.(?:ssr|client)|runtime|(?:server|client)-entry)\.js$/.test(f));
  await Promise.all(stale.map((f) => fs.promises.rm(path.join(outDir, f), { force: true })));

  const pageFiles = await scanRoseFiles(root);
  const compFiles = await scanComponentFiles(root);
  const files = [...pageFiles, ...compFiles];
  if (pageFiles.length === 0) {
    throw new RoseError(
      'E-ROUTE',
      `no .rose pages found under ${path.join(root, 'src', 'pages')} - run rosefn from a project root, or pass one: rosefn build <dir>`,
      { file: path.join(root, 'src', 'pages'), hint: 'create src/pages/index.rose in that directory (or run the command from the project root)' },
    );
  }
  const infos = files.map((f) => ({ ...getRouteInfo(f, root) }));
  const config = await loadConfig(root);
  const plugins = config.plugins;
  const scopeKeys = files.map((f, i) => {
    const base = infos[i].isComponent ? path.join(root, 'src') : path.join(root, 'src', 'pages');
    return path.relative(base, f).replace(/\\/g, '/').replace(/\.rose$/, '');
  });
  const registry: RoseRegistry = new Map(
    files.map((f, i) => [f, { index: i, scopeKey: scopeKeys[i], slots: scanSlotDecls(f) }])
  );
  const compiled = await Promise.all(
    files.map((f, i) => compileComponent(f, path.join(root, 'public'), scopeKeys[i], infos[i].isApi, plugins, registry))
  );

  const importsOf = new Map<number, number[]>();
  files.forEach((_, i) => {
    const list: number[] = [];
    for (const r of compiled[i].roseImports ?? []) {
      const abs = path.resolve(path.dirname(files[i]), r.specifier);
      const hit = registry.get(abs);
      if (hit) list.push(hit.index);
    }
    importsOf.set(i, list);
  });
  const needyDep = (i: number, seen = new Set<number>()): string | null => {
    if (compiled[i].needsClient) return path.basename(files[i]);
    if (seen.has(i)) return null;
    seen.add(i);
    for (const dep of importsOf.get(i) ?? []) {
      const hit = needyDep(dep, seen);
      if (hit) return hit;
    }
    return null;
  };
  compiled.forEach((c, i) => {
    if (c.needsClient) return;
    const who = needyDep(i);
    if (who) {
      c.needsClient = true;
      c.clientReasons = [...(c.clientReasons ?? []), `imported component ${who} needs the client`];
    }
  });

  const reachable = new Set<number>();
  const visit = (i: number) => {
    if (reachable.has(i)) return;
    reachable.add(i);
    for (const r of compiled[i].roseImports ?? []) {
      const abs = path.resolve(path.dirname(files[i]), r.specifier);
      const hit = registry.get(abs);
      if (hit) visit(hit.index);
    }
  };
  files.forEach((_, i) => {
    if (!infos[i].isComponent) visit(i);
  });

  const styles = compiled
    .map((c, i) => (reachable.has(i) ? c.style : ''))
    .filter(Boolean).join('\n');
  if (styles) await fs.promises.writeFile(path.join(outDir, 'styles.css'), styles);
  else await fs.promises.rm(path.join(outDir, 'styles.css'), { force: true });

  let locales: Record<string, Record<string, string>> = {};
  try {
    for (const f of await fs.promises.readdir(path.join(root, 'src', 'locales'))) {
      if (!f.endsWith('.json')) continue;
      locales[f.slice(0, -5)] = JSON.parse(await fs.promises.readFile(path.join(root, 'src', 'locales', f), 'utf-8'));
    }
  } catch {
    locales = {};
  }
  const defaultLocale = locales.en ? 'en' : Object.keys(locales).sort()[0] ?? 'en';
  const localesJson = JSON.stringify(locales).replace(/</g, '\\u003c');

  const preload: string[] = config.i18n.preload ?? Object.keys(locales);
  const packed = Object.keys(locales).filter((l) => !preload.includes(l));
  for (const l of preload) {
    if (!locales[l]) console.warn(`Rosefn: i18n.preload lists '${l}' but there is no src/locales/${l}.json - ignored`);
  }
  await fs.promises.rm(path.join(outDir, 'locales'), { recursive: true, force: true });
  if (packed.length > 0) {
    const packDir = path.join(outDir, 'locales');
    await fs.promises.mkdir(packDir, { recursive: true });
    for (const l of packed) await fs.promises.writeFile(path.join(packDir, `${l}.json`), JSON.stringify(locales[l]));
  }
  const clientLocales = Object.fromEntries(Object.keys(locales).filter((l) => !packed.includes(l)).map((l) => [l, locales[l]]));
  const clientLocalesJson = JSON.stringify(clientLocales).replace(/</g, '\\u003c');

  const buildDir = path.join(outDir, '.build');
  await fs.promises.rm(buildDir, { recursive: true, force: true });
  await fs.promises.mkdir(buildDir, { recursive: true });

  const runtimePlugins = plugins.filter((p) => p && (p.onRequest || p.onResponse));
  if (runtimePlugins.length > 0) {
    const configRel = path.relative(buildDir, path.join(root, 'rosefn.config.js')).replace(/\\/g, '/');
    await fs.promises.writeFile(path.join(buildDir, 'plugins.js'), `// Generated by rosefn - the runtime half of rosefn.config.js. Do not edit.
// Bundled into dist/server.js: these hooks run per request on every server
// (Node, dev/preview, edge). Transform hooks already ran at build time.
import config from ${JSON.stringify(configRel)};

const list = Array.isArray(config) ? config : [];
export const hooks = list
  .filter((p) => p && (p.onRequest || p.onResponse))
  .map((p) => ({ name: p.name, onRequest: p.onRequest ? p.onRequest.bind(p) : null, onResponse: p.onResponse ? p.onResponse.bind(p) : null }));

export const hasRequestHooks = hooks.some((p) => p.onRequest);
export const hasResponseHooks = hooks.some((p) => p.onResponse);
`);
  }

  const runtimeEntry = ['../runtime/index.ts', '../src/runtime/index.ts']
    .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
    .find((p) => fs.existsSync(p));
  if (!runtimeEntry) throw new RoseError('E-INTERNAL', 'Rosefn: the runtime source (src/runtime/index.ts) was not found next to the compiler', { hint: 'the published package ships src/ beside dist-cli/ - reinstall it, or run from a checkout' });
  await esbuild.build({
    entryPoints: [runtimeEntry],
    bundle: true,
    outfile: path.join(buildDir, 'runtime.js'),
    format: 'esm',
    platform: 'browser',
    write: true,
  });

  for (let i = 0; i < compiled.length; i++) {
    const src = compiled[i].api ?? compiled[i].ssr;
    await fs.promises.writeFile(path.join(buildDir, `comp-${i}.ssr.js`), src);
    if (!infos[i].isApi) {
      await fs.promises.writeFile(path.join(buildDir, `comp-${i}.client.js`), compiled[i].client);
    }
  }

  const pages = infos
    .map((info, i) => ({ info, i }))
    .filter(({ info }) => !info.isLayout && !info.isNotFound && !info.isError && !info.isApi && !info.isMiddleware && !info.isComponent);

  const apiRoutes = infos
    .map((info, i) => ({ info, i }))
    .filter(({ info }) => info.isApi);

  const compose = (idx: number): string => {
    let expr = `render_${idx}`;
    for (const i of layoutsOf(infos, idx)) {
      expr = `(async (closes, children) => await render_${i}(closes, await (${expr})(closes, children)))`;
    }
    return expr;
  };

  const bundleMode = compiled.find((c) => c.bundle)?.bundle ?? 'inline';
  const split = bundleMode === 'split';
  const chainOf = (idx: number): number[] => [idx, ...layoutsOf(infos, idx)];
  const loaderInner = (idx: number): string =>
    `load: () => loadChain([${chainOf(idx).map((i) => `() => import('./comp-${i}.client.js')`).join(', ')}])`;
  const loaderOf = (idx: number): string => `{ ${loaderInner(idx)} }`;

  const routeNoJs = (i: number): boolean => routeShipsNoJs(infos, compiled, i);

  const serverImports = compiled
    .map((_, i) => {
      if (!reachable.has(i)) return '';
      if (infos[i].isMiddleware) {
        return `import * as middlewareMod from './comp-${i}.ssr.js';`;
      }
      if (infos[i].isApi) {
        const names = compiled[i].apiMethods ?? [];
        const handlerImports = names.map((n) => `${n} as ${n}_${i}`).join(', ');
        return handlerImports
          ? `import { ${handlerImports} } from './comp-${i}.ssr.js';`
          : `import './comp-${i}.ssr.js';`;
      }
      const isPage = !infos[i].isLayout && !infos[i].isNotFound;
      const names = isPage ? compiled[i].actionNames : [];
      const actionImports = names.map((n) => `${n} as ${n}_${i}`).join(', ');
      const guardImport = isPage && compiled[i].guardName ? `beforeAction as beforeAction_${i}` : '';
      const named = [actionImports, guardImport].filter(Boolean).join(', ');
      return named
        ? `import { render as render_${i}, ${named} } from './comp-${i}.ssr.js';`
        : `import { render as render_${i} } from './comp-${i}.ssr.js';`;
    })
    .join('\n');

  const nfIdx = infos.findIndex((info) => info.isNotFound);
  const notFoundRender = nfIdx >= 0 ? (split ? loaderOf(nfIdx) : compose(nfIdx)) : 'null';

  const errIdx = infos.findIndex((info) => info.isError);
  const errorRender = errIdx >= 0 ? (split ? loaderOf(errIdx) : compose(errIdx)) : 'null';

  const middlewareIdx = infos.findIndex((info) => info.isMiddleware);

  const serverRoutes = pages
    .map(({ info, i }) => {
      const actionMap = compiled[i].actionNames.map((n) => `${n}: ${n}_${i}`).join(', ');
      if (compiled[i].csr === false && compiled[i].needsClient) {
        throw new RoseError(
          'E-EXPORT',
          `${info.filePath}: csr = false but this route needs the client bundle ` +
          `(${(compiled[i].clientReasons ?? ['needs the client']).join(' + ')}).`,
          { file: info.filePath, hint: 'remove csr = false (the compiler decides zero-JS by itself), or remove the client-only code listed above' },
        );
      }
      if (compiled[i].csr === false) {
        const needy = layoutsOf(infos, i).find((li) => compiled[li].needsClient);
        if (needy !== undefined) {
          throw new RoseError(
            'E-EXPORT',
            `${info.filePath}: csr = false cannot ship under ${infos[needy].filePath} - the layout needs the client bundle ` +
            `(event wiring, onMount/onCleanup, refresh() or a server action).`,
            { file: info.filePath, hint: 'a layout needing the runtime bundles every route under it - drop csr = false here, or make the layout content-only' },
          );
        }
      }
      const csrFlag = routeNoJs(i) ? ', csr: false' : '';
      const bufferFlag = compiled[i].buffer ? ', buffer: true' : '';
      const guardFlag = compiled[i].guardName ? `, guard: beforeAction_${i}` : '';
      return `{ pattern: '${info.pattern}', path: '${info.routePath}', render: ${compose(i)}, actions: ${actionMap ? `{ ${actionMap} }` : 'null'}${guardFlag}${csrFlag}${bufferFlag} }`;
    })
    .join(',\n  ');

  const serverEntry = `
${serverImports}
import { setState, clearRequestState, serializeState, resetRequestContext, setRequestQuery, isLocale, setLocales, localeList, localeDir, setStoreTransport, applyStorePatch, ActionError, StateDelta, setStateDelta } from './runtime.js';
${runtimePlugins.length > 0
    ? `import { hooks as __pluginHooks, hasRequestHooks as __hasRequestHooks, hasResponseHooks as __hasResponseHooks } from './plugins.js';`
: `// no plugin declares a runtime hook, so there is no plugins
// module to import - the runners below stay no-ops and the servers call them
// unconditionally (one code path, no flags to keep in sync).
const __pluginHooks = [];
const __hasRequestHooks = false;
const __hasResponseHooks = false;`}

// The runtime plugin hooks. onRequest runs before routing and
// middleware and may short-circuit the request with its own Response; onResponse
// runs once the response exists and may replace it. Both are no-ops when the
// project declares no runtime hooks. A throwing hook is logged and skipped -
// the request continues - so a broken logging plugin can never take a site
// down (a build-time transform, by contrast, fails loudly).
export async function runRequestHooks(ctx) {
  for (const p of __pluginHooks) {
    if (!p.onRequest) continue;
    try {
      const r = await p.onRequest(ctx);
      if (r instanceof Response) return r;
    } catch (err) {
      console.error('Rosefn: plugin', p.name, 'onRequest failed:', err instanceof Error ? err.message : err);
    }
  }
  return null;
}

export async function runResponseHooks(ctx, res) {
  let out = res;
  for (const p of __pluginHooks) {
    if (!p.onResponse) continue;
    try {
      const r = await p.onResponse(ctx, out);
      if (r instanceof Response) out = r;
    } catch (err) {
      console.error('Rosefn: plugin', p.name, 'onResponse failed:', err instanceof Error ? err.message : err);
    }
  }
  return out;
}

// The servers read these to skip building the hook context entirely when no
// hook exists - the hot path pays nothing for the feature.
export const hasRequestHooks = __hasRequestHooks;
export const hasResponseHooks = __hasResponseHooks;

// P0-1: the query of the request being rendered, for $query(). The servers
// call this before every render (stream, buffered, POST, api) with the parsed
// query string; routing itself matches the pathname, which is what fixed the
// query-404. A render with no query (the build's prerender, the ISR
// background pass) passes {} explicitly - the bag is per request, so a stale
// one must never leak into the next.
export function setQuery(query) {
  setRequestQuery(query || {});
}

// i18n: the dictionaries baked at build time from
// src/locales/*.json. A route segment named [lang] is the locale: the value
// must name one of these dictionaries, and $t resolves keys against it.
setLocales(${localesJson}, '${defaultLocale}');

// The store transport. Under "rosefn serve" every worker is its
// own process with its own dist/server.js module, so a $store write must
// travel: this worker -> primary -> every other worker. process.send exists
// only inside cluster workers, so a single-process runner (dev, preview,
// the edge adapter) keeps the transport null and $store stays plain
// per-process state - the documented boundary, not a bug.
if (typeof process !== 'undefined' && typeof process.send === 'function') {
  setStoreTransport((name, value) => process.send({ type: 'rosefn:store', name, value }));
  process.on('message', (msg) => {
    if (msg && msg.type === 'rosefn:store') applyStorePatch(msg.name, msg.value);
  });
}

// (the cross-machine seam): the cluster relay above covers ONE
// machine. A driver that spans machines (redis pub/sub, NATS, a database
// NOTIFY) lives in the project's rosefn.config.js, because that is where
// its client library is imported - and a plugin's onServe runs in the
// WORKER process, next to this module but not inside it. These two exports
// are the bridge: rosefn serve hands them to onServe's meta.store, and
// the driver reaches the one store map the pages of THIS module read.
// Both are inert unless called, so the edge bundle keeps its zero-import
// shape and a dist built before this existed simply has no bridge.
export function __installStoreTransport(send: (name: string, value: unknown) => void): void {
  setStoreTransport(send);
}
export function __deliverStorePatch(name: string, value: unknown): void {
  applyStorePatch(name, value);
}

export { localeList };
export const defaultLocale = '${defaultLocale}';

// Route params maps, re-exported for the build's prerender step: routePath
// -> the component's exported params (a static map or a function). Reading
// them through the server bundle keeps the deploy dir free of component
// modules - both bundles are self-contained, nothing else may ship. Only
// components that actually export params appear here (a missing export
// means the dynamic route renders on demand).
${pages.filter(({ i }) => compiled[i].hasParams).map(({ i }) => `import * as comp_${i} from './comp-${i}.ssr.js';`).join('\n')}

export const routeParams = {
  ${pages.filter(({ info, i }) => compiled[i].hasParams).map(({ info, i }) => `'${info.routePath}': comp_${i}.params`).join(',\n  ')}
};

// Routes whose component reads the request context (getContext()), mutates a
// shared store ($store()), reads the query ($query(), P0-1), opted into
// nonce-based CSP or into the buffered path (buffer = true, P0-2):
// the bag is per-request, the store is per-process, a nonce is per-response,
// and a buffered route's hooks must run per request - so these are dynamic.
// The build never bakes them and the servers never answer them from a
// prerendered file. Public routes keep the static fast path (file cache,
// ETag/304, streaming) untouched.
export const dynamicRoutes = [
  ${pages.filter(({ i }) => compiled[i].usesContext || compiled[i].cspNonce || compiled[i].buffer).map(({ info }) => `'${info.routePath}'`).join(',\n  ')}
];

// Which api routes opt into build-time baking (export const prerender = true):
// routePath -> boolean. The build calls the GET handler once and writes the
// body to dist/, so the Go single binary serves read-only APIs without Node.
${apiRoutes.filter(({ i }) => compiled[i].hasPrerender).map(({ i }) => `import * as api_${i} from './comp-${i}.ssr.js';`).join('\n')}

export const apiPrerender = {
  ${apiRoutes.map(({ info, i }) => `'${info.routePath}': ${compiled[i].hasPrerender ? `api_${i}.prerender === true` : 'false'}`).join(',\n  ')}
};

// Stale-while-revalidate windows (export const revalidate = N): the build
// bakes these routes like any other, and the preview server serves the
// baked file for up to N seconds - after which the next request is answered
// STALE (instant, from disk) while a background pass re-renders and swaps
// the file (ISR). Routes that read the request context are
// excluded: they render per request and have no baked file to revalidate.
// The dev server ignores the window (it rebuilds on change), the edge
// adapter renders live (always fresh), and the Go binary serves the baked
// file forever - the same static-half boundary as page POSTs.
export const revalidate = [
  ${pages.filter(({ i }) => compiled[i].revalidate !== undefined && !compiled[i].usesContext).map(({ info, i }) => `{ pattern: '${info.pattern}', seconds: ${compiled[i].revalidate} }`).join(',\n  ')}
];

// pages/_middleware.rose: a Web-standard request handler that runs before
// every render on the server (pages, POSTs, api calls alike). Returning a
// Response short-circuits the whole request - a redirect, an auth wall, a
// rewrite; returning nothing continues, and getContext() hands the
// per-request bag to $data, server actions and api handlers. Absent -> null,
// and the servers keep their static fast paths.
export const middleware = ${middlewareIdx >= 0 ? 'middlewareMod.handle ?? null' : 'null'};

// Routes whose DOCUMENTS ship without the client bundle (
// decided by the compiler since #29): HTML + CSS only - no runtime, no
// state script, zero JavaScript for whoever lands on them. The compiler
// picks these automatically: a route whose whole chain needs nothing from
// the client (no event wiring, no lifecycle, no action, no form) is a
// content route. An exported "csr = true" forces the bundle back in; an
// exported "csr = false" is the same decision, asserted. The route's render
// function still rides in the client bundle, so a client-side navigation
// from an interactive page paints it normally and a static deploy's SPA
// fallback can render it too; only the document is JS-free.
// isNoJs() lets the servers keep these routes on the buffered path: a
// streamed no-JS document would carry the shell's default <title> (the
// route head is applied client-side at boot, and there is no client).
export const noJsRoutes = [
  ${pages.filter(({ i }) => routeNoJs(i)).map(({ info }) => `'${info.pattern}'`).join(',\n  ')}
];

export function isNoJs(pathname) {
  return noJsRoutes.some((pattern) => matchRoute(pattern, pathname));
}

// P0-2 (bug report): routes that exported "buffer = true". The servers ask
// this BEFORE choosing a path: a streamed response commits its status and
// headers before the body exists, so its onResponse hooks cannot see the
// document and a render that throws mid-flight still answers 200. A buffered
// route keeps every capability and gives up the early flush - the trade is
// the route's to make, per route, not the framework's.
export function isBuffered(pathname) {
  return routes.some((route) => route.buffer && matchRoute(route.pattern, pathname));
}

// Per-route response headers: a route exporting a headers
// map carries them into every response the servers write for it, merged
// OVER the framework defaults (the strict CSP) - so an app can tighten or
// relax the policy per route. Absent -> null, and the servers keep sending
// the defaults alone.
export const routeHeaders = [
  ${pages.filter(({ i }) => compiled[i].headers).map(({ info, i }) => `{ pattern: '${info.pattern}', headers: ${JSON.stringify(compiled[i].headers)} }`).join(',\n  ')}
];

export function headersFor(pathname) {
  const hit = routeHeaders.find((r) => matchRoute(r.pattern, pathname));
  return hit ? hit.headers : null;
}

// Routes that opted into nonce-based CSP (export const csp = { nonce: true },
// ). The servers ask this BEFORE writing a document: when it is true they
// mint one random nonce per response, put it in the CSP header ('nonce-...'
// plus 'strict-dynamic', so the document's own code may load more code) and
// stamp the same value on the script tag. The default policy stays a hash -
// cspNonceRoutes is empty for an app that never asks, so the fast path is
// unchanged. The Go binary never sees this: these routes are dynamic, so it
// has no baked file for them to serve.
export const cspNonceRoutes = [
  ${pages.filter(({ i }) => compiled[i].cspNonce).map(({ info }) => `'${info.routePath}'`).join(',\n  ')}
];

export function cspNonce(pathname) {
  return cspNonceRoutes.some((pattern) => matchRoute(pattern, pathname));
}

// A Web-standard Request from whatever the host provides: the edge adapter
// passes one already; the Node server passes its IncomingMessage (plus the
// already-parsed FormData for POSTs, so middleware can read form fields).
function toWebRequest(raw, form) {
  if (raw instanceof Request) return raw;
  const init = { method: raw.method || 'GET', headers: new Headers(raw.headers || {}) };
  if (form) init.body = form;
  return new Request('http://' + (raw.headers?.host || 'localhost') + (raw.url || '/'), init);
}

// Runs the middleware (if the project has one) for this request and returns
// its short-circuit Response, or null to continue. The servers call this
// EXACTLY ONCE per request, before anything else: it resets the per-request
// context bag and the middleware fills it via getContext(), which $data,
// server actions and api handlers then read while rendering. rawReq: the
// host's request (Node IncomingMessage or a Web-standard Request); form:
// the already-parsed FormData of a POST.
export async function runMiddleware(rawReq, form) {
  resetRequestContext();
  if (!middleware || !rawReq) return null;
  const res = await middleware(toWebRequest(rawReq, form));
  return res || null;
}

const routes = [
  ${serverRoutes}
];

// API routes (pages/api/*.rose): pattern -> HTTP-method handlers. They never
// render HTML and never reach the client bundle. The middleware ran before
// this (the servers call runMiddleware() first), so handlers can read
// getContext() for auth without re-running anything.
const apiRoutes = [
  ${apiRoutes.map(({ info, i }) => {
    const handlers = (compiled[i].apiMethods ?? []).map((n) => `${n}: ${n}_${i}`).join(', ');
    return `{ pattern: '${info.pattern}', path: '${info.routePath}', handlers: { ${handlers} } }`;
  }).join(',\n  ')}
];

// pages/404.rose (with its layouts) or null -> built-in plain 404
const notFound = ${notFoundRender};

// pages/500.rose (with its layouts) or null -> built-in plain 500: a route
// whose render throws degrades to this instead of failing the response.
const errorPage = ${errorRender};

// The <html> attributes of the document for a pathname - the locale
// of its [lang] segment (the default when there is none, or when the segment
// names no dictionary: that request 404s in the default language) and the
// reading direction that locale implies. The buffered render returns the same
// pair; the streaming path needs it BEFORE the shell flushes, which is why
// the servers ask for it by pathname.
export function docAttrs(pathname) {
  for (const route of routes) {
    if (!matchRoute(route.pattern, pathname)) continue;
    const parts = route.pattern.split('/');
    const langIdx = parts.indexOf(':lang');
    if (langIdx >= 0) {
      const lang = pathname.split('/')[langIdx];
      if (isLocale(lang)) return { lang, dir: localeDir(lang) };
    }
    break; // matched, but not a localized route (or a bogus locale): the default
  }
  return { lang: defaultLocale, dir: localeDir(defaultLocale) };
}

// Paint a fallback page (404/500) and serialize its state.
async function renderFallback(pathname, render) {
  const { html, head } = extractHead(await render([], ''));
  const state = JSON.stringify({ __route: pathname, ...JSON.parse(serializeState()) });
  return { html, state, head, ...docAttrs(pathname) };
}

export function matchRoute(pattern, pathname) {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return false;
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) continue;
    if (patternParts[i] !== pathParts[i]) return false;
  }
  return true;
}

// Head blocks (one per component in the route chain) are pulled out of the
// page html: the shell injects them into <head>, and the client re-applies
// them on navigation. Document order is page-first, so the shell's keyed
// merge lets a page override its layouts. The EMPTY marker pair stays in the
// body so the client's wire() still finds the block: at boot it adopts the
// shell-injected elements in place (marked with the same keys, so no
// duplicates) and keeps the head reactive.
function extractHead(rendered) {
  const head = [];
  const html = rendered.replace(/<!--\u27e6h:(\\d+)\u27e7-->([\\s\\S]*?)<!--\u27e6\\/h:\\1\u27e7-->/g, (_, id, content) => {
    head.push(content);
    return '<!--\u27e6h:' + id + '\u27e7--><!--\u27e6/h:' + id + '\u27e7-->';
  });
  return { html, head };
}

// form: the submitted FormData of a progressive-enhancement POST. The
// selected server action runs first and returns a state patch (e.g.
// { guests: [...] }); seeding those keys BEFORE the render makes state()
// adopt them, so the response is the page as it looks AFTER the action -
// with or without JS. A __action field picks the action by name (default
// 'action', the conventional <form method="POST"> target); a click handler
// bound to an action ($action('like')) sends the same field.
// A route whose render throws degrades to pages/500.rose (status 500) - or
// the built-in plain 500 - instead of failing the whole response.
// The middleware does NOT run here: the servers run it once per request via
// runMiddleware() (which also seeds the request context), so a page render
// never re-runs it.
export async function renderPage(pathname, form) {
  clearRequestState();
  for (const route of routes) {
    if (matchRoute(route.pattern, pathname)) {
      const patternParts = route.pattern.split('/');
      const pathParts = pathname.split('/');
      for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(':')) {
          setState(patternParts[i].slice(1), pathParts[i]);
        }
      }
 // i18n: a [lang] segment naming no dictionary is a
      // 404 - the URL is the contract, and rendering the page with fallback
      // strings would serve duplicate content under a bogus language
      const langIdx = patternParts.indexOf(':lang');
      if (langIdx >= 0 && !isLocale(pathParts[langIdx])) {
        if (notFound) return { ...(await renderFallback(pathname, notFound)), status: 404 };
        return { html: '<h1>404</h1><p>Page not found</p>', state: '{}', head: [], status: 404, ...docAttrs(pathname) };
      }
 // The document's <html lang>/<dir> follow this route's locale
      // (the default's when the route is not localized)
      const docLang = langIdx >= 0 ? pathParts[langIdx] : defaultLocale;
 // The action dispatch. The page's guard (exported
      // beforeAction) runs FIRST and vetoes with an ActionError - the
      // action-level permission check. Then the selected action runs and its
      // return value seeds this render's state, per key, so an incremental
      // patch ($append and friends) grows a large list by one row instead of
      // re-sending the whole thing. An ActionError from either half is a
      // BUSINESS failure: it is seeded as the 'actionError' state, the
      // response carries its status, and the page renders with the failure
      // visible (a {#boundary} around the action's widget contains it).
      // Anything else is a bug and keeps going to the 500 page.
      let actionStatus = 0;
      if (form && route.actions) {
        const actionName = form.get('__action') || 'action';
        const fn = route.actions[actionName];
        if (fn) {
          try {
            if (route.guard) await route.guard(actionName, form);
            const patch = await fn(form);
            if (patch && typeof patch === 'object') {
              for (const key of Object.keys(patch)) {
                const v = patch[key];
                // An incremental patch is RECORDED, not applied: the render's
                // own state declarations apply it, so the delta is relative to
                // the value the page was going to render anyway.
                if (v instanceof StateDelta) setStateDelta(key, v);
                else setState(key, v);
              }
            }
          } catch (err) {
            if (err instanceof ActionError) {
              setState('actionError', { action: actionName, message: err.message, code: err.code, field: err.field });
              actionStatus = err.code;
            } else {
              throw err;
            }
          }
        }
      }
      let rendered;
      try {
        rendered = extractHead(await route.render([], ''));
      } catch (err) {
        console.error('Rosefn: render failed for', pathname, err instanceof Error ? err.message : err);
        if (errorPage) return { ...(await renderFallback(pathname, errorPage)), status: 500 };
        return { html: '<h1>500</h1><p>Something went wrong rendering this page.</p>', state: '{}', head: [], status: 500, ...docAttrs(pathname) };
      }
      // __route tells the bootstrap which route this document was rendered for.
      // A static-file server may serve another route's document (SPA fallback);
      // the bootstrap then client-renders instead of adopting mismatched DOM.
      const state = JSON.stringify({ __route: pathname, ...JSON.parse(serializeState()) });
 // csr ( auto since #29): false when the compiler found
      // nothing in the route's chain that needs the client (or the route
      // asserted csr = false) - the document ships no runtime, no state
      // script, zero JavaScript. Every other route keeps the bundle. The
      // caller passes this straight to the shell as js.
 // Status is the failed action's code when one failed - the page
      // rendered fine, so the body is the page with the failure visible, and
      // the status says what happened (a 403 from the guard, a 422 from a
      // validation action). 200 otherwise.
 // Lang/dir are the document's <html> attributes - the locale
      // this route rendered in, and its reading direction.
      return { html: rendered.html, state, head: rendered.head, status: actionStatus || 200, csr: route.csr !== false, lang: docLang, dir: localeDir(docLang) };
    }
  }
  if (notFound) {
    return { ...(await renderFallback(pathname, notFound)), status: 404 };
  }
  return { html: '<h1>404</h1><p>Page not found</p>', state: '{}', head: [], status: 404, ...docAttrs(pathname) };
}

// Would renderPageStream handle this path? (matched route = stream, anything
// else = buffered 404/500). Lets the servers pick the path before headers.
export function canStream(pathname) {
  return routes.some((route) => {
    if (!matchRoute(route.pattern, pathname)) return false;
 // i18n: an unknown locale must answer 404, and a
    // streamed response cannot change its status - so it takes the buffered
    // path (renderPage returns the real 404), never the streaming one
    const langIdx = route.pattern.split('/').indexOf(':lang');
    return langIdx < 0 || isLocale(pathname.split('/')[langIdx]);
  });
}

// === API routes ===
// The /api namespace answers JSON, never HTML: an API client that hits an
// unknown path must not receive the SPA shell. Handlers receive a
// Web-standard Request and return a plain object (serialized as JSON, 200),
// a Response (passed through), or nothing (204). A method the route does
// not export answers 405 with an Allow header. Same code path on the Node
// server and the edge adapter - Response is a global in both.
export function isApi(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function toResponse(out) {
  if (out instanceof Response) return out;
  if (out === undefined || out === null) return new Response(null, { status: 204 });
  return new Response(JSON.stringify(out), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleApi(method, pathname, request) {
  for (const route of apiRoutes) {
    if (matchRoute(route.pattern, pathname)) {
      const fn = route.handlers[method];
      if (!fn) {
        return new Response(JSON.stringify({ error: 'method not allowed' }), {
          status: 405,
          headers: { 'content-type': 'application/json', allow: Object.keys(route.handlers).join(', ') },
        });
      }
      return toResponse(await fn(request));
    }
  }
  return new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

// === Streaming SSR ===
// The static shell (doctype, <head>, body + container open) flushes BEFORE
// the - possibly slow - render completes: the first byte leaves in
// microseconds instead of after every $data resolves. The route HTML, the
// state script, and the inlined bundle follow as later chunks of one chunked
// response - still exactly one request.
// The route's <head> tags are NOT in the streamed document: the client
// applies them at boot from the body's head markers, so JS users see the
// correct head immediately; no-JS consumers of streamed responses get the
// static shell head (prerendered files stay complete documents).
// Returns 200 (matched; a render throw degrades to the error-page body) or
// 404 (unmatched - nothing written, so the caller can still buffer).
export async function renderPageStream(pathname, write, shellOpen, clientTag) {
  clearRequestState();
  for (const route of routes) {
    if (matchRoute(route.pattern, pathname)) {
      const patternParts = route.pattern.split('/');
      const pathParts = pathname.split('/');
      for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(':')) {
          setState(patternParts[i].slice(1), pathParts[i]);
        }
      }
      // i18n: an unknown locale must 404 BEFORE the shell flushes - a
      // streamed response cannot change its status afterwards
      const langIdx = patternParts.indexOf(':lang');
      if (langIdx >= 0 && !isLocale(pathParts[langIdx])) return 404;
      write(shellOpen);
      let html;
      try {
        html = extractHead(await route.render([], '')).html;
      } catch (err) {
        // the shell is already on the wire: degrade to the error page BODY
        // (the status stays 200 - a real 500 needs the buffered path, which
        // the server picks for routes known-broken at build time)
        console.error('Rosefn: render failed for', pathname, err instanceof Error ? err.message : err);
        html = errorPage ? extractHead(await errorPage([], '')).html : '<h1>500</h1><p>Something went wrong rendering this page.</p>';
      }
      write(html);
 // csr: false ( auto since #29): a no-JS route's document
      // ends here - no state script, no inlined bundle. (The servers keep
      // these routes off the streaming path so their <head> is complete;
      // this is the correctness floor if one streams anyway.)
      if (route.csr === false) {
        write('</div>\\n</body>\\n</html>');
        return 200;
      }
      const state = JSON.stringify({ __route: pathname, ...JSON.parse(serializeState()) });
      write('</div>\\n  <script type="application/json" id="__rosefn_state">' + state + '</script>\\n  ' + clientTag + '\\n</body>\\n</html>');
      return 200;
    }
  }
  return 404;
}
`;
  await fs.promises.writeFile(path.join(buildDir, 'server-entry.js'), serverEntry);
  await esbuild.build({
    entryPoints: [path.join(buildDir, 'server-entry.js')],
    bundle: true,
    outfile: path.join(outDir, 'server.js'),
    format: 'esm',
    platform: 'node',
    write: true,
    ...TS_LOADER,
  });

  const clientImports = split ? '' : compiled
    .map((_, i) => ({ i }))
    .filter(({ i }) => !infos[i].isApi && !infos[i].isMiddleware && reachable.has(i))
    .map(({ i }) => `import { render as render_${i} } from './comp-${i}.client.js';`)
    .join('\n');

  const clientRoutes = pages
    .map(({ info, i }) => (split
      ? `{ pattern: '${info.pattern}', ${loaderInner(i)} }`
      : `{ pattern: '${info.pattern}', render: ${compose(i)} }`))
    .join(',\n  ');

  const prefetchMode = compiled.find((c) => c.prefetch)?.prefetch ?? 'all';
  const vitalsOn = compiled.some((c) => c.vitals === true);
  const vitalsBlock = vitalsOn
 ? `\n// the app asked for web-vitals - measure once, at boot, and let the\n// app decide where the numbers go (one 'rosefn:vitals' CustomEvent per metric).\nreportVitals;\n`
    : '';

  const hasLang = infos.some((i) => i.pattern.includes(':lang'));
  const langDirBlock = hasLang
    ? `      // <html lang dir> follows the route - the one part of the document
      // client-side navigation cannot leave stale (screen readers and CSS
      // logical properties both read it). A route with no [lang] segment
      // returns to the default locale, and a bogus segment falls back to it
      // too, exactly like the server's docAttrs.
 // Only when this container IS the document's app root. A mount
      // (dist/mount.js) renders into a foreign page, whose language and
      // direction belong to the host, not to the mounted route.
      const seg = langIdx >= 0 ? pathname.split('/')[langIdx] : '';
      const known = !seg || isLocale(seg);
      if (container === document.getElementById('app')) {
        const docLang = known && seg ? seg : __defLocale;
        document.documentElement.lang = docLang;
        const docDir = localeDir(docLang);
        if (docDir) document.documentElement.setAttribute('dir', docDir);
        else document.documentElement.removeAttribute('dir');
      }
      if (!known) {`
    : `      if (langIdx >= 0 && !isLocale(pathname.split('/')[langIdx])) {`;

  const clientEntry = `
${clientImports}
import { setState, resumeState, clearRequestState, resetEffects, wire, isolateStateAsync, restoreState, setRefreshHook, clearMounts, flushMounts, adoptCleanups, handlers, setLocales, setLocalePacks, ensureLocale, isLocale, localeDir, setPrefetchOverride, serializeState, setFxOwner, resetContainerFx } from './runtime.js';

// i18n: the dictionaries baked at build time - the client
// renders any PRELOADED locale from the bundle, so switching language costs
// zero requests (the same bet as the inlined route table). a locale
// the app left out of the preload (i18n.preload in rosefn.config.js) is a
// pack instead: it lives at /locales/<lang>.json and applyParams() fetches it
// on first use - one request per language per session, then it renders from
// memory like any other. The default build preloads everything and ships no
// packs at all.
setLocales(${clientLocalesJson}, '${defaultLocale}');
setLocalePacks(${JSON.stringify(packed)});
${hasLang ? `// the default locale, kept beside setLocales' own copy so <html lang> can
// follow a route that carries no [lang] segment (a non-i18n page)
const __defLocale = '${defaultLocale}';` : ''}
${vitalsOn ? `// the app asked for web-vitals. The import is what keeps\n// reportVitals alive through minification and tree-shaking; the call is one\n// statement at boot, before the first render.\nimport { reportVitals } from './runtime.js';`: ''}
// The two pack doors, re-exported for an app that wants to warm a language
// before its visitor asks for it (ensureLocale) or to feed a dictionary it
// fetched itself (loadLocale). Both are already in the bundle - ensureLocale
// is what applyParams calls - so the re-export costs the statement alone.
export { ensureLocale, loadLocale } from './runtime.js';
${vitalsBlock}

const routes = [
  ${clientRoutes}
];

// === Mode B: lazy route chunks ===
// Split mode's registry entries arrive without a render function: loadChain
// loads the route's module graph (the page plus its layouts, one chunk per
// module, the shared runtime in its own vendor chunk) in parallel and
// composes it at runtime - the exact nesting compose() built at compile
// time for inline mode. getRender memoizes the composed function on the
// entry, so a chunk loads once per session; inline mode's entries are the
// render functions themselves, so the helper is a pass-through there.
const loadChain = async (loaders) => {
  const mods = await Promise.all(loaders.map((load) => load()));
  let expr = (closes, children) => mods[0].render(closes, children);
  for (let k = 1; k < mods.length; k++) {
    const inner = expr;
    const outer = mods[k].render;
    expr = async (closes, children) => await outer(closes, await inner(closes, children));
  }
  return { render: expr };
};
const getRender = async (route) => {
  if (typeof route === 'function') return route; // inline mode: the render itself
  return (route.render ??= (await route.load()).render);
};

// pages/404.rose (with its layouts) or null -> built-in plain 404
const notFound = ${notFoundRender};

// pages/500.rose (with its layouts) or null -> built-in plain 500: a route
// whose render throws on the client degrades to this instead of breaking
// navigation.
const errorPage = ${errorRender};

// Paint a fallback page (404/500) into the container, wired like any render.
async function paintFallback(container, page, builtin) {
  __navReset(container);
  clearMounts(); // a failed render leaves stale mounts behind
  // inline mode passes the render itself; split mode passes a loader
  const render = page ? await getRender(page) : null;
  if (render) {
    const closes = [];
    await __withOwner(container, async () => {
      const html = await render(closes, '');
      container.innerHTML = html;
      wire(container, closes);
      bindEvents(container);
      flushMounts();
    });
    return;
  }
  container.innerHTML = builtin;
}

export function matchRoute(pattern, pathname) {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return false;
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) continue;
    if (patternParts[i] !== pathParts[i]) return false;
  }
  return true;
}

// === Link prefetch ===
// Hover / focus / touch an internal link and the target route renders NOW -
// $data included - against a throwaway signal map. The click that follows
// paints from the cached HTML: no await, no request, no spinner. Other
// frameworks prefetch data only; Rosefn prefetches the whole render because
// the inlined bundle already contains every route.
// Trade-off: the cache holds either a result or the in-flight promise (dedupes
// hover storms); one isolated render runs at a time so signal-map swapping
// stays correct without any merging logic. Entries are single-use: a consumed
// entry disappears from the cache, which is also how tests observe a hit.
// P1, three guards for link-heavy pages:
//   1. strategy - the app declares "export const prefetch = 'off' | 'hover' |
//      'viewport' | 'all'" (root layout); 'all' is the original behavior.
// Trade-off: app-global, not per-route - per-route would carry the mode
//      in each document's shell.
//   2. budget - renders are serialized by the queue, so "concurrency" is 1;
//      the budget caps the QUEUE: a hover storm past it drops the excess
//      instead of rendering fifty routes nobody clicks.
//   3. LRU cap - unconsumed entries would otherwise live forever; the oldest
//      is evicted first (Map iteration order; entries are single-use, so
//      insertion order IS the recency order).
let prefetchMode = ${JSON.stringify(prefetchMode)};
export function setPrefetchMode(mode) { prefetchMode = mode; }
const PREFETCH_BUDGET = 8;
const PREFETCH_MAX_CACHED = 4;
const prefetchCache = new Map(); // pathname -> { html, closes, state } | Promise
let prefetchQueue = Promise.resolve();
let prefetchPending = 0;

// Applies the route's params to state. A [lang] segment whose dictionary is
// a runtime pack (i18n.preload) is awaited HERE - the one place every client
// render path goes through (navigation, prefetch, action adopt) - so a packed
// locale costs one request per session and then renders from memory. A
// preloaded locale (the default: every dictionary inline) resolves without
// touching the network, so the common path stays synchronous in spirit.
async function applyParams(route, pathname) {
  const patternParts = route.pattern.split('/');
  const pathParts = pathname.split('/');
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) setState(patternParts[i].slice(1), pathParts[i]);
  }
  const langIdx = patternParts.indexOf(':lang');
  if (langIdx >= 0) await ensureLocale(pathParts[langIdx]);
}

// The network decides too. Prefetch spends bytes BEFORE the click -
// the one thing a data-saver (navigator.connection.saveData) or a 2g link
// explicitly refuses. NetworkInformation is Chromium-only and feature-
// detected; read live per call, so a connection that upgrades mid-session is
// picked up on the next hover. Everywhere else the app's strategy stands.
function __netOk() {
  const c = navigator.connection;
  if (!c) return true;
  if (c.saveData) return false;
  const t = c.effectiveType;
  return t !== 'slow-2g' && t !== '2g';
}

export function prefetch(pathname, source = 'hover') {
  if (prefetchMode === 'off') return;
  if (prefetchMode === 'hover' && source !== 'hover') return;
  if (prefetchMode === 'viewport' && source !== 'viewport') return;
  if (!__netOk()) return; // save-data / 2g: no bytes before the click
  if (prefetchCache.has(pathname)) return;
  if (pathname === location.pathname) return; // already here: nothing to prefetch
  const route = routes.find((r) => matchRoute(r.pattern, pathname));
  if (!route) return;
  if (prefetchPending >= PREFETCH_BUDGET) return; // budget spent: drop it, a later hover retries
  // P0-1: the link may carry a query (/search?q=cats). $query() reads the
  // browser's own URL, which is the page being LEFT - so the prefetched
  // render would see the wrong one. Override it for the duration and clear
  // it after; the queue below serializes renders, so one slot is enough.
  const qi = pathname.indexOf('?');
  const qOverride = qi >= 0 ? Object.fromEntries(new URLSearchParams(pathname.slice(qi))) : null;
  const p = prefetchQueue.then(async () => {
    try {
      setPrefetchOverride(qOverride);
      // the isolated render also captures the onMount callbacks the route
      // queued and the onCleanup disposers it registered: the paint that
      // consumes this entry replays the mounts after wiring and adopts the
      // cleanups, so the prefetched route's timers are disposed on the next
      // navigation like any live route's
      const { result, state, mounts, cleanups } = await isolateStateAsync(async () => {
        await applyParams(route, pathname); // a packed locale's dictionary lands before the render
        const closes = [];
        const render = await getRender(route); // split mode: loads the route's chunk here
        const html = await render(closes, '');
        return { html, closes };
      });
      const entry = { ...result, state, mounts, cleanups };
      prefetchCache.set(pathname, entry); // promise -> result
      // evict oldest-first; in-flight promises are never evicted (evicting
      // one would only force a duplicate render)
      while (prefetchCache.size > PREFETCH_MAX_CACHED) {
        const oldest = prefetchCache.keys().next().value;
        if (prefetchCache.get(oldest) instanceof Promise) break;
        prefetchCache.delete(oldest);
      }
      return entry;
    } catch {
      prefetchCache.delete(pathname); // failed: the next hover retries
      return null;
    } finally {
      setPrefetchOverride(null);
      prefetchPending--;
    }
  });
  prefetchPending++;
  prefetchCache.set(pathname, p);
  prefetchQueue = p;
}

export function prefetchStats() {
  return { cached: prefetchCache.size, pending: prefetchPending, mode: prefetchMode, network: __netOk() };
}

// One delegated listener per event type on the app container: survives DOM
// swaps and cloned blocks, so handlers never need re-binding. A handler
// compiled from a server action (data-on-*="$action:name") dispatches to
// $action instead of the local handler registry.
const DELEGATED = ['click', 'input', 'change', 'submit'];
function bindEvents(container) {
  if (container.__rosefn_bound) return;
  container.__rosefn_bound = true;
  for (const ev of DELEGATED) {
    container.addEventListener(ev, (e) => {
      const el = e.target.closest('[data-on-' + ev + ']');
      if (!el || !container.contains(el)) return;
      const fn = el.getAttribute('data-on-' + ev);
      if (fn.startsWith('$action:')) return $action(fn.slice(8), e);
      const h = handlers[fn];
      if (h) h(e);
    });
  }
}

// === Server actions from any event ===
// POST the body to the current route and adopt the response in place: the
// server runs the selected action, seeds its state patch, and re-renders, so
// the swapped DOM is the page as it looks AFTER the action - one request, no
// reload, and wire() patches only the marked nodes (no re-render). The
// bootstrap's <form method="POST"> interception goes through the same door.
async function postForm(body, container, pathname) {
 // A mount passes its own container and route - without them the
  // POST would target the host page's URL and adopt into a #app the host
  // page does not have. The document path passes neither and gets both
  // defaults, which is exactly what it always used.
  const box = container || document.getElementById('app');
  const route = pathname || location.pathname;
  const res = await fetch(route, { method: 'POST', body });
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const next = doc.getElementById('app');
  const st = doc.getElementById('__rosefn_state');
  const paint = () => {
    adopt(box, next ? next.innerHTML : '', st ? st.textContent : '{}', route);
  };
  if (document.startViewTransition) document.startViewTransition(paint);
  else paint();
}

// Call a page's server action by name from any event handler:
// <button on:click={like}> compiles to $action('like'). Without JS the
// binding is inert - the progressive-enhancement story stays with forms.
export async function $action(name, e) {
  if (e && e.preventDefault) e.preventDefault();
  const body = new FormData();
  body.append('__action', name);
 // An event inside a mount belongs to that mount - the attribute is
  // kept in step with what is currently mounted, so the POST targets the
  // mounted route and the response lands in the mounted container. Outside a
  // mount, closest() is null and the document defaults apply.
  const box = e && e.target && e.target.closest ? e.target.closest('[data-rosefn]') : null;
  return postForm(body, box || undefined, box ? box.getAttribute('data-rosefn') : undefined);
}

export { postForm };

// The live signal graph as JSON - the same serializeState the zero-hydration
// resume uses, exported so the bootstrap's dev seam (window.__rosefn.state())
// can hand it to the dev server's reload bridge and to a devtools extension.
// A local re-export on purpose: it keeps the binding alive through minification
// for the bootstrap text appended after the bundle.
export { serializeState };

// initial=true: adopt the SSR DOM (zero hydration) - wire reactive markers to
// the existing nodes and bind events. initial=false: client-side navigation -
// re-render the route chain from scratch and wire the fresh DOM.

// One gate for the two ownership models, so they can never drift. The
// DOCUMENT's app root owns the global bookkeeping - every effect, every
// cleanup, every state key, exactly as before mounts existed. A mount
// container owns its own slice: its navigation disposes and re-seeds only
// what IT created, so a page hosting several mounts keeps them all live.
function __ownsDoc(container) {
  return container === document.getElementById('app');
}
function __navReset(container) {
  if (__ownsDoc(container)) {
    resetEffects();
    clearRequestState();
  } else {
    resetContainerFx(container);
  }
}
// Attribute everything a render creates (state keys, effects, onCleanups) to
// its container. The document path sets no owner and keeps the global sets.
async function __withOwner(container, fn) {
  if (__ownsDoc(container)) return fn();
  setFxOwner(container);
  try {
    return await fn();
  } finally {
    setFxOwner(null);
  }
}

export async function start(container, pathname, initial) {
  clearMounts(); // stale mounts from a failed render never fire
  if (initial) {
    const el = document.getElementById('__rosefn_state');
    if (el) resumeState(el.textContent);
  }
  for (const route of routes) {
    if (matchRoute(route.pattern, pathname)) {
      // i18n: an unknown locale paints the 404 page, same as the server
      // (before the prefetch check: a cached entry for a bogus locale is
      // discarded, never painted)
      const langIdx = route.pattern.split('/').indexOf(':lang');
${langDirBlock}
        await paintFallback(container, notFound, '<h1>404</h1><p>Page not found</p>');
        return;
      }
      // Prefetched on hover/focus/touch: the render already ran, so paint its
      // HTML and adopt its signal entries - events then patch the very nodes
      // we wire, and no $data re-runs on click.
      let hit = initial ? undefined : prefetchCache.get(pathname);
      if (hit && typeof hit.then === 'function') hit = await hit; // in-flight: land it first
      if (hit) {
        prefetchCache.delete(pathname); // single-use: the next hover refetches
        __navReset(container);
        restoreState(hit.state);
        container.innerHTML = hit.html;
        await __withOwner(container, () => {
          wire(container, hit.closes);
          bindEvents(container);
          hit.mounts.forEach((fn) => fn()); // the prefetched route's mounts
          adoptCleanups(hit.cleanups); // and its cleanups, for the next reset
        });
        return;
      }
      if (!initial) __navReset(container);
      let broken = false;
      await __withOwner(container, async () => {
        await applyParams(route, pathname);
        const closes = [];
        let html;
        try {
          const render = await getRender(route); // split mode: loads the route's chunk here
          html = await render(closes, '');
        } catch {
          // the route itself is broken: degrade to pages/500.rose (or the
          // built-in plain 500) instead of leaving the container empty
          broken = true;
          return;
        }
        if (!initial) container.innerHTML = html;
        wire(container, closes);
        bindEvents(container);
        flushMounts();
      });
      if (broken) {
        await paintFallback(container, errorPage, '<h1>500</h1><p>Something went wrong rendering this page.</p>');
      }
      return;
    }
  }
  // unmatched route: pages/404.rose renders (with its head + interactivity),
  // else the built-in plain 404 - and an i18n app's document returns to the
  // default locale, the same one the server stamps on its 404
${hasLang ? ` // the same app-root gate as above - a mount never touches the
  // host document's language or direction.
  if (container === document.getElementById('app')) {
    document.documentElement.lang = __defLocale;
    document.documentElement.removeAttribute('dir');
  }` : ''}
  await paintFallback(container, notFound, '<h1>404</h1><p>Page not found</p>');
}

// Adopt a server-rendered response in place - the JS-enabled half of
// progressive-enhancement forms: the bootstrap POSTs a <form method="POST">
// via fetch and hands the response here. The DOM is swapped and wired with
// the same zero-render trick as boot: re-run the route's render to rebuild
// the marker closures, wire them against the adopted nodes. The page never
// re-renders visibly, no hydration payload, no second request beyond the POST.
export async function adopt(container, html, stateJson, pathname) {
 // The route the response belongs to. A mount passes its own; the
  // document path passes nothing and keeps location.pathname.
  const route0 = pathname || location.pathname;
  __navReset(container);
  clearMounts(); // stale mounts from a failed render never fire
  resumeState(stateJson);
  container.innerHTML = html;
  // keep the embedded state in sync so a later SPA-fallback check agrees
  const st = document.getElementById('__rosefn_state');
  if (st) st.textContent = stateJson;
  for (const route of routes) {
    if (matchRoute(route.pattern, route0)) {
      await __withOwner(container, async () => {
        await applyParams(route, route0);
        const closes = [];
        try {
          const render = await getRender(route); // split mode: loads the route's chunk here
          await render(closes, '');
        } catch {
          // the adopted response's route is broken (e.g. the action's page
          // throws): keep the swapped DOM but skip wiring it
          return;
        }
        wire(container, closes);
        bindEvents(container);
        flushMounts();
      });
      return;
    }
  }
}
// === refresh() implementation ===
// Re-render the current route in place: the client half of router.refresh()
// (a router refresh) / (a full invalidation). Same machinery as a client-side
// navigation to the current path - $data re-runs, state re-seeds from the
// fresh render, wire() patches the marked nodes - but a refresh never lands
// a prefetch entry: a hover from a minute ago is exactly what it exists to
// bypass. Zero requests: the render (and its $data) runs in the page.
// Trade-off: state resets like navigation (no per-key retention); add
// retention when an app needs refresh-without-losing-input.
setRefreshHook(async () => {
  prefetchCache.delete(location.pathname);
  await start(document.getElementById('app'), location.pathname, false);
});
`;
  await fs.promises.writeFile(path.join(buildDir, 'client-entry.js'), clientEntry);
  if (split) {
    await fs.promises.rm(path.join(outDir, 'chunks'), { recursive: true, force: true });
    await esbuild.build({
      entryPoints: [path.join(buildDir, 'client-entry.js')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      minify: true,
      splitting: true,
      outdir: outDir,
      entryNames: 'client',
      chunkNames: 'chunks/[name]-[hash]',
      write: true,
      ...TS_LOADER,
    });
  } else {
    await esbuild.build({
      entryPoints: [path.join(buildDir, 'client-entry.js')],
      bundle: true,
      outfile: path.join(outDir, 'client.js'),
      format: 'esm',
      platform: 'browser',
      minify: true,
      write: true,
      ...TS_LOADER,
    });
  }

  await fs.promises.writeFile(path.join(outDir, 'mount.js'), MOUNT_ENTRY);

  await fs.promises.rm(buildDir, { recursive: true, force: true });

  const publicDir = path.join(root, 'public');
  if (fs.existsSync(publicDir)) {
    await fs.promises.cp(publicDir, path.join(outDir, 'public'), { recursive: true });
  }

  console.log('Rosefn zero-JS report:');
  for (const line of buildReport(infos, compiled)) console.log('  ' + line);
  for (const { info, i } of pages) {
    if (!routeShipsNoJs(infos, compiled, i)) continue;
    for (const ci of [i, ...layoutsOf(infos, i)]) {
      for (const w of compiled[ci].jsWarnings ?? []) {
        console.warn(`Rosefn warning: ${info.routePath} ships zero JavaScript but ${path.basename(infos[ci].filePath)} contains ${w}`);
      }
    }
  }

  return { routes: pages.map(({ info }) => info), bundle: bundleMode };
}

/** Every .rose file under <root>/src/pages, recursively (layouts and api included). */
export async function scanRoseFiles(root: string): Promise<string[]> {
  const pagesDir = path.join(root, 'src', 'pages');
  if (!fs.existsSync(pagesDir)) return [];

  async function scan(dir: string): Promise<string[]> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await scan(full)));
      else if (entry.name.endsWith('.rose')) files.push(full);
    }
    return files;
  }

  return scan(pagesDir);
}

/** Every .rose file under <root>/src/components, recursively . These
 *  are not routes: they are compiled into the same module index space as the
 *  pages so a page can `import Card from '../components/Card.rose'`. */
export async function scanComponentFiles(root: string): Promise<string[]> {
  const compDir = path.join(root, 'src', 'components');
  if (!fs.existsSync(compDir)) return [];

  async function scan(dir: string): Promise<string[]> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await scan(full)));
      else if (entry.name.endsWith('.rose')) files.push(full);
    }
    return files;
  }

  return scan(compDir);
}

function isAncestorDir(layoutPath: string, pagePath: string): boolean {
  const layoutDir = path.dirname(layoutPath);
  const pageDir = path.dirname(pagePath);
  return pageDir === layoutDir || pageDir.startsWith(layoutDir + path.sep);
}

function getRouteInfo(filePath: string, root: string): RouteInfo {
  const pagesDir = path.join(root, 'src', 'pages');
  const relative = path.relative(pagesDir, filePath).replace(/\\/g, '/');
  const withoutExt = relative.replace(/\.rose$/, '');
  const base = path.posix.basename(withoutExt);
  const isComponent = filePath.replace(/\\/g, '/').includes('/src/components/');
  const isLayout = !isComponent && base === '_layout';
  const isNotFound = !isComponent && base === '404';
  const isError = !isComponent && base === '500';
  const isApi = !isComponent && (withoutExt === 'api' || withoutExt.startsWith('api/'));
  const isMiddleware = !isComponent && withoutExt === '_middleware';

  let parts = withoutExt.split('/').filter((p) => p !== '_layout');
  if (parts.length > 1 && parts[parts.length - 1] === 'index') parts = parts.slice(0, -1);
  const routeParts = parts.map((part) =>
    part.startsWith('[') && part.endsWith(']') ? `:${part.slice(1, -1)}` : part
  );

  let routePath: string;
  if (routeParts.length === 0 || (routeParts.length === 1 && routeParts[0] === 'index')) {
    routePath = '/';
  } else {
    routePath = '/' + routeParts.join('/');
  }

  return {
    filePath,
    routePath,
    pattern: routePath,
    paramNames: parts.filter((p) => p.startsWith('[') && p.endsWith(']')).map((p) => p.slice(1, -1)),
    isLayout,
    isNotFound,
    isError,
    isApi,
    isMiddleware,
    isComponent,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
