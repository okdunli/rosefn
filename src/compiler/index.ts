// Rosefn Compiler - Compile .rose components to SSR + client-resume JS

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
const DECL_RE = /(?:let|const|var)\s+(\w+)[^=]*=\s*\$(state|data|kv|persist)\b/g;
const DECL_CAST_RE = /^\s+as\s+[^;\n]+/;
const SETSTATE_RE = /\$setState\(([^,]+),\s*([^)]+)\)/g;
const EVENT_RE = /on:(\w+)=\{([^}]+)\}/g;
const SLOT_RE = /<slot\s*\/>|<slot>([\s\S]*?)<\/slot>/g;
/** A named slot: `<slot name="row" item={post} />` . The lookahead
 *  keeps the plain `<slot />` out of it - that one is the default slot. */
const SLOT_NAMED_RE = /<slot\s+((?=[^>]*\bname\s*=)[^>]*?)(?:\/>|>([\s\S]*?)<\/slot>)/g;

// Encode a named slot tag as the template expression `__slot('row', [['item', (post)]])` - array pairs.
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
  /** the component exports `cache = N` (per-request render memo, seconds) */
  cache?: number;
  /** the component exports `csr = false` (document ships without the client bundle) */
  csr?: boolean;
  /**
   * The component exports `shell = false`: keep the client bundle (this route
   * still needs it - comments widgets, third-party scripts) but drop the
   * shell's demo dressing - the #app wrapper and STYLES_MIN. A real app ships
   * its own theme CSS; the scaffold's `body{padding:2rem}` / pink links then
   * outrank it on equal specificity. Same escape the zero-JS branch has, for
   * routes that cannot go JS-free.
   */
  shell?: boolean;
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
  /**
   * The script calls `redirect()` or `notFound()` (the control-flow pair).
   * Both are thrown signals whose answer is the RESPONSE's status - a 30x
   * with a Location, or a real 404 - and a streamed response has committed
   * its status before the render runs. Such a route is therefore buffered
   * by construction, exactly like `buffer = true`, and never prerendered.
   */
  controlSignal?: boolean;
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
  kind: 'state' | 'data' | 'kv' | 'persist';
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

// The literal that starts at `i`, if any: a quoted string, a template literal, or - the one that keeps derailing scanners - a REGEX literal.
function skipLiteral(src: string, i: number): number | null {
  const q = src[i];
  if (q === '"' || q === "'") return skipQuoted(src, i);
  if (q === '`') return skipTemplate(src, i);
  if (q !== '/') return null;
  if (src[i + 1] === '/' || src[i + 1] === '*') return null;
  let b = i - 1;
  while (b >= 0 && /\s/.test(src[b])) b--;
  if (b >= 0) {
    if (!'(,=:[!&|?{};+-*%~^'.includes(src[b])) {
      const word = /(\w+)$/.exec(src.slice(0, b + 1))?.[1] ?? '';
      if (!['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'instanceof', 'yield', 'await'].includes(word)) return null;
    }
  }
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '\n') return null;
    if (inClass) { if (c === ']') inClass = false; }
    else if (c === '[') inClass = true;
    else if (c === '/') { j++; break; }
    j++;
  }
  if (j > src.length) return null;
  while (j < src.length && /[dgimsuvy]/.test(src[j])) j++;
  return j;
}

// 's scanners are syntactic, and prose is not code: the demo's own "the same zero-JS document." (a sentence ending).
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const lit = skipLiteral(src, i);
    if (lit !== null) {
      out += src.slice(i, lit);
      i = lit;
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

// Q1 (bug report): the zero-JS scanner cried wolf on the standard isomorphic guard.
function stripGuardedBranches(src: string): string {
  const GUARD = /typeof\s+(?:window|document|navigator|location|localStorage|sessionStorage)\s*(!==|===)\s*["']undefined["']/y;
  const ws = (i: number): number => { while (i < src.length && /\s/.test(src[i])) i++; return i; };
  const ternaryColon = (q: number): number => {
    let depth = 0;
    let i = q + 1;
    while (i < src.length) {
      const c = src[i];
      const lit = skipLiteral(src, i);
      if (lit !== null) { i = lit; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { depth--; if (depth < 0) return -1; }
      else if (depth === 0 && c === ':') return i;
      else if (depth === 0 && c === '?') { const inner = ternaryColon(i); if (inner < 0) return -1; i = inner + 1; continue; }
      i++;
    }
    return -1;
  };
  const exprEnd = (i: number): number => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const lit = skipLiteral(src, i);
      if (lit !== null) { i = lit; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return i; depth--; }
      else if (depth === 0 && (c === ',' || c === ';')) return i;
      else if (depth === 0 && c === '?') { const inner = ternaryColon(i); if (inner < 0) return src.length; i = inner + 1; continue; }
      i++;
    }
    return src.length;
  };
  const braceEnd = (b: number): number => {
    let depth = 0;
    let i = b;
    while (i < src.length) {
      const c = src[i];
      const lit = skipLiteral(src, i);
      if (lit !== null) { i = lit; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return i; }
      i++;
    }
    return src.length;
  };
  const stmtEnd = (i: number): number => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const lit = skipLiteral(src, i);
      if (lit !== null) { i = lit; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return i; depth--; }
      else if (depth === 0 && (c === ';' || c === '\n')) return i;
      i++;
    }
    return src.length;
  };
  const isIfGuard = (src: string, at: number): boolean => {
    let b = at - 1;
    while (b >= 0 && /\s/.test(src[b])) b--;
    if (b < 0 || src[b] !== '(') return false;
    b--;
    while (b >= 0 && /\s/.test(src[b])) b--;
    return b >= 1 && src[b] === 'f' && src[b - 1] === 'i' && (b < 2 || !/[\w$]/.test(src[b - 2]));
  };

  const blanks: Array<[number, number]> = [];
  let i = 0;
  while (i < src.length) {
    const lit = skipLiteral(src, i);
    if (lit !== null) { i = lit; continue; }
    GUARD.lastIndex = i;
    const m = GUARD.exec(src);
    if (!m) { i++; continue; }
    const browserAfter = m[1] === '!==';
    const j = ws(i + m[0].length);
    const two = src.slice(j, j + 2);
    if (two === '&&' && browserAfter) {
      blanks.push([j + 2, exprEnd(j + 2)]);
    } else if (two === '||' && !browserAfter) {
      blanks.push([j + 2, exprEnd(j + 2)]);
    } else if (src[j] === '?') {
      const colon = ternaryColon(j);
      if (colon < 0) {
        if (browserAfter) blanks.push([j + 1, src.length]);
      } else if (browserAfter) {
        blanks.push([j + 1, colon]);
      } else {
        blanks.push([colon + 1, exprEnd(colon + 1)]);
      }
    } else if (src[j] === ')' && isIfGuard(src, i)) {
      let bodyEnd: number;
      const k = ws(j + 1);
      if (src[k] === '{') {
        bodyEnd = braceEnd(k);
        if (browserAfter) blanks.push([k + 1, bodyEnd]);
      } else {
        bodyEnd = stmtEnd(k);
        if (browserAfter) blanks.push([k, bodyEnd]);
      }
      const after = ws(bodyEnd + 1);
      if (src.startsWith('else', after)) {
        const e = ws(after + 4);
        if (src[e] === '{') {
          const close = braceEnd(e);
          if (!browserAfter) blanks.push([e + 1, close]);
        } else {
          const stop = stmtEnd(e);
          if (!browserAfter) blanks.push([e, stop]);
        }
      }
    }
    i = j;
  }
  if (blanks.length === 0) return src;
  const out = [...src];
  for (const [a, b] of blanks) {
    for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  }
  return out.join('');
}

// The <script> block of a .rose source, verbatim.
export function scriptOf(source: string): string | null {
  return source.match(COMPONENT_RE)?.[1] ?? null;
}

// The per-request bag the runtime hooks receive.
export interface RequestHookContext {
  request: Request;
  url: URL;
  method: string;
  pathname: string;
  state: Record<string, unknown>;
}


export interface StoreBridge {
  /** Install the sender: every $store write in this worker calls it. Pass null to detach. */
  install(send: ((name: string, value: unknown) => void) | null): void;
  /** Apply a patch that arrived from another process or machine. */
  deliver(name: string, value: unknown): void;
}


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


export interface I18nConfig {
  preload?: string[];
}

export interface RosefnConfig {
  plugins: Plugin[];
  i18n: I18nConfig;
}


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
function wireEventBindings(template: string, actionNames: Set<string>, filePath = '<template>'): {
  template: string;
  bindings: Array<{ event: string; fn: string }>;
} {
  const bindings: Array<{ event: string; fn: string }> = [];
  let out = '';
  let rest = template;
  const TARGET_MODS: Record<string, string> = { window: 'w', document: 'd' };
  const MOD_PRE: Record<string, (p: string) => string> = {
    preventDefault: () => 'e.preventDefault()',
    stopPropagation: () => 'e.stopPropagation()',
    self: (p) => `const __self = e.target.closest && e.target.closest('[data-${p}-' + e.type + ']'); if (__self && e.target !== __self) return;`,
  };
  const MOD_POST: Record<string, (p: string) => string> = {
    once: (p) => `const __o = e.target && e.target.closest ? e.target.closest('[data-${p}-' + e.type + ']') : null; if (__o) __o.removeAttribute('data-${p}-' + e.type);`,
  };
  const KNOWN_MODS: string[] = [...Object.keys(MOD_PRE), ...Object.keys(MOD_POST), ...Object.keys(TARGET_MODS)];
  for (;;) {
    const m = /\bon:(\w+)((?:\|\w+)*)\s*=\s*\{/.exec(rest);
    if (!m) {
      out += rest;
      break;
    }
    const mods = m[2] ? m[2].slice(1).split('|') : [];
    const targets = mods.filter((mod) => TARGET_MODS[mod]);
    if (targets.length > 1) {
      throw new RoseError(
        'E-TEMPLATE',
        `${filePath}: on:${m[1]} carries both |${targets.join(' and |')}`,
        { hint: 'a handler binds to one target - the element (default), |window or |document' },
      );
    }
    const prefix = targets.length ? 'on' + TARGET_MODS[targets[0]] : 'on';
    for (const mod of mods) {
      if (!KNOWN_MODS.includes(mod)) {
        throw new RoseError(
          'E-TEMPLATE',
          `${filePath}: unknown event modifier |${mod}`,
          { hint: `the supported modifiers are ${KNOWN_MODS.map((k) => '|' + k).join(' ')} - capture/passive are listener options a delegated listener cannot carry per element; anything else belongs inside the handler body` },
        );
      }
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
    const wrap = (body: string): string => {
      if (!mods.length) return body;
      const pre = mods.filter((mod) => MOD_PRE[mod]).map((mod) => MOD_PRE[mod](prefix));
      const post = mods.filter((mod) => MOD_POST[mod]).map((mod) => MOD_POST[mod](prefix));
      return `(e) => {${pre.length ? ' ' + pre.join('; ') + ';' : ''} (${body})(e);${post.length ? ' ' + post.join('; ') + ';' : ''} }`;
    };
    if (mods.length && actionNames.has(expr)) {
      throw new RoseError(
        'E-TEMPLATE',
        `${filePath}: event modifiers are not supported on the server action ${expr}`,
        { hint: '$action already preventDefaults - drop the modifiers, or bind a local handler that calls $action' },
      );
    }
    if (mods.length) {
      const name = `__h${bindings.length}`;
      out += `data-${prefix}-${m[1]}="${name}"`;
      bindings.push({ event: m[1], fn: `${name}: ${wrap(expr)}` });
    } else if (actionNames.has(expr)) {
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
  const cacheMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+cache\s*=\s*(\d+)\s*;?/);
  const cacheSeconds = cacheMatch ? Number(cacheMatch[1]) : undefined;
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
  const shellMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+shell\s*=\s*(true|false)\s*;?/);
  const shell: boolean | undefined = shellMatch ? shellMatch[1] !== 'false' : undefined;
  const bufferMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+buffer\s*=\s*(true|false)\s*;?/);
  const buffer: boolean | undefined = bufferMatch ? bufferMatch[1] !== 'false' : undefined;
  const controlSignal = /\b(?:redirect|notFound)\s*\(/.test(rawScript) || undefined;
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
  if (source.includes('{#defer')) clientReasons.push('{#defer} progressive content');
  if (source.includes('{#await')) clientReasons.push('{#await} async block');
  const needsClient = clientReasons.length > 0;

  const jsWarnings: string[] = [];
  if (!needsClient) {
    const codeOnly = stripComments(source);
    const scriptCodeOnly = stripComments(rawScript);
    const scriptScannable = stripGuardedBranches(scriptCodeOnly);
    if (/\son[a-z]+\s*=\s*["'][^"']*["']/i.test(codeOnly)) {
      jsWarnings.push('an inline on* attribute (e.g. onclick="...") - it cannot fire without the bundle; use on:click or set csr = true');
    }
    if (/javascript:/i.test(codeOnly)) {
      jsWarnings.push('a javascript: URL - it needs the bundle to run; link to a real route');
    }
    if (/\b(?:eval|new Function)\s*\(/.test(scriptScannable)) {
      jsWarnings.push('eval()/new Function() - client code the predicate cannot see');
    }
    if (/\b(?:document|window|localStorage|sessionStorage)\s*\.|\b(?:add|remove)EventListener\s*\(|\brequestAnimationFrame\s*\(|\bMutationObserver\b|\bnavigator\s*\.|\blocation\s*\.\s*(?:href|assign|replace|reload|pathname|search|hash|origin)\b|\b(?:setTimeout|setInterval)\s*\(/.test(scriptScannable)) {
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
  const stateDecls = decls.filter((d) => d.kind === 'state' || d.kind === 'kv' || d.kind === 'persist');

  const setterNames = new Map<string, string>();
  stateDecls.forEach((s) => setterNames.set(s.name, `set${capitalize(s.name)}`));

  const declCode = (d: (typeof decls)[number]): string => {
    const key = isComponent ? `${scopeKey}:${d.name}` : d.name;
    if (d.kind === 'state') {
      return `const [${d.name}, ${setterNames.get(d.name)!}] = state(${JSON.stringify(key)}, ${d.expr});`;
    }
    const isFn = d.expr.includes('=>') || d.expr.startsWith('function');
    const fn = isFn ? d.expr : `() => (${d.expr})`;
    if (d.kind === 'persist') {
      return `const [${d.name}, ${setterNames.get(d.name)!}] = persistState(${JSON.stringify(key)}, ${d.expr});`;
    }
    if (d.kind === 'kv') {
      const mTtl = /^(.*)\s*,\s*(\d+)\s*$/s.exec(d.expr);
      const fnExpr = mTtl ? mTtl[1] : d.expr;
      const ttl = mTtl ? mTtl[2] : '300';
      return `const __had_${d.name} = hasState(${JSON.stringify(key)});
const [${d.name}, set${capitalize(d.name)}] = state(${JSON.stringify(key)}, null);
if (!__had_${d.name}) set${capitalize(d.name)}(await globalThis.__rosefnKvApi.kvMemo(${JSON.stringify('__kvh:' + scopeKey + ':' + d.name)}, ${fnExpr}, ${ttl}));`;
    }
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
  const imgDefaulted = templateCalled
    .replace(/<img\b(?![^>]*?\sloading=)/gi, '<img loading="lazy"')
    .replace(/<img\b(?![^>]*?\sdecoding=)/gi, '<img decoding="async"')
  const wired = wireEventBindings(imgDefaulted, actionNames, filePath);

  const stateKeys = decls.map((d) => d.name);

  const bindBindings: Array<{ event: string; fn: string }> = [];
  let bindCounter = 0;
  const bindExpanded = wired.template.replace(
    /\sbind:(value|checked|this)\s*=\s*\{([\w$]+)(?:\(\))?\}/g,
    (whole, kind: string, name: string) => {
      if (!stateKeys.includes(name)) {
        throw new Error(
          `${filePath}: bind:${kind}={${name}} must name a $state declaration` +
            (stateKeys.length ? ` (state keys here: ${stateKeys.join(', ')})` : ' (this file declares no $state)'),
        );
      }
      if (kind === 'this') return ` data-bind-this="${name}"`;
      const setter = setterNames.get(name)!;
      const evt = kind === 'checked' ? 'change' : 'input';
      const hname = `__rvbind_${scopeKey.replace(/\W/g, '_')}_${bindCounter++}`;
      bindBindings.push({
        event: evt,
        fn:
          kind === 'checked'
            ? `${hname}: (e) => ${setter}(e.target.checked)`
            : `${hname}: (e) => { const t = e.target; ${setter}(t.type === 'number' || t.type === 'range' ? t.valueAsNumber : t.value); }`,
      });
      const evtAttr = kind === 'checked'
        ? ` data-on-change="${hname}"`
        : ` data-on-input="${hname}" data-on-change="${hname}"`;
      return ` ${kind}={${name}()}${evtAttr}`;
    },
  );

  const comps = new Map(roseImports.map((r) => {
    const abs = path.resolve(path.dirname(filePath), r.specifier);
    const hit = registry.get(abs)!;
    return [r.name, { index: hit.index, slots: hit.slots }] as const;
  }));
  const groupBindings: Array<{ event: string; fn: string }> = [];
  let groupCounter = 0;
  const TAG_SCAN_RE = /<([a-zA-Z][^\s>/]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const groupExpanded = (() => {
    if (!bindExpanded.includes('bind:group')) return bindExpanded;
    let out = '';
    let pos = 0;
    let m: RegExpExecArray | null;
    TAG_SCAN_RE.lastIndex = 0;
    while ((m = TAG_SCAN_RE.exec(bindExpanded))) {
      const [whole, tag, attrs, selfClose] = m;
      const gm = /\sbind:group\s*=\s*\{([\w$]+)(?:\(\))?\}/.exec(attrs);
      if (!gm) continue;
      const name = gm[1];
      if (!stateKeys.includes(name)) {
        throw new RoseError(
          'E-TEMPLATE',
          `${filePath}: bind:group={${name}} must name a $state declaration`,
          { hint: 'the group state holds the selected value (radio) or an ARRAY of checked values (checkbox) - declare it: let ' + name + ' = $state("")' },
        );
      }
      if (!/\stype\s*=\s*["'](radio|checkbox)["']/.test(attrs)) {
        throw new RoseError(
          'E-TEMPLATE',
          `${filePath}: bind:group is for radio and checkbox inputs`,
          { hint: '<input type="radio" value="v" bind:group={state}> holds the selected value; type="checkbox" holds an ARRAY of the checked values (declare the state as $state([]))' },
        );
      }
      const isArrayGroup = /\stype\s*=\s*["']checkbox["']/.test(attrs);
      const vm = /\svalue\s*=\s*"([^"]*)"|\svalue\s*=\s*'([^']*)'/.exec(attrs);
      if (!vm || /\{/.test(vm[0])) {
        throw new RoseError(
          'E-TEMPLATE',
          `${filePath}: a bind:group input needs a static value attribute`,
          { hint: '<input type="radio" value="free" bind:group={plan}> - the value IS what the state receives' },
        );
      }
      if (/\schecked\s*=/.test(attrs)) {
        throw new RoseError(
          'E-TEMPLATE',
          `${filePath}: a bind:group input cannot also carry checked=`,
          { hint: 'the group state alone decides which inputs are checked' },
        );
      }
      const setter = setterNames.get(name)!;
      const hname = `__rvbg_${scopeKey.replace(/\W/g, '_')}_${groupCounter++}`;
      const groupValue = JSON.stringify(vm[1] ?? vm[2]);
      const checkedExpr = isArrayGroup
        ? `${name}().includes(${groupValue})`
        : `${name}() === ${groupValue}`;
      const handlerBody = isArrayGroup
        ? `${setter}(e.target.checked ? [...${name}(), ${groupValue}] : ${name}().filter((x) => x !== ${groupValue}))`
        : `${setter}(e.target.value)`;
      groupBindings.push({ event: 'change', fn: `${hname}: (e) => { ${handlerBody}; }` });
      const newAttrs = attrs.replace(gm[0], ` checked={${checkedExpr}} data-on-change="${hname}"`);
      out += bindExpanded.slice(pos, m.index) + `<${tag}${newAttrs}${selfClose}>`;
      pos = m.index + whole.length;
    }
    if (pos === 0) return bindExpanded;
    out += bindExpanded.slice(pos);
    return out;
  })();
  const eventBindings = wired.bindings.concat(bindBindings, groupBindings);
  const useExpanded = groupExpanded.replace(
    /\suse:([\w-]+)(\s*=\s*\{([\s\S]*?)\})?/g,
    (_w, name: string, hasParam: string | undefined, expr: string) =>
      hasParam
        ? ` data-use="${name}" data-use-param={JSON.stringify(${expr})}`
        : ` data-use="${name}"`,
  );
  const classExpanded = expandClassDirectives(useExpanded, filePath);
  const styleExpanded = expandStyleDirectives(classExpanded, filePath);
  const transExpanded = expandTransitionDirectives(styleExpanded, filePath);
  const animExpanded = expandAnimateDirectives(transExpanded, filePath);
  const keyExpanded = expandKeyBlocks(animExpanded, filePath);
  const elseExpanded = expandIfElse(keyExpanded);
  const deferExpanded = expandDeferBlocks(elseExpanded);
  const awaitExpanded = expandAwaitBlocks(deferExpanded.template, filePath);
  const fbExpanded = expandBoundaryFallbacks(awaitExpanded.template, filePath);
  const ssrTemplate = rewriteQuotedExprAttrs(fbExpanded
    .replace(SLOT_NAMED_RE, (_w: unknown, attrs: string, fallback: string) => {
      const call = `{__slot(${encodeSlotCall(attrs)})}`;
      if (fallback) {
        if (/\{[^{}]*\}/.test(fallback)) {
          throw new RoseError(
            'E-TEMPLATE',
            `${filePath}: slot fallback content must be static markup`,
            { hint: 'a {expr} inside a slot fallback has no reactive scope here - render the dynamic part in the parent and pass it as the slot content' },
          );
        }
        return `{__slot(${encodeSlotCall(attrs)}, ${JSON.stringify(fallback)})}`;
      }
      return call;
    })
    .replace(SLOT_RE, (_w: unknown, fallback: string) =>
      fallback && fallback.trim()
        ? `{__slotDefault(${JSON.stringify(fallback)})}`
        : '{__slot__}'), comps);
  assertKnownDirectives(ssrTemplate, filePath);
  const compiledTemplate = compileTemplate(ssrTemplate, 'h', '__c', null, 0, true, comps);
  const compiledHead = headContent.trim() ? compileHead(headContent) : '';
  const hasNamedSlots = /<slot\s+[^>]*\bname\s*=/.test(template);

  const ssrExports = actions.length > 0 ? `${exportStmts}\n${actions.map((a) => a.stmt).join('\n')}` : exportStmts;
  const ssrGuard = guard ? `\n${guard}` : '';
  const isMiddleware = path.basename(filePath) === '_middleware.rose';
  const bootCode = deferBootCode(deferExpanded.count, deferExpanded.holds)
    + (awaitExpanded.blocks.length ? '\n' + awaitBootCode(awaitExpanded.blocks) : '');
  const ssr = isMiddleware
    ? `${RUNTIME_IMPORTS}\n\n${importStmts}\n\n${ssrExports}\n${ssrGuard}\n\n${cleanScript}\n`
    : generateSSR(cleanScript + bootCode, compiledTemplate, stateDeclsCode, ssrExports, compiledHead, props, hasNamedSlots, importStmts, isComponent, ssrGuard, actions.length > 0, dataDeclsCode);
  const client = generateClient(cleanScript + bootCode, compiledTemplate, stateDeclsCode, eventBindings, exportStmts, compiledHead, props, hasNamedSlots, importStmts, isComponent, dataDeclsCode);

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
    cache: cacheSeconds,
    csr,
    shell,
    buffer,
    controlSignal,
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

const REGEX_PRECEDERS = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
function isRegexStart(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const p = src[j];
  if (REGEX_PRECEDERS.has(p)) return true;
  if (/[A-Za-z0-9_$]/.test(p)) {
    const w = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(src.slice(0, j + 1));
    if (!w) return false;
    return ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else'].includes(w[1]);
  }
  return false;
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
      kind: m[2] as 'state' | 'data' | 'persist',
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
    if (ch === '/' && isRegexStart(src, i)) {
      i++;
      let inClass = false;
      while (i < index) {
        const c2 = src[i];
        if (c2 === '\\') { i += 2; continue; }
        if (inClass) { if (c2 === ']') inClass = false; i++; continue; }
        if (c2 === '[') { inClass = true; i++; continue; }
        if (c2 === '/') { i++; break; }
        if (c2 === '\n') break;
        i++;
      }
      while (i < index && /[a-z]/.test(src[i])) i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return depth;
}

// Compile a .rose template to statements that build an HTML string with reactive markers, and push update closures into the shared `closes` array.


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

const DEFER_ENABLED = true;

/**
 * F4 ({#key} block): `{#key expr}body{/key}` re-creates the body whenever
 * `expr` changes - the escape hatch for DOM whose local state must reset
 * (a form re-keyed by its subject, a chart re-keyed by its dataset).
 * Pure compiler sugar: it desugars to `{#each [expr] as __rvkv}body{/each}` -
 * the each's items closure reads expr, so any dependency change re-runs the
 * map and rebuilds every node, which IS key semantics. Zero runtime change.
 * Unclosed blocks fail loudly here instead of rendering as prose.
 */
function expandKeyBlocks(template: string, filePath: string): string {
  if (!template.includes('{#key')) return template;
  for (let pass = 0; pass < 10; pass++) {
    const OPEN_RE = /\{#key\s+([^}]+)\}/g;
    OPEN_RE.lastIndex = 0;
    const openM = OPEN_RE.exec(template);
    if (!openM) return template;
    const expr = openM[1].trim();
    const bodyStart = openM.index + openM[0].length;
    const TOK_RE = /\{[#\/](?:key|if|each|boundary|island)\b[^}]*\}/g;
    TOK_RE.lastIndex = bodyStart;
    let depth = 1;
    let closeAt = -1;
    let tm: RegExpExecArray | null;
    while ((tm = TOK_RE.exec(template))) {
      if (tm[0].startsWith('{#')) { depth++; continue; }
      depth--;
      if (depth === 0) { closeAt = tm.index; break; }
    }
    if (closeAt < 0) {
      throw new RoseError(
        'E-TEMPLATE',
        `${filePath}: {#key ${expr}} is never closed`,
        { hint: 'every {#key} needs its {/key}' },
      );
    }
    template =
      template.slice(0, openM.index) +
      `{#each [${expr}] as __rvkv}` +
      template.slice(bodyStart, closeAt) +
      '{/each}' +
      template.slice(closeAt + '{/key}'.length);
  }
  return template;
}

/**
 * F2 (ergonomics): `{:else}` and `{:else if cond}` on {#if} blocks - the
 * branch syntax every other template language has, retracted here after the
 * author judged the earlier refusal over-strict. One pass walks every {#if}
 * block, splits its TOP-LEVEL `{:else}` chain (nested blocks' elses are
 * theirs), and re-emits the block as complementary {#if}s:
 *   {#if A}a{:else}b{/if}   -> {#if A}a{/if}{#if !(A)}b{/if}
 *   {#if A}a{:else if B}b{:else}c{/if}
 *                           -> {#if A}a{/if}{#if !(A)}{#if B}b{/if}{#if !(B)}c{/if}{/if}
 * Zero new runtime, zero new marker kinds: wire()/ifMark already adopt and
 * flip both shapes, and each condition re-evaluates - free for the pure
 * state reads that are the only legal condition kind here. Runs BEFORE
 * defer expansion (so a {:else} inside a {#defer} body lands on expanded
 * ground) and repeated until stable, because nested ifs with their own
 * elses surface one level per pass. Defer bodies are transparent to the
 * depth walk on purpose: {#defer} is not a block kind, and every {#if}
 * inside it is balanced on its own.
 */
function expandIfElseOnce(template: string): { template: string; changed: boolean } {
  const TOK_RE = /\{#(?:if|each|boundary|island)\b[^}]*\}|\{\/(?:if|each|boundary|island)\s*\}|\{:else(?:\s+if\s+[^}]*)?\}/g;
  let out = '';
  let pos = 0;
  let changed = false;
  for (;;) {
    const openM = /\{#(if|each)\s+([^}]+)\}/g.exec(template.slice(pos));
    if (!openM) { out += template.slice(pos); break; }
    const kind = openM[1];
    const head = openM[2];
    const start = pos + openM.index;
    const cond = kind === 'if' ? head.trim() : '';
    const bodyStart = start + openM[0].length;
    out += template.slice(pos, start);

    TOK_RE.lastIndex = bodyStart;
    let depth = 1;
    let closeAt = -1;
    let closeLen = 0;
    const elses: Array<{ at: number; len: number; cond: string | null }> = [];
    let tm: RegExpExecArray | null;
    while ((tm = TOK_RE.exec(template))) {
      const tok = tm[0];
      if (tok.startsWith('{:else')) {
        if (depth === 1) {
          const condM = /^\{:else\s+if\s+([^}]*)\}$/.exec(tok);
          elses.push({ at: tm.index, len: tok.length, cond: condM ? condM[1].trim() : null });
        }
        continue;
      }
      if (tok.startsWith('{#')) { depth++; continue; }
      depth--;
      if (depth === 0) { closeAt = tm.index; closeLen = tok.length; break; }
    }
    if (closeAt < 0 || elses.length === 0) {
      out += template.slice(start, closeAt < 0 ? template.length : closeAt + closeLen);
      if (closeAt < 0) break;
      pos = closeAt + closeLen;
      continue;
    }
    const body = template.slice(bodyStart, closeAt);
    if (kind === 'each') {
      const lastBare = [...elses].reverse().find((e) => e.cond === null);
      if (!lastBare) {
        out += template.slice(start, closeAt + closeLen);
        pos = closeAt + closeLen;
        continue;
      }
      const relLast = lastBare.at - bodyStart;
      const eachBody = body.slice(0, relLast);
      const elseBody = body.slice(relLast + lastBare.len);
      const itemsExpr = head.replace(/\s+as\s+[\w,\s]*$/, '').trim();
      out += template.slice(start, bodyStart) + eachBody + '{/each}'
        + `{#if !(${itemsExpr}.length)}${elseBody}{/if}`;
      pos = closeAt + closeLen;
      changed = true;
      continue;
    }
    const branches: Array<{ cond: string | null; body: string }> = [];
    let cursor = 0;
    for (let i = 0; i < elses.length; i++) {
      const e = elses[i];
      const rel = e.at - bodyStart;
      branches.push({ cond: i === 0 ? null : elses[i - 1].cond, body: body.slice(cursor, rel) });
      cursor = rel + e.len;
    }
    branches.push({ cond: elses[elses.length - 1].cond, body: body.slice(cursor) });
    const first = branches.shift()!;
    const build = (bs: Array<{ cond: string | null; body: string }>): string => {
      if (!bs.length) return '';
      const head = bs[0];
      const rest = bs.slice(1);
      if (head.cond == null) return head.body;
      let s = `{#if ${head.cond}}${head.body}{/if}`;
      if (rest.length) s += `{#if !(${head.cond})}` + build(rest) + `{/if}`;
      return s;
    };
    let emitted = `{#if ${cond}}${first.body}{/if}`;
    if (branches.length) emitted += `{#if !(${cond})}` + build(branches) + `{/if}`;
    out += emitted;
    pos = closeAt + closeLen;
    changed = true;
  }
  return { template: out, changed };
}

/**
 * F2c (class: directive): `class:NAME={expr}` merges with the tag's static
 * class into ONE reactive class attribute whose closure concatenates the
 * static value plus each conditional segment - one attrMark, one data-b
 * marker, all conditions re-evaluated together on every toggle. This runs
 * AFTER callifyTemplateExprs, so the expressions arrive pre-callified and
 * are re-emitted verbatim inside a template literal. A tag that already
 * carries a REACTIVE class={...} cannot merge (two writers, one attribute)
 * and fails here, at the .rose file.
 */
function expandClassDirectives(template: string, filePath: string): string {
  if (!template.includes('class:')) return template;
  const TAG_RE = /<([a-zA-Z][^\s>/]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let out = '';
  let pos = 0;
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(template))) {
    const [whole, tag, attrs, selfClose] = m;
    if (!attrs.includes('class:')) continue;
    const pairs: Array<{ name: string; expr: string; start: number; end: number }> = [];
    const NAME_RE = /\sclass:([\w-]+)\s*=\s*\{/g;
    let nm: RegExpExecArray | null;
    while ((nm = NAME_RE.exec(attrs))) {
      let i = nm.index + nm[0].length;
      let depth = 1;
      while (i < attrs.length && depth > 0) {
        const ch = attrs[i];
        if (ch === '"' || ch === "'") { i = skipQuoted(attrs, i); continue; }
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
      }
      if (depth !== 0) {
        throw new RoseError('E-TEMPLATE', `${filePath}: class:${nm[1]}={...} is missing its closing brace`, { file: filePath, hint: 'the binding expression needs a matching } before the tag ends' });
      }
      pairs.push({ name: nm[1], expr: attrs.slice(nm.index + nm[0].length, i - 1), start: nm.index, end: i });
    }
    const clsRe = /(\sclass\s*=\s*)("([^"]*)"|'([^']*)'|\{[^}]*\})/;
    const clsM = clsRe.exec(attrs);
    if (clsM && clsM[2].startsWith('{')) {
      throw new RoseError('E-TEMPLATE', `${filePath}: <${tag}> has both class={...} and class: directives`, { file: filePath, hint: 'merge them: move the dynamic part into a class:NAME={expr} and keep the rest in class="..."' });
    }
    const staticCls = clsM ? (clsM[3] ?? clsM[4] ?? '') : '';
    let closure = `(${JSON.stringify(staticCls)}`;
    for (const p of pairs) {
      closure += `+((${p.expr})?${JSON.stringify(' ' + p.name)}:'')`;
    }
    closure += `)`;
    let newAttrs = attrs;
    for (let k = pairs.length - 1; k >= 0; k--) {
      newAttrs = newAttrs.slice(0, pairs[k].start) + newAttrs.slice(pairs[k].end);
    }
    if (clsM) {
      newAttrs = newAttrs.replace(clsRe, ` class={${closure}}`);
    } else {
      newAttrs = ` class={${closure}}` + newAttrs;
    }
    out += template.slice(pos, m.index) + `<${tag}${newAttrs}${selfClose}>`;
    pos = m.index + whole.length;
  }
  if (pos === 0) return template;
  out += template.slice(pos);
  return out;
}

/**
 * F2f (style: directive): `style:PROP={expr}` merges with the tag's static
 * style into ONE reactive style attribute - the overrides are appended AFTER
 * the static declarations, so CSS last-wins makes them authoritative, exactly
 * the expected precedence. Same quote-aware tag scanner and same
 * reactive-class={...} conflict rule as expandClassDirectives.
 */

/**
 * F20: `transition:fn` - enter/leave transitions.
 *
 * A `transition:fn` directive on an element tells the runtime to animate it
 * in (on mount) and out (on unmount). The directive is parsed here at build
 * time and emitted as a `data-transition` attribute the runtime reads to
 * pick the transition effect. Built-in transitions (fade, slide, fly) are
 * registered in the runtime and applied through the `transition()` helper.
 *
 * Syntax: `transition:fn` or `transition:fn={params}`.
 *
 * Example: `<div transition:fade>` or `<div transition:fade={duration: 300}>`.
 */
function expandTransitionDirectives(template: string, filePath: string): string {
  if (!template.includes('transition:')) return template;
  const TAG_RE = /<([a-zA-Z][^\s>/]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let out = '';
  let pos = 0;
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(template))) {
    const [whole, tag, attrs, selfClose] = m;
    if (!attrs.includes('transition:')) continue;
    const pairs: Array<{ name: string; params: string; start: number; end: number }> = [];
    const NAME_RE = /\stransition:([\w-]+)(?:\s*=\s*\{)?/g;
    let nm: RegExpExecArray | null;
    while ((nm = NAME_RE.exec(attrs))) {
      let start = nm.index;
      let end = nm.index + nm[0].length;
      let params = '';
      if (nm[0].endsWith('{')) {
        let depth = 1;
        let i = end;
        while (i < attrs.length && depth > 0) {
          const ch = attrs[i];
          if (ch === '"' || ch === "'") { i = skipQuoted(attrs, i); continue; }
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
          i++;
        }
        if (depth !== 0) {
          throw new RoseError('E-TEMPLATE', `${filePath}: transition:${nm[1]}={...} is missing its closing brace`, { file: filePath, hint: 'the transition params expression needs a matching } before the tag ends' });
        }
        params = attrs.slice(end, i - 1);
        end = i;
      }
      pairs.push({ name: nm[1], params, start, end });
    }
    let transitionValue = '';
    for (const p of pairs) {
      if (transitionValue) transitionValue += '|';
      transitionValue += p.name + (p.params ? ':' + p.params : '');
    }
    let newAttrs = attrs;
    for (let k = pairs.length - 1; k >= 0; k--) {
      newAttrs = newAttrs.slice(0, pairs[k].start) + newAttrs.slice(pairs[k].end);
    }
    const transRe = /\sdata-transition\s*=\s*("([^"]*)"|'([^']*)'|\{[^}]*\})/;
    const tm = transRe.exec(newAttrs);
    if (tm) {
      const existing = tm[2] ?? tm[3] ?? '';
      newAttrs = newAttrs.replace(transRe, ` data-transition="${existing}${transitionValue ? (existing ? '|' : '') + transitionValue : ""}"`);
    } else {
      newAttrs = ` data-transition="${transitionValue}"` + newAttrs;
    }
    out += template.slice(pos, m.index) + `<${tag}${newAttrs}${selfClose}>`;
    pos = m.index + whole.length;
  }
  out += template.slice(pos);
  return out;
}

/**
 * F21: `animate:fn` - FLIP (First/Last/Invert/Play) animations.
 *
 * A `animate:fn` directive on an element tells the runtime to animate it
 * when its position changes (e.g., list reordering). The directive is parsed
 * here at build time and emitted as a `data-animate` attribute the runtime
 * reads to pick the animation effect. Built-in animations (flip) are
 * registered in the runtime and applied through the `animate()` helper.
 *
 * Syntax: `animate:fn` or `animate:fn={params}`.
 *
 * Example: `<div animate:flip>` or `<div animate:flip={duration: 300}>`.
 */
function expandAnimateDirectives(template: string, filePath: string): string {
  if (!template.includes('animate:')) return template;
  const TAG_RE = /<([a-zA-Z][^\s>/]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let out = '';
  let pos = 0;
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(template))) {
    const [whole, tag, attrs, selfClose] = m;
    if (!attrs.includes('animate:')) continue;
    const pairs: Array<{ name: string; params: string; start: number; end: number }> = [];
    const NAME_RE = /\sanimate:([\w-]+)(?:\s*=\s*\{)?/g;
    let nm: RegExpExecArray | null;
    while ((nm = NAME_RE.exec(attrs))) {
      let start = nm.index;
      let end = nm.index + nm[0].length;
      let params = '';
      if (nm[0].endsWith('{')) {
        let depth = 1;
        let i = end;
        while (i < attrs.length && depth > 0) {
          const ch = attrs[i];
          if (ch === '"' || ch === "'") { i = skipQuoted(attrs, i); continue; }
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
          i++;
        }
        if (depth !== 0) {
          throw new RoseError('E-TEMPLATE', `${filePath}: animate:${nm[1]}={...} is missing its closing brace`, { file: filePath, hint: 'the animate params expression needs a matching } before the tag ends' });
        }
        params = attrs.slice(end, i - 1);
        end = i;
      }
      pairs.push({ name: nm[1], params, start, end });
    }
    let animateValue = '';
    for (const p of pairs) {
      if (animateValue) animateValue += '|';
      animateValue += p.name + (p.params ? ':' + p.params : '');
    }
    let newAttrs = attrs;
    for (let k = pairs.length - 1; k >= 0; k--) {
      newAttrs = newAttrs.slice(0, pairs[k].start) + newAttrs.slice(pairs[k].end);
    }
    const animRe = /\sdata-animate\s*=\s*("([^"]*)"|'([^']*)'|\{[^}]*\})/;
    const am = animRe.exec(newAttrs);
    if (am) {
      const existing = am[2] ?? am[3] ?? '';
      newAttrs = newAttrs.replace(animRe, ` data-animate="${existing}${animateValue ? (existing ? '|' : '') + animateValue : ""}"`);
    } else {
      newAttrs = ` data-animate="${animateValue}"` + newAttrs;
    }
    out += template.slice(pos, m.index) + `<${tag}${newAttrs}${selfClose}>`;
    pos = m.index + whole.length;
  }
  out += template.slice(pos);
  return out;
}

function expandStyleDirectives(template: string, filePath: string): string {
  if (!template.includes('style:')) return template;
  const TAG_RE = /<([a-zA-Z][^\s>/]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let out = '';
  let pos = 0;
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(template))) {
    const [whole, tag, attrs, selfClose] = m;
    if (!attrs.includes('style:')) continue;
    const pairs: Array<{ prop: string; expr: string; start: number; end: number }> = [];
    const NAME_RE = /\sstyle:([\w-]+)\s*=\s*\{/g;
    let nm: RegExpExecArray | null;
    while ((nm = NAME_RE.exec(attrs))) {
      let i = nm.index + nm[0].length;
      let depth = 1;
      while (i < attrs.length && depth > 0) {
        const ch = attrs[i];
        if (ch === '"' || ch === "'") { i = skipQuoted(attrs, i); continue; }
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
      }
      if (depth !== 0) {
        throw new RoseError('E-TEMPLATE', `${filePath}: style:${nm[1]}={...} is missing its closing brace`, { file: filePath, hint: 'the binding expression needs a matching } before the tag ends' });
      }
      pairs.push({ prop: nm[1], expr: attrs.slice(nm.index + nm[0].length, i - 1), start: nm.index, end: i });
    }
    const styleRe = /(\sstyle\s*=\s*)("([^"]*)"|'([^']*)'|\{[^}]*\})/;
    const stM = styleRe.exec(attrs);
    if (stM && stM[2].startsWith('{')) {
      throw new RoseError('E-TEMPLATE', `${filePath}: <${tag}> has both style={...} and style: directives`, { file: filePath, hint: 'keep the static declarations in style="..." and move the dynamic ones to style:PROP={expr}' });
    }
    const staticStyle = stM ? (stM[3] ?? stM[4] ?? '') : '';
    let closure = `${JSON.stringify(staticStyle.endsWith(';') || staticStyle === '' ? staticStyle : staticStyle + ';')}`;
    for (const p of pairs) {
      closure += `+${JSON.stringify(p.prop + ':')}+(${p.expr})+';'`;
    }
    let newAttrs = attrs;
    for (let k = pairs.length - 1; k >= 0; k--) {
      newAttrs = newAttrs.slice(0, pairs[k].start) + newAttrs.slice(pairs[k].end);
    }
    if (stM) {
      newAttrs = newAttrs.replace(styleRe, ` style={${closure}}`);
    } else {
      newAttrs = ` style={${closure}}` + newAttrs;
    }
    out += template.slice(pos, m.index) + `<${tag}${newAttrs}${selfClose}>`;
    pos = m.index + whole.length;
  }
  if (pos === 0) return template;
  out += template.slice(pos);
  return out;
}

/**
 * F11 (boundary {:fallback}): extracts each {#boundary} block's top-level
 * `{:fallback}` segment and encodes it as a base64 `__fb` attribute on the
 * boundary opener — base64 so the encoded markup survives every `[^}]*`
 * attr scan downstream. The dispatch decodes it and compiles the fallback
 * like any block (reactive exprs supported). Nested boundaries surface one
 * level per pass; a stray {:fallback} is left for assertKnownDirectives.
 */
function expandBoundaryFallbacks(template: string, filePath: string): string {
  if (!template.includes('{:fallback')) return template;
  for (let pass = 0; pass < 10; pass++) {
    const TOK_RE = /\{#boundary\}|\{\/boundary\}|\{:fallback\}/g;
    let out = '';
    let pos = 0;
    let changed = false;
    let tm: RegExpExecArray | null;
    while ((tm = TOK_RE.exec(template))) {
      if (tm[0] !== '{#boundary}') continue;
      const start = tm.index;
      const bodyStart = start + tm[0].length;
      let depth = 1;
      let closeAt = -1;
      let tm2: RegExpExecArray | null;
      while ((tm2 = TOK_RE.exec(template))) {
        if (tm2[0] === '{#boundary}') { depth++; continue; }
        if (tm2[0] === '{/boundary}') { depth--; if (depth === 0) { closeAt = tm2.index; break; } }
      }
      if (closeAt < 0) break;
      const body = template.slice(bodyStart, closeAt);
      const BTOK2 = /\{#(boundary|if|each|key|island)(?:\s+[^}]*)?\}|\{\/(?:boundary|if|each|key|island)\s*\}|\{:fallback\}/g;
      const kindStack = ['boundary'];
      let d = 1;
      let fbAt = -1;
      let fbLen = 0;
      let tm3: RegExpExecArray | null;
      BTOK2.lastIndex = 0;
      while ((tm3 = BTOK2.exec(body))) {
        const tok = tm3[0];
        if (tok === '{:fallback}') {
          const top = kindStack[kindStack.length - 1];
          if (top !== 'boundary') {
            throw new RoseError(
              'E-TEMPLATE',
              `${filePath}: {:fallback} must sit directly inside a {#boundary} block`,
              { hint: 'move it out of the {#if}/{#each} it sits in, or keep the conditional fallback in the parent' },
            );
          }
          if (fbAt >= 0) {
            throw new RoseError('E-TEMPLATE', `${filePath}: a {#boundary} can carry only one {:fallback}`, { hint: 'remove the extra {:fallback} segment' });
          }
          fbAt = tm3.index;
          fbLen = tok.length;
          continue;
        }
        if (tok.startsWith('{#')) { d++; kindStack.push(tok.slice(2, tok.length - 1).trim().split(/\s/)[0]); continue; }
        d--; kindStack.pop();
      }
      if (fbAt < 0) continue;
      const custom = body.slice(0, fbAt);
      const fbMarkup = body.slice(fbAt + fbLen);
      const b64 = Buffer.from(fbMarkup, 'utf-8').toString('base64');
      out += template.slice(pos, start) + `{#boundary __fb="${b64}"}` + custom + '{/boundary}';
      pos = closeAt + '{/boundary}'.length;
      changed = true;
    }
    if (!changed) break;
    template = out + template.slice(pos);
  }
  return template;
}

function expandIfElse(template: string): string {  for (let pass = 0; pass < 10; pass++) {
    if (!/\{:else\b/.test(template)) return template;
    const r = expandIfElseOnce(template);
    template = r.template;
    if (!r.changed) return template;
  }
  return template;
}

function expandDeferBlocks(template: string): { template: string; count: number; holds: number[] } {

  if (!DEFER_ENABLED) {
    const openRe = /\{#defer(?:\s+hold=\\d+)?\}/g;
    let out = '';
    let dpos = 0;
    for (;;) {
      openRe.lastIndex = dpos;
      const openM = openRe.exec(template);
      if (!openM) break;
      const openAt = openM.index;
      const openLen = openM[0].length;
      const closeAt = template.indexOf('{/defer}', openAt + openLen);
      if (closeAt < 0) break;
      out += template.slice(dpos, openAt) + template.slice(openAt + openLen, closeAt);
      dpos = closeAt + 8;
    }
    return { template: dpos === 0 ? template : out, count: 0, holds: [] };
  }
  let count = 0;
  const holds: number[] = [];
  let out = '';
  let pos = 0;
  const openRe = /\{#defer(?:\s+hold=(\d+))?\}/g;
  for (;;) {
    openRe.lastIndex = pos;
    const openM = openRe.exec(template);
    if (!openM) break;
    const openAt = openM.index;
    const openLen = openM[0].length;
    const hold = openM[1] ? Number(openM[1]) : 0;
    let depth = 1;
    let i = openAt + openLen;
    let closeAt = -1;
    while (i < template.length) {
      openRe.lastIndex = i;
      const nextOpenM = openRe.exec(template);
      const nextOpen = nextOpenM ? nextOpenM.index : -1;
      const nextClose = template.indexOf('{/defer}', i);
      if (nextClose < 0) break;
      if (nextOpen >= 0 && nextOpen < nextClose) { depth++; i = nextOpen + nextOpenM![0].length; continue; }
      depth--;
      if (depth === 0) { closeAt = nextClose; break; }
      i = nextClose + 8;
    }
    if (closeAt < 0) break;
    const content = template.slice(openAt + openLen, closeAt);
    holds.push(hold);
    const n = ++count;
    out += template.slice(pos, openAt);
    out += '{#if __rvDefer' + n + '()}' + content + '{/if}' + '\n' +
           '{#if !__rvDefer' + n + '()}<div class="rv-defer-loading"></div>{/if}';
    pos = closeAt + 8;
  }
  if (count === 0) return { template, count: 0, holds: [] };
  out += template.slice(pos);
  return { template: out, count, holds };
}

function deferBootCode(count: number, holds: number[] = []): string {
  let code = '';
  for (let n = 1; n <= count; n++) {
    code += 'const [__rvDefer' + n + ', set__rvDefer' + n + '] = state("__rvdefer' + n + '", false);\n';
    const hold = holds[n - 1] || 0;
    code += hold > 0
      ? 'onMount(function () { setTimeout(function () { set__rvDefer' + n + '(true); }, ' + hold + '); });\n'
      : 'onMount(function () { requestAnimationFrame(function () { requestAnimationFrame(function () { set__rvDefer' + n + '(true); }); }); });\n';
  }
  return code;
}

interface AwaitBlock { n: number; expr: string; thenVar: string; catchVar: string }
function expandAwaitBlocks(template: string, filePath: string): { template: string; blocks: AwaitBlock[] } {
  let out = '';
  let pos = 0;
  let n = 0;
  const blocks: AwaitBlock[] = [];
  for (;;) {
    const openAt = template.indexOf('{#await', pos);
    if (openAt < 0) break;
    let i = openAt + 7;
    let brace = 1;
    while (i < template.length && brace > 0) {
      const c = template[i];
      if (c === '{') brace++;
      else if (c === '}') brace--;
      i++;
    }
    if (brace !== 0) break;
    const openLen = i - openAt;
    const expr = template.slice(openAt + 7, i - 1).trim();
    if (!expr) {
      throw new RoseError('E-TEMPLATE', `${filePath}: {#await} needs a promise expression`, {
        file: filePath, hint: 'write {#await fetchUsers()}...{:then users}...{/await}' });
    }
    const blockOpenRe = /\{\#(if|each|boundary|island|await)\b/g;
    const blockCloseRe = /\{\/(if|each|boundary|island|await)\}/g;
    const thenRe = /\{:then\b([^}]*)\}/g;
    const catchRe = /\{:catch\b([^}]*)\}/g;
    let d = 1;
    let j = i;
    let thenAt = -1, catchAt = -1, closeAt = -1;
    let thenRaw = '', catchRaw = '';
    for (;;) {
      blockOpenRe.lastIndex = j;
      blockCloseRe.lastIndex = j;
      thenRe.lastIndex = j;
      catchRe.lastIndex = j;
      const nextOpen = blockOpenRe.exec(template);
      const nextClose = blockCloseRe.exec(template);
      const nextThen = thenRe.exec(template);
      const nextCatch = catchRe.exec(template);
      let nearestPos = Infinity, kind = '', m: RegExpExecArray | null = null;
      const consider = (mm: RegExpExecArray | null, k: string) => {
        if (mm && mm.index < nearestPos) { nearestPos = mm.index; kind = k; m = mm; }
      };
      consider(nextOpen, 'open'); consider(nextClose, 'close');
      consider(nextThen, 'then'); consider(nextCatch, 'catch');
      if (!m) break;
      if (kind === 'open') { d++; j = m.index + m[0].length; continue; }
      if (kind === 'close') {
        if (d === 1 && m[1] === 'await') { closeAt = m.index; break; }
        d--; j = m.index + m[0].length; continue;
      }
      if (d === 1) {
        if (kind === 'then' && thenAt < 0) { thenAt = m.index; thenRaw = m[1]; }
        else if (kind === 'catch' && catchAt < 0) { catchAt = m.index; catchRaw = m[1]; }
      }
      j = m.index + m[0].length;
    }
    if (closeAt < 0 || thenAt < 0) break;
    const thenTokenEnd = thenAt + 7 + thenRaw.length;
    const catchTokenEnd = catchAt >= 0 ? catchAt + 7 + catchRaw.length : -1;
    const pending = template.slice(i, thenAt);
    const thenBody = template.slice(thenTokenEnd, catchAt >= 0 ? catchAt : closeAt);
    const catchBody = catchAt >= 0 ? template.slice(catchTokenEnd, closeAt) : '';
    const thenVarRaw = thenRaw.trim();
    const catchVarRaw = catchRaw.trim();
    const thenVar = /^\w+$/.test(thenVarRaw) ? thenVarRaw : `__rvAwaitThen${n + 1}`;
    const catchVar = catchAt >= 0 ? (/^\w+$/.test(catchVarRaw) ? catchVarRaw : `__rvAwaitCatch${n + 1}`) : '';
    n++;
    const nn = n;
    const stateName = `__rvAwait${nn}`;
    blocks.push({ n: nn, expr, thenVar, catchVar });
    out += template.slice(pos, openAt);
    out += `{#if ${stateName}().status === 'pending'}` + pending + '{/if}\n';
    out += `{#each (${stateName}().status === 'resolved' ? [${stateName}().value] : []) as ${thenVar}}` + thenBody + '{/each}\n';
    if (catchAt >= 0) {
      out += `{#each (${stateName}().status === 'rejected' ? [${stateName}().error] : []) as ${catchVar}}` + catchBody + '{/each}\n';
    }
    pos = closeAt + 8;
  }
  if (n === 0) return { template, blocks };
  out += template.slice(pos);
  return { template: out, blocks };
}

function awaitBootCode(blocks: AwaitBlock[]): string {
  let code = '';
  for (const b of blocks) {
    const stateName = `__rvAwait${b.n}`;
    code += `const [${stateName}, set${stateName}] = state("__rvawait${b.n}", { status: 'pending', value: null, error: null });\n`;
    code += `onMount(function () {\n`;
    code += `  Promise.resolve(${b.expr}).then(function (__rvAwaitVal) {\n`;
    code += `    set${stateName}({ status: 'resolved', value: __rvAwaitVal });\n`;
    code += `  }).catch(function (__rvAwaitErr) {\n`;
    code += `    set${stateName}({ status: 'rejected', error: __rvAwaitErr });\n`;
    code += `  });\n`;
    code += `});\n`;
  }
  return code;
}

function findBlock(src: string, kind: 'if' | 'each' | 'boundary' | 'island' | 'snippet'): RegExpExecArray | null {
  const head = kind === 'boundary'
    ? /\{#boundary(?:\s+([^}]*))?\}/g
    : kind === 'if'
      ? /\{#if\s+([^}]+)\}/g
      : kind === 'island'
        ? /\{#island(?:\s+name="([^"]*)")?(?:\s+hydrate="([^"]*)")?\s*\}/g
        : kind === 'snippet'
          ? /\{#snippet\s+(\w+)(?:\s*\(([^)]+)\))?\s*\}/g
          : /\{#each\s+([^}]+?)\s+as\s+(\{[^{}]*\}|\[[^[\]]*\]|\w+)(?:\s*,\s*(\w+))?\}/g;
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
        const groups = kind === 'boundary' ? [open[1] ?? '', content]
          : kind === 'island' ? [open[1] ?? '', open[2] ?? '', content]
          : kind === 'if' ? [open[1], content] : [open[1], open[2], open[3] ?? '', content];
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

/**
 * - "errors an agent can fix" - closed on a real
 * failure from the field. A template directive rosefn does not implement
 * used to reach esbuild as generated code and die THERE: the xoboe port
 * wrote `{:else}` (the branch syntax every other template language has and
 * rosefn deliberately does not - `prompt.ts` says so in one line) and got
 * `dist/.build/comp-12.ssr.js:87: ERROR: Unexpected ":"` - a file the author
 * never wrote, a construct never named, a fix never suggested. An unknown
 * directive is now a build error at the .rose file, with the line, the
 * construct and the rosefn shape that replaces it.
 *
 * The known set is exactly what findBlock matches: `{#if}`, `{#each}`,
 * `{#boundary}` and their closers. There is no `{:...}` directive at all.
 * The same gate catches the two shapes findBlock cannot match at all - an
 * `{#each}` with no `as <name>` and an opener with no closer - which used to
 * reach esbuild the same way (`Unexpected "#each"`, `Unexpected "#if"`).
 * Adversarial probing found all three in one afternoon; a template compiler
 * that emits broken code silently is the worst failure mode it has.
 */
const KNOWN_CLOSERS = new Set(['if', 'each', 'boundary', 'island', 'await']);
const __blockResCache = new Map<string, { open: RegExp; close: RegExp }>();
function blockCloseRes(kind: string): { open: RegExp; close: RegExp } {
  let hit = __blockResCache.get(kind);
  if (!hit) {
    hit = {
      open: new RegExp(`\\{#${kind}\\b[^}]*\\}`, 'g'),
      close: new RegExp(`\\{/${kind}\\}`, 'g'),
    };
    __blockResCache.set(kind, hit);
  }
  return hit;
}
function assertKnownDirectives(template: string, filePath: string): void {
  const rawRanges: Array<[number, number]> = [];
  const RAW_OPEN = /<(style|script|noscript)\b[^>]*>/gi;
  let raw: RegExpExecArray | null;
  while ((raw = RAW_OPEN.exec(template))) {
    const tag = raw[1].toLowerCase();
    const closeAt = template.toLowerCase().indexOf(`</${tag}`, raw.index + raw[0].length);
    const gt = closeAt < 0 ? -1 : template.indexOf('>', closeAt);
    const end = gt < 0 ? template.length : gt + 1;
    rawRanges.push([raw.index, end]);
    RAW_OPEN.lastIndex = end;
  }
  const COMMENT_RE = /<!--[\s\S]*?-->/g;
  let note: RegExpExecArray | null;
  while ((note = COMMENT_RE.exec(template))) rawRanges.push([note.index, note.index + note[0].length]);
  rawRanges.sort((a, b) => a[0] - b[0]);
  const inRaw = (idx: number): boolean => rawRanges.some(([s, e]) => idx >= s && idx < e);
  const DIRECTIVE_RE = /\{([:/])(\w+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = DIRECTIVE_RE.exec(template))) {
    if (inRaw(m.index)) continue;
    const [, sigil, word] = m;
    if (sigil === '/' && KNOWN_CLOSERS.has(word)) continue;
    if (sigil === '/') {
      throw new RoseError(
        'E-TEMPLATE',
        `${filePath}: {/${word}} does not close anything`,
        { file: filePath, line: lineAt(template, m), hint: 'the closers are {/if}, {/each} and {/boundary} - one per block you opened' },
      );
    }
    if (word === 'else') {
      throw new RoseError(
        'E-TEMPLATE',
        `${filePath}: a stray {:else} with no {#if} above it`,
        { file: filePath, line: lineAt(template, m), hint: '{:else} / {:else if cond} belong inside an {#if} ... {/if} block - {#if cond}A{:else}B{/if}' },
      );
    }
    if (word === 'fallback') {
      throw new RoseError(
        'E-TEMPLATE',
        `${filePath}: a stray {:fallback} with no {#boundary} above it`,
        { file: filePath, line: lineAt(template, m), hint: '{:fallback} belongs directly inside a {#boundary} ... {/boundary} block' },
      );
    }
    if (word === 'then' || word === 'catch') {
      continue;
    }
    throw new RoseError(
      'E-TEMPLATE',
      `${filePath}: {:${word}} is not a rosefn directive`,
      { file: filePath, line: lineAt(template, m), hint: 'rosefn templates support {#if}/{:else}, {#each} and {#boundary}' },
    );
  }
  const OPENER_RE = /\{#(if|each|boundary|island|await)\b([^}]*)\}/g;
  while ((m = OPENER_RE.exec(template))) {
    if (inRaw(m.index)) continue;
    const [, kind, head] = m;
    if (kind === 'each' && !/\bas\s+(\{[^{}]*\}?|\[[^[\]]*\]?|\w+)(?:\s*,\s*\w+)?\s*$/.test(head)) {
      throw new RoseError(
        'E-TEMPLATE',
        `${filePath}: {#each ${head.trim()}} is missing its item name`,
        { file: filePath, line: lineAt(template, m), hint: 'write {#each items() as item} - the name after `as` is what the block body reads (item.id, item.name)' },
      );
    }
    const { open: OPEN_RE, close: CLOSE_RE } = blockCloseRes(kind);
    let depth = 1;
    let i = m.index + m[0].length;
    for (;;) {
      OPEN_RE.lastIndex = i;
      CLOSE_RE.lastIndex = i;
      const nextOpen = OPEN_RE.exec(template);
      const nextClose = CLOSE_RE.exec(template);
      if (!nextClose) break;
      if (nextOpen && nextOpen.index < nextClose.index) {
        i = nextOpen.index + nextOpen[0].length;
        continue;
      }
      i = nextClose.index + nextClose[0].length;
      if (--depth === 0) break;
    }
    if (depth !== 0) {
      throw new RoseError(
        'E-TEMPLATE',
        `${filePath}: unclosed {#${kind}} - every block needs its {/${kind}}`,
        { file: filePath, line: lineAt(template, m), hint: `add the matching {/${kind}} (an inner {#if} or {#each} closes first, deepest first)` },
      );
    }
  }
}

/**
 * A QUOTED attribute whose value carries an expression - `class="{x}"`,
 * `style="color:{c};"`, `href="/p{id}"` - used to be compiled as if the value
 * were body text: the reactive markers landed INSIDE the attribute
 * (`class="<!--⟦m:0⟧-->yes<!--⟦/m:0⟧-->"`), a class list no selector matches,
 * and no wire pass can repair it (markers inside an attribute value are not
 * nodes). The real CMS writes `style="background:{p.enabled ? ...};"` on
 * every row, so this was not exotic. The unquoted form (`class={x}`) has
 * always compiled correctly through attrMark(); this pass rewrites the quoted
 * form into a single equivalent expression - `class={('yes')}`,
 * `style={('background:' + (p.enabled ? …) + ';')}` - so there is ONE
 * attribute path in the compiler instead of two, one of them broken.
 *
 * Component tags keep their own attribute parser (a quoted value is a string
 * prop there, by design), and a value holding a template literal is left
 * alone: rewriting it would need the literal-aware scanner the value does not
 * have, and the old path was no better.
 */
function rewriteQuotedExprAttrs(template: string, comps: Map<string, unknown>): string {
  const TAG_RE = /<([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:=(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
  return template.replace(TAG_RE, (tag: string, name: string, attrs: string, selfClose: string) => {
    if (comps.has(name) || !/\{/.test(attrs)) return tag;
    const rewritten = attrs.replace(/([\w:-]+)="([^"]*)"/g, (whole: string, attr: string, value: string) => {
      if (!/\{/.test(value) || value.includes('`')) return whole;
      const spans = templateExprSpans(value);
      if (spans.length === 0) return whole;
      let expr = '';
      let last = 0;
      for (const s of spans) {
        if (last < s.start) expr += (expr ? ' + ' : '') + JSON.stringify(value.slice(last, s.start));
        expr += (expr ? ' + ' : '') + `(${s.expr})`;
        last = s.end + 1;
      }
      if (last < value.length) expr += (expr ? ' + ' : '') + JSON.stringify(value.slice(last));
      return `${attr}={${expr}}`;
    });
    return `<${name}${rewritten}${selfClose ? ' /' : ''}>`;
  });
}

function compileTemplate(
  template: string,
  acc: string,
  closes: string,
  scope: string | null,
  depth: number,
  markers = true,
  comps: Map<string, { index: number; slots: Array<{ name: string; props: string[] }> }> = new Map(),
  islandDepth = 0
): string {
  let result = '';
  let remaining = template;
  let blockId = 0;

  const islandsMode = /\{#island\b/.test(template);
  const effMarkers = markers && (!islandsMode || islandDepth > 0);

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
    const islandMatch = findBlock(remaining, 'island');
    const snippetMatch = findBlock(remaining, 'snippet');

    const candidates: Array<{ type: string; match: RegExpExecArray; index: number; tag?: CompTag }> = [];
    if (ifMatch?.index !== undefined) candidates.push({ type: 'if', match: ifMatch, index: ifMatch.index });
    if (eachMatch?.index !== undefined) candidates.push({ type: 'each', match: eachMatch, index: eachMatch.index });
    if (boundaryMatch?.index !== undefined) candidates.push({ type: 'boundary', match: boundaryMatch, index: boundaryMatch.index });
    if (islandMatch?.index !== undefined) candidates.push({ type: 'island', match: islandMatch, index: islandMatch.index });
    if (exprMatch?.index !== undefined) candidates.push({ type: 'expr', match: exprMatch, index: exprMatch.index });
    if (compTag) candidates.push({ type: 'comp', match: exprMatch!, index: compTag.start, tag: compTag });
    if (snippetMatch?.index !== undefined) candidates.push({ type: 'snippet', match: snippetMatch, index: snippetMatch.index });
    const earliest = candidates.length > 0
      ? candidates.reduce((a, b) => (a.index <= b.index ? a : b))
      : null;

    const rawOpenRe = /<(style|script|noscript)\b[^>]*>/g;
    const rawHit = rawOpenRe.exec(remaining);
    if (rawHit && earliest && rawHit.index < earliest.index) {
      const tag = rawHit[1].toLowerCase();
      const closeAt = remaining.toLowerCase().indexOf(`</${tag}`, rawHit.index + rawHit[0].length);
      const gt = closeAt < 0 ? -1 : remaining.indexOf('>', closeAt);
      const end = gt < 0 ? remaining.length : gt + 1;
      result += emitChunk(remaining.slice(0, end), acc, closes, scope);
      remaining = remaining.substring(end);
      continue;
    }

    const noteAt = remaining.indexOf('<!--');
    if (noteAt >= 0 && (!earliest || noteAt < earliest.index)) {
      const noteEnd = remaining.indexOf('-->', noteAt + 4);
      const end = noteEnd < 0 ? remaining.length : noteEnd + 3;
      result += emitChunk(remaining.slice(0, end), acc, closes, scope);
      remaining = remaining.substring(end);
      continue;
    }

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
      const inner = compileTemplate(content.trim(), 'h', '__c', innerScope, depth + 1, effMarkers, comps, islandDepth);
      result += `const __b${id} = (__s, __c) => { let h = ''; ${inner} return h; };\n`;
      if (effMarkers) {
        result += `${acc} += ifMark(${closes}, () => (${call}), __b${id}${scope ? `, ${scope}` : ''});\n`;
      } else {
        result += `${acc} += (${call}) ? __b${id}(${scope ?? 'undefined'}, []) : '';\n`;
      }
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    } else if (earliest.type === 'each') {
      const [, items, item, index, content] = earliest.match;
      const before = remaining.substring(0, earliest.index);
      if (before) result += emitChunk(before, acc, closes, scope);
      const call = autoCall(items);
      const id = nextId();
      const isDestructure = /^[{[]/.test(item);
      const itemRe = isDestructure ? null : new RegExp(`\\b${item}\\b`, 'g');
      const indexRe = index ? new RegExp(`\\b${index}\\b`, 'g') : null;
      let scoped = '';
      let lastSpan = 0;
      for (const s of templateExprSpans(content.trim())) {
        let expr = itemRe ? s.expr.replace(itemRe, '__s') : s.expr;
        if (indexRe) expr = expr.replace(indexRe, '__i');
        scoped += content.trim().slice(lastSpan, s.start) + '{' + expr + '}';
        lastSpan = s.end + 1;
      }
      scoped += content.trim().slice(lastSpan);
      const inner = compileTemplate(scoped, 'h', '__c', '__s', depth + 1, effMarkers, comps, islandDepth);
      const body = isDestructure ? `const ${item} = __s; ${inner}` : inner;
      result += `const __b${id} = (__s, __c${index ? ', __i' : ''}) => { let h = ''; ${body} return h; };\n`;
      if (effMarkers) {
        result += `${acc} += eachMark(${closes}, () => (${call}), __b${id});\n`;
      } else {
        const param = isDestructure ? '__s' : item;
        result += `${acc} += (${call}).map((${param}${index ? ', __i' : ''}) => __b${id}(${param}, []${index ? ', __i' : ''}))).join('');\n`;
      }
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    } else if (earliest.type === 'boundary') {
      const [, fbAttr, content] = earliest.match;
      let fallbackSrc = '';
      if (fbAttr) {
        const fbM = /__fb="([A-Za-z0-9+/=]*)"/.exec(fbAttr);
        if (fbM) fallbackSrc = Buffer.from(fbM[1], 'base64').toString('utf-8');
      }
      const custom = content;
      const before = remaining.substring(0, earliest.index);
      if (before) result += emitChunk(before, acc, closes, scope);
      const id = nextId();
      const catchesAction = /\$action:|<form[\s>]/.test(custom);
      const inner = compileTemplate(custom.trim(), 'h', closes, scope, depth + 1, effMarkers, comps, islandDepth);
      result += `const __b${id} = (__c) => { let h = ''; ${inner} return h; };\n`;
      let fbBlock = '';
      if (fallbackSrc.trim()) {
        const fbInner = compileTemplate(fallbackSrc.trim(), 'h', closes, scope, depth + 1, effMarkers, comps, islandDepth);
        fbBlock = `const __bf${id} = (__c) => { let h = ''; ${fbInner} return h; };\n`;
      }
      result += fbBlock;
      result += `let __bd${id} = '';\n`;
      result += catchesAction
        ? `try { $actionErrorOrThrow(); __bd${id} = __b${id}(${closes}); } catch (e) { $setBoundaryError(e); __bd${id} = ${fbBlock ? `__bf${id}(${closes})` : '$boundaryFallback(e)'}; }\n`
        : `try { __bd${id} = __b${id}(${closes}); } catch (e) { $setBoundaryError(e); __bd${id} = ${fbBlock ? `__bf${id}(${closes})` : JSON.stringify(BOUNDARY_FALLBACK)}; }\n`;
      result += `${acc} += __bd${id};\n`;
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    } else if (earliest.type === 'snippet') {
      const [, name, params, content] = earliest.match;
      const before = remaining.substring(0, earliest.index);
      if (before) result += emitChunk(before, acc, closes, scope);
      const id = nextId();
      const paramList = params ? params.split(',').map(p => p.trim()).filter(Boolean).join(',') : '';
      const inner = compileTemplate(content.trim(), 'h', '__c', '__s', depth + 1, effMarkers, comps, islandDepth);
      result += `(__snip || (__snip = {})).${name} = (__s, __c${paramList ? ',' + paramList : ''}) => { let h = ''; ${inner} return h; };\n`;
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
        result += `const __ch${id} = (__s, __c) => { let h = ''; ${compileTemplate(def, 'h', '__c', scope, depth + 1, effMarkers, comps, islandDepth)} return h; };\n`;
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
        return `${JSON.stringify(nm)}: (__s, __c) => { let h = ''; ${compileTemplate(content, 'h', '__c', scope, depth + 1, effMarkers, comps, islandDepth)} return h; }`;
      });
      const propsObj = parseCompAttrs(tag.attrs)
        .filter((a) => a.name !== 'slot')
        .map((a) => {
          if (a.kind === 'spread') return `...(${a.value})`;
          const key = a.name.startsWith('on:') ? `on${capitalize(a.name.slice(3))}` : a.name;
          const val = a.kind === 'expr' ? `(${a.value})` : a.kind === 'str' ? JSON.stringify(a.value) : 'true';
          return `${JSON.stringify(key)}: ${val}`;
        })
        .join(', ');
      const childrenArg = hasChildren ? `__ch${id}(${scope ?? 'undefined'}, ${closes})` : `''`;
      result += `${acc} += ${tag.name}(${closes}, ${childrenArg}, { ${propsObj} }, { ${slotFns.join(', ')} });\n`;
      remaining = rest;
    } else if (earliest.type === 'island') {
      const [, name, hydrate, content] = earliest.match;
      const before = remaining.substring(0, earliest.index);
      if (before) result += emitChunk(before, acc, closes, scope);
      const hydrateAttr = hydrate === 'visible' || hydrate === 'idle'
        ? ` data-rv-island-hydrate="${hydrate}"`
        : '';
      result += `${acc} += ${JSON.stringify(`<div data-rv-island="${name || ''}"${hydrateAttr}>`)};\n`;
      const inner = compileTemplate(content.trim(), 'h', '__c', scope, depth + 1, markers, comps, islandDepth + 1);
      result += inner;
      result += `${acc} += '</div>';\n`;
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    } else {
      const [, expr] = earliest.match;
      const trimmed = expr.trim();
      const before = remaining.substring(0, earliest.index);
      const constMatch = /^@const\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/.exec(trimmed);
      if (constMatch) {
        if (before) result += emitChunk(before, acc, closes, scope);
        result += `const ${constMatch[1]} = (${constMatch[2].trim()});\n`;
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      if (trimmed === '__slot__') {
        if (before) result += emitChunk(before, acc, closes, scope);
        result += compileSlot(acc);
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      const slotDefault = /^__slotDefault\(("(?:[^"\\]|\\.)*")\)$/.exec(trimmed);
      if (slotDefault) {
        if (before) result += emitChunk(before, acc, closes, scope);
        result += `${acc} += __slotDefault(children, ${slotDefault[1]});\n`;
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      const slotCall = /^__slot\((['"])(\w+)\1, \[([\s\S]*?)\](?:,\s*("(?:[^"\\]|\\.)*"))?\)$/.exec(trimmed);
      if (slotCall) {
        if (before) result += emitChunk(before, acc, closes, scope);
        const fb = slotCall[4] ? `, ${slotCall[4]}` : '';
        result += `${acc} += __slotBlock(${closes}, __sl, ${JSON.stringify(slotCall[2])}, [${slotCall[3]}]${fb});\n`;
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      const rawMatch = /^@html\s+([\s\S]+)$/.exec(trimmed);
      if (rawMatch) {
        if (before) result += emitChunk(before, acc, closes, scope);
        const expr = rawMatch[1].trim();
        if (!effMarkers) {
          result += `${acc} += String(${expr} ?? '');\n`;
        } else {
          const fn = scope ? `(${scope}) => (${expr})` : `() => (${expr})`;
          result += `${acc} += rawMark(${closes}, ${fn}${scope ? `, ${scope}` : ''});\n`;
        }
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      const dbgMatch = /^@debug\b([\s\S]*)$/.exec(trimmed);
      if (dbgMatch) {
        if (before) result += emitChunk(before, acc, closes, scope);
        const names = dbgMatch[1].trim().replace(/,$/, '');
        result += names
          ? `console.log('[rosefn:debug]', { ${names} });\n`
          : `console.log('[rosefn:debug]'); debugger;\n`;
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      const attrMatch = before.match(/([\w-]+)=\s*$/);
      if (attrMatch) {
        const lit = before.slice(0, before.length - attrMatch[0].length);
        if (lit) result += emitChunk(lit, acc, closes, scope);
        result += emitAttr(attrMatch[1], trimmed, acc, closes, scope, effMarkers);
      } else {
        if (before) result += emitChunk(before, acc, closes, scope);
        const after = remaining.substring(earliest.index + earliest.match[0].length);
        const pair = after.length > 0 && !/^<[a-zA-Z/!]/.test(after) && !after.startsWith('{');
        result += emitText(trimmed, acc, closes, scope, effMarkers, pair);
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

interface CompAttr { name: string; kind: 'expr' | 'str' | 'bool' | 'spread'; value: string }

/** Parse a component tag's attributes into prop={expr} / prop="lit" / bool. */
function parseCompAttrs(attrs: string): CompAttr[] {
  const out: CompAttr[] = [];
  let i = 0;
  while (i < attrs.length) {
    const spread = /^\s*\{\.\.\.([^}]*)\}/.exec(attrs.slice(i));
    if (spread) {
      out.push({ name: '...', kind: 'spread', value: spread[1].trim() });
      i += spread[0].length;
      continue;
    }
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
  const blockStack: Array<{ header: string; type: string }> = [];
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
      if (next === ob) {
        const m = /^\{#(\w+)/.exec(token);
        blockStack.push({ header: token, type: m ? m[1] : '' });
        blockDepth++;
      } else {
        blockDepth = Math.max(0, blockDepth - 1);
        if (blockStack.length) blockStack.pop();
      }
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
    if (slotName && elemDepth === 1 && blockDepth === 0) {
      if (selfClosing || isVoid) {
        named.set(slotName, (named.get(slotName) ?? '') + tagText.replace(/\s*slot\s*=\s*["']\w+["']/, ''));
      } else {
        const closeIdx = findClose(src, end, nm[2]);
        if (closeIdx < 0) throw new RoseError('E-TEMPLATE', `unclosed <${nm[2]}> inside slot="${slotName}"`, { hint: `add the matching </${nm[2]}>` });
        const tail = `</${nm[2]}>`;
        const inner = src.slice(end, closeIdx);
        rejectNestedSlot(inner, slotName);
        named.set(slotName, (named.get(slotName) ?? '') + tagText.replace(/\s*slot\s*=\s*["']\w+["']/, '') + inner + tail);
        elemDepth = Math.max(0, elemDepth - 1);
        i = closeIdx + tail.length;
        continue;
      }
      i = end;
      continue;
    }
    if (slotName && blockDepth > 0) {
      const stripped = tagText.replace(/\s*slot\s*=\s*["']\w+["']/, '');
      let lifted = '';
      for (const b of blockStack) lifted += b.header;
      lifted += stripped;
      if (selfClosing || isVoid) {
        for (let k = blockStack.length - 1; k >= 0; k--) lifted += `{/${blockStack[k].type}}`;
        named.set(slotName, (named.get(slotName) ?? '') + lifted);
        i = end;
        continue;
      }
      const closeIdx = findClose(src, end, nm[2]);
      if (closeIdx < 0) throw new RoseError('E-TEMPLATE', `unclosed <${nm[2]}> inside slot="${slotName}"`, { hint: `add the matching </${nm[2]}>` });
      const tail = `</${nm[2]}>`;
      lifted += src.slice(end, closeIdx) + tail;
      for (let k = blockStack.length - 1; k >= 0; k--) lifted += `{/${blockStack[k].type}}`;
      named.set(slotName, (named.get(slotName) ?? '') + lifted);
      elemDepth = Math.max(0, elemDepth - 1);
      i = closeIdx + tail.length;
      continue;
    }
    if (slotName) {
      throw new RoseError('E-TEMPLATE', `slot="${slotName}" on <${nm[2]}> must be a direct child of the component, or wrapped only by an {#if}/{#each}/{#boundary} block - it is nested inside another element`, {
        hint: 'place the element with slot="..." directly inside the component tag, or inside a single {#if}/{#each} block - wrapping it in another element is not yet supported',
      });
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
const INLINE_SVG_MAX = 16384;

import { readImageSize } from "../cli/image-size";
import { scanContentDir, renderMarkdown, buildRss } from "../cli/content";

/**
 * A4 (responsive variants): the sibling `name.wNNN.ext` files of a local
 * image (e.g. `hero.jpg` with `hero.w400.jpg` / `hero.w800.jpg` next to it
 * in public/) become a sorted srcset on the URL-kept <img>. Zero-dependency
 * by design - the variants themselves are plain files, generated by whatever
 * resizer the app prefers (xoboe ships tools/make-variants.mjs). Author-set
 * srcset/sizes always win; no variants means no attribute, byte-identical.
 */
function listImageVariants(publicDir: string, url: string): Array<{ url: string; width: number }> {
  const ext = path.extname(url);
  const base = path.basename(url, ext);
  const dirUrl = url.slice(0, url.length - (base + ext).length);
  let entries: string[];
  try {
    entries = fs.readdirSync(path.join(publicDir, path.dirname(url)));
  } catch {
    return [];
  }
  const re = new RegExp(
    '^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.w(\\d+)' + ext.replace('.', '\\.') + '$',
    'i',
  );
  const out: Array<{ url: string; width: number }> = [];
  for (const e of entries) {
    const m = re.exec(e);
    const width = m ? Number(m[1]) : 0;
    if (width > 0) out.push({ url: `${dirUrl}${base}.w${width}${ext}`, width });
  }
  return out.sort((a, b) => a.width - b.width);
}

const __imgReadCache = new Map<string, { mtime: number; buffer: Buffer; dims: { width: number; height: number } | null }>();
function cachedImageRead(filePath: string): { buffer: Buffer; dims: { width: number; height: number } | null } | null {
  let st: fs.Stats;
  try { st = fs.statSync(filePath); } catch { return null; }
  const hit = __imgReadCache.get(filePath);
  if (hit && hit.mtime === st.mtimeMs) return { buffer: hit.buffer, dims: hit.dims };
  let buffer: Buffer;
  try { buffer = fs.readFileSync(filePath); } catch { return null; }
  const dims = readImageSize(filePath);
  const entry = { mtime: st.mtimeMs, buffer, dims };
  __imgReadCache.set(filePath, entry);
  return { buffer, dims: entry.dims };
}

function inlineImages(template: string, publicDir: string): string {
  return template.replace(IMG_RE, (tag) => {
    const src = tag.match(/\bsrc="(\/[^"{}]+)"/);
    if (!src) return tag;
    const ext = path.extname(src[1]).toLowerCase();
    const mime = IMG_MIME[ext];
    if (!mime) return tag;
    const filePath = path.join(publicDir, src[1]);
    const read = cachedImageRead(filePath);
    if (!read) return tag;
    const file = read.buffer;
    const authorDims = /\swidth=/.test(tag) || /\sheight=/.test(tag);
    const dims = authorDims ? null : read.dims;
    const withDims = (t: string): string =>
      dims ? t.replace(/<img\b/, `<img width="${dims.width}" height="${dims.height}"`) : t;
    const inlineMax = ext === '.svg' ? INLINE_SVG_MAX : INLINE_IMG_MAX;
    if (file.length > inlineMax) {
      const hasSS = /\ssrcset=/.test(tag) || /\ssizes=/.test(tag);
      const variants = hasSS ? [] : listImageVariants(publicDir, src[1]);
      if (!variants.length) return withDims(tag);
      const srcset = variants.map((v) => `${v.url} ${v.width}w`).join(', ');
      return withDims(tag.replace(/<img\b/, `<img srcset="${srcset}"`));
    }
    const uri = ext === '.svg'
      ? `data:image/svg+xml,${file.toString('utf-8').replace(/%/g, '%25').replace(/#/g, '%23').replace(/"/g, '%22')}`
      : `data:${mime};base64,${file.toString('base64')}`;
    return withDims(tag.replace(src[0], `src="${uri}"`));
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
const BOOLEAN_ATTRS = new Set(['checked', 'disabled', 'readonly', 'required', 'selected', 'multiple', 'autofocus', 'open']);

function emitAttr(attr: string, expr: string, acc: string, closes: string, scope: string | null, markers = true): string {
  if (!markers) {
    return `${acc} += '${attr}="' + esc(${expr}) + '"';\n`;
  }
  const fn = scope ? `(${scope}) => (${expr})` : `() => (${expr})`;
  const arg = scope ? `, ${scope}` : '';
  if (BOOLEAN_ATTRS.has(attr)) {
    return `${acc} += boolAttrMark(${closes}, ${fn}, '${attr}'${arg});\n`;
  }
  return `${acc} += attrMark(${closes}, ${fn}, '${attr}'${arg});\n`;
}

/**
 * <slot /> -> inline the children html. The page rendered first with the same
 * shared closes array, so the top-level wire() pass resolves its markers.
 */
function compileSlot(acc: string): string {
  return `${acc} += String(children);\n`;
}

const RUNTIME_IMPORTS = `import { state, setState, persistState, $data, hasState, esc, refresh, onMount, onCleanup, getContext, $query, $t, bestLocale, localeDir, ensureLocale, loadLocale, handlers, directives, $cookies, $sessionCookie, $store, ActionError, $actionError, $actionErrorOrThrow, $boundaryFallback, $setBoundaryError, $boundaryError, $append, $prepend, $merge, applyStateDeltas, textMark, attrMark, boolAttrMark, ifMark, eachMark, headMark, rawMark, slotBlockMark, redirect, notFound } from './runtime.js';`;

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
const __slotBlock = (closes, sl, name, pairs, fallback) => {
  const hit = __slot(sl, name, pairs);
  if (hit) return slotBlockMark(closes, hit);
  return fallback || '';
};
const __slotDefault = (children, fallback) => {
  const c = children == null ? '' : String(children);
  if (c.trim()) return c;
  return fallback || '';
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

const routeShellOff = (infos: RouteInfo[], compiled: CompileResult[], i: number): boolean =>
  compiled[i].shell === false || layoutsOf(infos, i).some((li) => compiled[li].shell === false);

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
const MOUNT_ENTRY = `
import { start, postForm } from '/client.js';

for (const el of document.querySelectorAll('[data-rosefn]')) {
  const route = el.getAttribute('data-rosefn');
  const doc = await fetch(route).then((r) => (r.ok ? r.text() : ''));
  const parsed = new DOMParser().parseFromString(doc, 'text/html');
  // A JS-shipping document wraps its content in #app; a zero-JS route's content is the body's own (no wrapper).
  const app = parsed.getElementById('app');
  if (app) {
    el.innerHTML = app.innerHTML;
  } else {
    for (const node of Array.from(parsed.body.children)) {
      if (!/^(?:SCRIPT|LINK|STYLE)$/.test(node.tagName)) el.appendChild(node);
    }
  }
  // start() resumes from #__rosefn_state (zero hydration), so the state
  
  const state = parsed.getElementById('__rosefn_state');
  if (state) el.appendChild(state);
  
  const rendered = state ? JSON.parse(state.textContent || '{}').__route : null;
  await start(el, route, rendered === route);
  if (state) state.remove();
  
  el.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="/"]');
    if (!a || !el.contains(a)) return;
    e.preventDefault();
    el.setAttribute('data-rosefn', a.getAttribute('href'));
    start(el, a.getAttribute('href'), false);
  });
  // Progressive-enhancement forms work inside a mount too: the native POST would replace the HOST page.
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
  const contentSrcCands = [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'content.ts'), path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'content.ts')];
  const contentSrc = contentSrcCands.find((c) => fs.existsSync(c)) ?? contentSrcCands[0];
  fs.copyFileSync(contentSrc, path.join(buildDir, 'content-md.ts'));

  const runtimePlugins = plugins.filter((p) => p && (p.onRequest || p.onResponse));
  if (runtimePlugins.length > 0) {
    const configRel = path.relative(buildDir, path.join(root, 'rosefn.config.js')).replace(/\\/g, '/');
    await fs.promises.writeFile(path.join(buildDir, 'plugins.js'), `    
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
    .filter(({ info }) => !info.isLayout && !info.isNotFound && !info.isError && !info.isApi && !info.isMiddleware && !info.isComponent)
    // Specificity order, by route specificity: a literal segment
    // beats a param, a param beats a catch-all, and an optional catch-all
    // (which also matches the parent path) goes last. Without this a root
    // `[[...slug]]` - the shape a CMS's public site is written as - would
    // match EVERY pathname first and shadow every real route. The order is
    // stable within a class, so an app without catch-alls is unchanged.
    .sort((a, b) => {
      const rank = (pattern: string): number[] => {
        const segs = pattern.split('/');
        return [
          segs.filter((s) => s.startsWith('**')).length,
          segs.filter((s) => s.startsWith('*')).length,
          segs.filter((s) => s.startsWith(':')).length,
        ];
      };
      const ra = rank(a.info.pattern);
      const rb = rank(b.info.pattern);
      for (let k = 0; k < 3; k++) if (ra[k] !== rb[k]) return ra[k] - rb[k];
      return a.info.filePath < b.info.filePath ? -1 : 1;
    });

  const apiRoutes = infos
    .map((info, i) => ({ info, i }))
    .filter(({ info }) => info.isApi)
    .sort((a, b) => {
      const rank = (pattern: string): number[] => {
        const segs = pattern.split('/');
        return [
          segs.filter((s) => s.startsWith('**')).length,
          segs.filter((s) => s.startsWith('*')).length,
          segs.filter((s) => s.startsWith(':')).length,
        ];
      };
      const ra = rank(a.info.pattern);
      const rb = rank(b.info.pattern);
      for (let k = 0; k < 3; k++) if (ra[k] !== rb[k]) return ra[k] - rb[k];
      return a.info.filePath < b.info.filePath ? -1 : 1;
    });

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

  const notFoundEntries = infos
    .map((info, i) => ({ info, i }))
    .filter(({ info }) => info.isNotFound)
    .map(({ info, i }) => {
      const rel = path.relative(path.join(root, 'src', 'pages'), info.filePath).replace(/\\/g, '/');
      const dir = path.posix.dirname(rel);
      const prefix = dir === '.' ? '/' : '/' + dir;
      const flags = routeShellOff(infos, compiled, i) ? ', { shell: false }' : '';
      return { prefix, render: compose(i), flags };
    })
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const notFoundTable = `[\n${notFoundEntries.map((e) => `  ['${e.prefix}', ${e.render}${e.flags}],`).join('\n')}\n]`;

  const errIdx = infos.findIndex((info) => info.isError);
  const errorRender = errIdx >= 0 ? compose(errIdx) : 'null';

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
      const shellFlag = routeShellOff(infos, compiled, i) ? ', shell: false' : '';
      const bufferFlag = compiled[i].buffer ? ', buffer: true' : '';
      const signalFlag = compiled[i].controlSignal ? ', signal: true' : '';
      const guardFlag = compiled[i].guardName ? `, guard: beforeAction_${i}` : '';
      return `{ pattern: '${info.pattern}', path: '${info.routePath}', render: ${compose(i)}, actions: ${actionMap ? `{ ${actionMap} }` : 'null'}${guardFlag}${csrFlag}${shellFlag}${bufferFlag}${signalFlag} }`;
    })
    .join(',\n  ');

  const serverEntry = `
${serverImports}
import { renderMarkdown } from './content-md.ts';
import crypto from 'node:crypto';
import { setState, persistState, clearRequestState, serializeState, resetRequestContext, setRequestQuery, isLocale, setLocales, localeList, localeDir, setStoreTransport, applyStorePatch, ActionError, StateDelta, setStateDelta, esc } from './runtime.js';
${runtimePlugins.length > 0
    ? `import { hooks as __pluginHooks, hasRequestHooks as __hasRequestHooks, hasResponseHooks as __hasResponseHooks } from './plugins.js';`
: `// no plugin declares a runtime hook, so there is no plugins
// module to import - the runners below stay no-ops and the servers call them
// unconditionally (one code path, no flags to keep in sync).
const __pluginHooks = [];
const __hasRequestHooks = false;
const __hasResponseHooks = false;`}


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



export const hasRequestHooks = __hasRequestHooks;
export const hasResponseHooks = __hasResponseHooks;

// P0-1: the query of the request being rendered, for $query().
export function setQuery(query) {
  setRequestQuery(query || {});
}


setLocales(${localesJson}, '${defaultLocale}');


if (typeof process !== 'undefined' && typeof process.send === 'function') {
  setStoreTransport((name, value) => process.send({ type: 'rosefn:store', name, value }));
  process.on('message', (msg) => {
    if (msg && msg.type === 'rosefn:store') applyStorePatch(msg.name, msg.value);
  });
}


// (the cross-machine seam): the cluster relay above covers ONE machine.
export function __installStoreTransport(send: (name: string, value: unknown) => void): void {
  setStoreTransport(send);
}
export function __deliverStorePatch(name: string, value: unknown): void {
  applyStorePatch(name, value);
}

export { localeList };
export const defaultLocale = '${defaultLocale}';

// Route params maps, re-exported for the build's prerender step: routePath -> the component's exported params (a static map or a function).
${pages.filter(({ i }) => compiled[i].hasParams).map(({ i }) => `import * as comp_${i} from './comp-${i}.ssr.js';`).join('\n')}

export const routeParams = {
  ${pages.filter(({ info, i }) => compiled[i].hasParams).map(({ info, i }) => `'${info.routePath}': comp_${i}.params`).join(',\n  ')}
};

// Routes whose component reads the request context (getContext()), mutates a shared store ($store()), reads the query ($query(), P0-1)
export const dynamicRoutes = [
  ${pages.filter(({ i }) => compiled[i].usesContext || compiled[i].cspNonce || compiled[i].buffer || compiled[i].controlSignal || compiled[i].needsClient).map(({ info }) => `'${info.routePath}'`).join(',\n  ')}
];

// Routes that the prerender function should skip (not bake into static files).
export const prerenderSkipRoutes = [
  ${pages.filter(({ i }) => compiled[i].usesContext || compiled[i].cspNonce || compiled[i].buffer || compiled[i].controlSignal).map(({ info }) => `'${info.routePath}'`).join(',\n  ')}
];

// Which api routes opt into build-time baking (export const prerender = true): routePath -> boolean.
${apiRoutes.filter(({ i }) => compiled[i].hasPrerender).map(({ i }) => `import * as api_${i} from './comp-${i}.ssr.js';`).join('\n')}

export const apiPrerender = {
  ${apiRoutes.map(({ info, i }) => `'${info.routePath}': ${compiled[i].hasPrerender ? `api_${i}.prerender === true` : 'false'}`).join(',\n  ')}
};


export const revalidate = [
  ${pages.filter(({ i }) => compiled[i].revalidate !== undefined && !compiled[i].usesContext).map(({ info, i }) => `{ pattern: '${info.pattern}', seconds: ${compiled[i].revalidate} }`).join(',\n  ')}
];

// Per-request render memo (export const cache = N): a dynamic route's whole renderPage result is memoized for N seconds.
export const routeCaches = [
  ${pages.filter(({ i }) => compiled[i].cache !== undefined).map(({ info, i }) => `{ pattern: '${info.pattern}', seconds: ${compiled[i].cache} }`).join(',\n  ')}
];
const __dynCache = new Map();
export function invalidateRenderCache(): void {
  __dynCache.clear();
}



// Application KV cache primitive (server-side, per-worker in-memory): a zero-dependency store for expensive computations.
const __kvStore = new Map<string, { v: unknown; exp: number }>();
// Content collections: src/content/<coll>/*.md scanned once at build time,

const contentCollections = ${JSON.stringify(scanContentDir(path.join(root, 'src', 'content')))};
export const kv = {
  get(key: string): unknown {
    const e = __kvStore.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) { __kvStore.delete(key); return undefined; }
    return e.v;
  },
  set(key: string, value: unknown, ttlSeconds = 300): void {
    if (__kvStore.size > 1000) {
      const cutoff = Date.now();
      for (const [k, e] of __kvStore) { if (e.exp < cutoff) __kvStore.delete(k); }
      if (__kvStore.size > 2000) __kvStore.clear(); 
    }
    __kvStore.set(key, { v: value, exp: Date.now() + ttlSeconds * 1000 });
  },
  del(key: string): void { __kvStore.delete(key); },
  has(key: string): boolean {
    const e = __kvStore.get(key);
    return !!e && e.exp >= Date.now();
  },
};
globalThis.__rosefnKvApi = { kv, kvMemo: $kv };
globalThis.__rosefnContent = {
  list: (coll: string, filter?: { tag: string }) => {
    let items = contentCollections[coll] ?? [];
    if (filter?.tag) items = items.filter((e) => ((e.frontmatter.tags as string[] | undefined) ?? []).includes(filter.tag));
    return items.map((e) => ({ slug: e.slug, ...e.frontmatter }));
  },
  rss: (coll: string, opts: { title: string; origin: string; description?: string }) => {
    return buildRss(contentCollections[coll] ?? [], opts);
  },
  get: (coll: string, slug: string, vars?: Record<string, unknown>) => {
    const e = (contentCollections[coll] ?? []).find((x) => x.slug === slug);
    if (!e) return null;
    return { slug: e.slug, ...e.frontmatter, html: renderMarkdown(e.body, vars), toc: e.toc, readingTime: e.readingTime, wordCount: e.wordCount, excerpt: e.excerpt };
  },
};

const v = {
  validate(body: Record<string, unknown>, rules: Record<string, string[]>): { ok: boolean; errors: Record<string, string>; values: Record<string, unknown> } {
    const errors: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    for (const [field, ruleList] of Object.entries(rules)) {
      let val = body[field];
      for (const rule of ruleList) {
        if (val === undefined || val === null || val === "") {
          if (rule === "required") errors[field] = field + " is required";
          else if (rule.startsWith("default:")) val = rule.slice(8);
          continue;
        }
        if (rule === "string") val = String(val);
        else if (rule === "trim") val = String(val).trim();
        else if (rule === "number") {
          const num = Number(val);
          if (Number.isNaN(num)) errors[field] = field + " must be a number";
          else val = num;
        } else if (rule === "email") {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(val))) errors[field] = field + " must be a valid email";
        } else if (rule.startsWith("min:")) {
          const min = Number(rule.slice(4));
          if (typeof val === "number" ? val < min : String(val).length < min) errors[field] = field + " must be at least " + min;
        } else if (rule.startsWith("max:")) {
          const max = Number(rule.slice(4));
          if (typeof val === "number" ? val > max : String(val).length > max) errors[field] = field + " must be at most " + max;
        }
      }
      values[field] = val;
    }
    return { ok: Object.keys(errors).length === 0, errors, values };
  },
};

const jobs = {
  _timers: new Map<string, ReturnType<typeof setInterval>>(),
  every(name: string, seconds: number, fn: () => void | Promise<void>): void {
    if (this._timers.has(name)) return;
    const t = setInterval(() => { Promise.resolve(fn()).catch(() => {}); }, seconds * 1000);
    this._timers.set(name, t as any);
  },
  cancel(name: string): void {
    const t = this._timers.get(name);
    if (t) { clearInterval(t); this._timers.delete(name); }
  },
  cancelAll(): void { for (const t of this._timers.values()) clearInterval(t); this._timers.clear(); }
};

function sse(handler: (send: (event: string, data: unknown) => void) => Promise<void> | void): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode("event: " + event + "\\ndata: " + JSON.stringify(data) + "\\n\\n"));
      };
      try {
        await handler(send);
      } finally {
        closed = true;
        try { controller.close(); } catch {  }
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "connection": "keep-alive" },
  });
}
globalThis.__rosefnExtras = { v, jobs, sse };
const auth = {
  hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 32).toString("hex");
    return salt + ":" + hash;
  },
  verifyPassword(password: string, stored: string): boolean {
    const [salt, hash] = stored.split(":");
    if (!salt || !hash) return false;
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), crypto.scryptSync(password, salt, 32));
  },
  signSession(data: Record<string, unknown>, secret: string, ttlSeconds = 86400): string {
    const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + ttlSeconds * 1000 })).toString("base64url");
    const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    return payload + "." + sig;
  },
  verifySession<T = Record<string, unknown>>(token: string, secret: string): T | null {
    const dot = token.lastIndexOf(".");
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expect = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    try {
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    } catch { return null; }
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (data.exp < Date.now()) return null;
      return data as T;
    } catch { return null; }
  },
  csrfToken(secret: string, sessionId: string): string {
    return crypto.createHmac("sha256", secret).update(sessionId).digest("hex");
  },
  verifyCsrf(token: string, secret: string, sessionId: string): boolean {
    try {
      return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.csrfToken(secret, sessionId)));
    } catch { return false; }
  },
};
globalThis.__rosefnAuth = auth;

export async function $kv(key: string, compute: () => unknown | Promise<unknown>, ttlSeconds = 300): Promise<unknown> {
  const hit = kv.get(key);
  if (hit !== undefined) return hit;
  const v = await compute();
  if (v !== undefined) kv.set(key, v, ttlSeconds);
  return v;
}
export function isCachedRoute(pathname: string): boolean {
  return routeCaches.some((r) => matchRoute(r.pattern, pathname));
}
export function invalidatePath(pathname: string): number {
  let n = 0;
  for (const key of [...__dynCache.keys()]) {
    if (key.startsWith(pathname + '|')) { __dynCache.delete(key); n++; }
  }
  return n;
}
export function peekRenderCache(pathname: string, cookieHeader: string): ReturnType<typeof renderPage> | null {
  const cfg = routeCaches.find((r) => matchRoute(r.pattern, pathname));
  if (!cfg) return null;
  let h = 0x811c9dc5;
  const c = cookieHeader || '';
  for (let i = 0; i < c.length; i++) {
    h ^= c.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  const hit = __dynCache.get(pathname + '|' + h.toString(16));
  return hit && hit.expires > Date.now() ? hit.page : null;
}
export async function renderPageCached(pathname: string, cookieHeader: string): Promise<ReturnType<typeof renderPage>> {
  const cfg = routeCaches.find((r) => matchRoute(r.pattern, pathname));
  if (!cfg) return renderPage(pathname);
  let h = 0x811c9dc5;
  for (let i = 0; i < cookieHeader.length; i++) {
    h ^= cookieHeader.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  const key = pathname + '|' + h.toString(16);
  const hit = __dynCache.get(key);
  if (hit && hit.expires > Date.now()) {
    __dynCache.delete(key);
    __dynCache.set(key, hit);
    return hit.page;
  }
  // Stale-while-revalidate: an EXPIRED entry still answers instantly while one background render refreshes it - the TTL boundary never spikes.
  if (hit && !hit.refreshing) {
    hit.refreshing = true;
    renderPage(pathname).then((fresh: any) => {
      if (fresh.status === 200 && !fresh.redirect) {
        __dynCache.set(key, { page: fresh, expires: Date.now() + cfg.seconds * 1000 });
      } else {
        __dynCache.delete(key);
      }
    }).catch(() => { __dynCache.delete(key); });
    return hit.page;
  }
  const page = await renderPage(pathname);
  if (page.status === 200 && !page.redirect) {
    __dynCache.set(key, { page, expires: Date.now() + cfg.seconds * 1000 });
    if (__dynCache.size > 300) {
      __dynCache.delete(__dynCache.keys().next().value as string);
    }
  }
  return page;
}

// Pages/_middleware.rose: a Web-standard request handler that runs before every render on the server (pages, POSTs, api calls alike).
export const middleware = ${middlewareIdx >= 0 ? 'middlewareMod.handle ?? null' : 'null'};

// Routes whose DOCUMENTS ship without the client bundle ( decided by the compiler since #29): HTML + CSS only - no runtime, no state script.
export const noJsRoutes = [
  ${pages.filter(({ i }) => routeNoJs(i)).map(({ info }) => `'${info.pattern}'`).join(',\n  ')}
];

export function isNoJs(pathname) {
  return noJsRoutes.some((pattern) => matchRoute(pattern, pathname));
}

// P0-2 (bug report): routes that exported "buffer = true".
export function isBuffered(pathname) {
  return routes.some((route) => (route.buffer || route.signal) && matchRoute(route.pattern, pathname));
}


export const routeHeaders = [
  ${pages.filter(({ i }) => compiled[i].headers).map(({ info, i }) => `{ pattern: '${info.pattern}', headers: ${JSON.stringify(compiled[i].headers)} }`).join(',\n  ')}
];

export function headersFor(pathname) {
  const hit = routeHeaders.find((r) => matchRoute(r.pattern, pathname));
  return hit ? hit.headers : null;
}


export const cspNonceRoutes = [
  ${pages.filter(({ i }) => compiled[i].cspNonce).map(({ info }) => `'${info.routePath}'`).join(',\n  ')}
];

export function cspNonce(pathname) {
  return cspNonceRoutes.some((pattern) => matchRoute(pattern, pathname));
}

// A Web-standard Request from whatever the host provides: the edge adapter passes one already; the Node server passes its IncomingMessage (plus).
function toWebRequest(raw, form) {
  if (raw instanceof Request) return raw;
  const init = { method: raw.method || 'GET', headers: new Headers(raw.headers || {}) };
  if (form) init.body = form;
  return new Request('http://' + (raw.headers?.host || 'localhost') + (raw.url || '/'), init);
}


export async function runMiddleware(rawReq, form) {
  resetRequestContext();
  if (!middleware || !rawReq) return null;
  const res = await middleware(toWebRequest(rawReq, form));
  return res || null;
}

const routes = [
  ${serverRoutes}
];

// API routes (pages/api/*.rose): pattern -> HTTP-method handlers. They never render HTML and never reach the client bundle.
const apiRoutes = [
  ${apiRoutes.map(({ info, i }) => {
    const handlers = (compiled[i].apiMethods ?? []).map((n) => `${n}: ${n}_${i}`).join(', ');
    return `{ pattern: '${info.pattern}', path: '${info.routePath}', handlers: { ${handlers} } }`;
  }).join(',\n  ')}
];

// Not-found pages, deepest segment first: the root 404.rose ('/') and any
// pages/<seg>/_notfound.rose, each already composed with its layout chain.
// notFoundFor picks the nearest one up the path - an /admin miss answers
// the admin 404, a public miss the site's - and notFoundPage is the whole
// answer (real 404 status, or the built-in plain 404 when the app has none).
const notFoundRoutes = ${notFoundTable};
const notFoundFor = (pathname) => {
  for (const [prefix, render] of notFoundRoutes) {
    if (prefix === '/' || pathname === prefix || pathname.startsWith(prefix + '/')) return render;
  }
  return null;
};

const notFoundFlags = (pathname) => {
  for (const [prefix, render, flags] of notFoundRoutes) {
    if (prefix === '/' || pathname === prefix || pathname.startsWith(prefix + '/')) return flags || null;
  }
  return null;
};
const notFoundPage = async (pathname) => {
  const nf = notFoundFor(pathname);
  if (nf) {
    const page = await renderFallback(pathname, nf);
    // __notFound stamps the document so the client boot paints THIS route instead of re-rendering the matched one: a catch-all whose resolver threw.
    return { ...page, ...(notFoundFlags(pathname) || {}), status: 404, state: JSON.stringify({ __notFound: true, ...JSON.parse(page.state) }) };
  }
  return { html: '<h1>404</h1><p>Page not found</p>', state: JSON.stringify({ __route: pathname, __notFound: true }), head: [], status: 404, ...docAttrs(pathname) };
};


// whose render throws degrades to this instead of failing the response.
const errorPage = ${errorRender};


export function docAttrs(pathname) {
  for (const route of routes) {
    if (!matchRoute(route.pattern, pathname)) continue;
    const parts = route.pattern.split('/');
    const langIdx = parts.indexOf(':lang');
    if (langIdx >= 0) {
      const lang = pathname.split('/')[langIdx];
      if (isLocale(lang)) return { lang, dir: localeDir(lang) };
    }
    break; 
  }
  return { lang: defaultLocale, dir: localeDir(defaultLocale) };
}

// Paint a fallback page (404/500) and serialize its state.
async function renderFallback(pathname, render) {
  // Split mode: the not-found entry's render is a loader object — resolve it through getRender (which memoizes the composed function) exactly like.
  let fn = render;
  if (typeof fn !== 'function' && fn && typeof fn.load === 'function') {
    
    // { render } once the route's chunk graph is loaded
    fn = (await fn.load()).render;
  }
  const { html, head } = extractHead(await fn([], ''));
  const state = JSON.stringify({ __route: pathname, ...JSON.parse(serializeState()) });
  return { html, state, head, ...docAttrs(pathname) };
}

export function matchRoute(pattern, pathname) {
  // Q0 (bug report): one canonical URL per route.
  pathname = pathname.replace(/\\/+$/, '') || '/';
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  
  const last = patternParts[patternParts.length - 1];
  if (last && (last.startsWith('*') || last.startsWith('**'))) {
    const fixed = patternParts.slice(0, -1);
    if (pathParts.length < fixed.length) return false;
    if (last.startsWith('*') && !last.startsWith('**') && pathParts.length === fixed.length) return false;
    for (let i = 0; i < fixed.length; i++) {
      if (fixed[i].startsWith(':')) continue;
      if (fixed[i] !== pathParts[i]) return false;
    }
    return true;
  }
  if (patternParts.length !== pathParts.length) return false;
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) continue;
    if (patternParts[i] !== pathParts[i]) return false;
  }
  return true;
}

// Head blocks (one per component in the route chain) are pulled out of the page html: the shell injects them into <head>.
function extractHead(rendered) {
  const head = [];
  const html = rendered.replace(/<!--\u27e6h:(\\d+)\u27e7-->([\\s\\S]*?)<!--\u27e6\\/h:\\1\u27e7-->/g, (_, id, content) => {
    head.push(content);
    return '<!--\u27e6h:' + id + '\u27e7--><!--\u27e6/h:' + id + '\u27e7-->';
  });
  return { html, head };
}

// Form: the submitted FormData of a progressive-enhancement POST.
export async function renderPage(pathname, form) {
  clearRequestState();
  for (const route of routes) {
    if (matchRoute(route.pattern, pathname)) {
      const patternParts = route.pattern.split('/');
      const pathParts = pathname.split('/');
      for (let i = 0; i < patternParts.length; i++) {
        const seg = patternParts[i];
        if (seg.startsWith(':')) setState(seg.slice(1), pathParts[i]);
        
        
        else if (seg.startsWith('*')) setState(seg.replace(/^\\*+/, ''), pathParts.slice(i));
      }
 // I18n: a [lang] segment naming no dictionary is a 404 - the URL is the contract.
      const langIdx = patternParts.indexOf(':lang');
      if (langIdx >= 0 && !isLocale(pathParts[langIdx])) {
        return await notFoundPage(pathname);
      }
 
      
      const docLang = langIdx >= 0 ? pathParts[langIdx] : defaultLocale;
 // The action dispatch. The page's guard (exported beforeAction) runs FIRST and vetoes with an ActionError - the action-level permission check.
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
                // An incremental patch is RECORDED, not applied: the render's own state declarations apply.
                if (v instanceof StateDelta) setStateDelta(key, v);
                else setState(key, v);
              }
            }
          } catch (err) {
            if (err instanceof ActionError) {
              setState('actionError', { action: actionName, message: err.message, code: err.code, field: err.field });
              actionStatus = err.code;
            } else if (err && err.__rosefn === 'redirect') {
              
              return { redirect: err.path, status: err.status ?? 303, ...docAttrs(pathname) };
            } else if (err && err.__rosefn === 'notFound') {
              return await notFoundPage(pathname);
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
        // The control-flow pair: redirect() and notFound() are THROWN from inside the render (a $data body resolving a slug that no longer exists).
        const signal = err && err.__rosefn;
        if (signal === 'redirect') {
          return { redirect: err.path, status: err.status ?? 307, ...docAttrs(pathname) };
        }
        if (signal === 'notFound') {
          return await notFoundPage(pathname);
        }
        console.error('Rosefn: render failed for', pathname, err instanceof Error ? err.message : err);
        // F10: in dev the response body carries the real error — message, file:line and the fix hint.
        let devDetail = '';
        if (process.env.ROSEFN_DEV === '1' && err) {
          const msg = esc(err instanceof Error ? err.message : String(err));
          const file = esc(String(err.file || ''));
          const line = err.line != null ? esc(String(err.line)) : '';
          const hint = esc(String(err.hint || ''));
          const stack = esc(err instanceof Error ? (err.stack || '').split('\\n').slice(1, 7).join('\\n') : '');
          devDetail = '<div style="margin:24px auto;max-width:860px;font:13px/1.6 ui-monospace,monospace;background:#1b1b1f;color:#e6e6ea;border:1px solid #3a3a42;border-radius:10px;padding:20px 24px;text-align:left;white-space:pre-wrap;word-break:break-word">'
            + '<div style="font:600 15px/1.4 system-ui,sans-serif;color:#ff8b8b">Render failed: ' + esc(pathname) + '</div>'
            + '<div style="margin:10px 0 0;color:#ffd479">' + msg + '</div>'
            + (file ? '<div style="margin:6px 0 0;color:#9ad1ff">' + file + (line ? ':' + line : '') + '</div>' : '')
            + (hint ? '<div style="margin:10px 0 0;color:#9fe8b0">Fix: ' + hint + '</div>' : '')
            + (stack ? '<pre style="margin:12px 0 0;color:#8f8f9a">' + stack + '</pre>' : '')
            + '</div>';
        }
        if (errorPage) {
          const fb = await renderFallback(pathname, errorPage);
          return { ...fb, html: fb.html + devDetail, status: 500 };
        }
        return { html: '<h1>500</h1><p>Something went wrong rendering this page.</p>' + devDetail, state: '{}', head: [], status: 500, ...docAttrs(pathname) };
      }
      // __route tells the bootstrap which route this document was rendered for.
      const state = JSON.stringify({ __route: pathname, ...JSON.parse(serializeState()) });
 // Csr ( auto since #29): false when the compiler found nothing in the route's chain that needs the client (or the route asserted csr = false) .
      return { html: rendered.html, state, head: rendered.head, status: actionStatus || 200, csr: route.csr !== false, shell: route.shell !== false, lang: docLang, dir: localeDir(docLang) };
    }
  }
  
  
  return await notFoundPage(pathname);
}

// Would renderPageStream handle this path? (matched route = stream, anything
// else = buffered 404/500). Lets the servers pick the path before headers.
export function canStream(pathname) {
  return routes.some((route) => {
    if (!matchRoute(route.pattern, pathname)) return false;
 // I18n: an unknown locale must answer 404, and a streamed response cannot change its status - so it takes the buffered path (renderPage returns).
    const langIdx = route.pattern.split('/').indexOf(':lang');
    return langIdx < 0 || isLocale(pathname.split('/')[langIdx]);
  });
}


export function shellOff(pathname) {
  return routes.some(
    (route) => route.shell === false && matchRoute(route.pattern, pathname),
  );
}

// === API routes === The /api namespace answers JSON, never HTML: an API client that hits an unknown path must not receive the SPA shell.
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
      try {
        return toResponse(await fn(request));
      } catch (err) {
        
        const signal = err && err.__rosefn;
        if (signal === 'redirect') {
          return new Response(JSON.stringify({ error: 'redirect', location: err.path }), {
            status: err.status ?? 307,
            headers: { 'content-type': 'application/json', location: err.path },
          });
        }
        if (signal === 'notFound') {
          return new Response(JSON.stringify({ error: 'not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw err;
      }
    }
  }
  return new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

// === Streaming SSR === The static shell (doctype, <head>, body + container open) flushes BEFORE the - possibly slow - render completes: the first byte.
export async function renderPageStream(pathname, write, shellOpen, clientTag) {
  clearRequestState();
  for (const route of routes) {
    if (matchRoute(route.pattern, pathname)) {
      const patternParts = route.pattern.split('/');
      const pathParts = pathname.split('/');
      for (let i = 0; i < patternParts.length; i++) {
        const seg = patternParts[i];
        if (seg.startsWith(':')) setState(seg.slice(1), pathParts[i]);
        
        
        else if (seg.startsWith('*')) setState(seg.replace(/^\\*+/, ''), pathParts.slice(i));
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
        
        console.error('Rosefn: render failed for', pathname, err instanceof Error ? err.message : err);
        // F10: dev carries the real error in the body here too — the shell
        // is out, so the detail rides after the error page body.
        let devDetail = '';
        if (process.env.ROSEFN_DEV === '1' && err) {
          const msg = esc(err instanceof Error ? err.message : String(err));
          const file = esc(String(err.file || ''));
          const line = err.line != null ? esc(String(err.line)) : '';
          const hint = esc(String(err.hint || ''));
          const stack = esc(err instanceof Error ? (err.stack || '').split('\\n').slice(1, 7).join('\\n') : '');
          devDetail = '<div style="margin:24px auto;max-width:860px;font:13px/1.6 ui-monospace,monospace;background:#1b1b1f;color:#e6e6ea;border:1px solid #3a3a42;border-radius:10px;padding:20px 24px;text-align:left;white-space:pre-wrap;word-break:break-word">'
            + '<div style="font:600 15px/1.4 system-ui,sans-serif;color:#ff8b8b">Render failed: ' + esc(pathname) + '</div>'
            + '<div style="margin:10px 0 0;color:#ffd479">' + msg + '</div>'
            + (file ? '<div style="margin:6px 0 0;color:#9ad1ff">' + file + (line ? ':' + line : '') + '</div>' : '')
            + (hint ? '<div style="margin:10px 0 0;color:#9fe8b0">Fix: ' + hint + '</div>' : '')
            + (stack ? '<pre style="margin:12px 0 0;color:#8f8f9a">' + stack + '</pre>' : '')
            + '</div>';
        }
        html = errorPage ? extractHead(await errorPage([], '')).html + devDetail : '<h1>500</h1><p>Something went wrong rendering this page.</p>' + devDetail;
      }
      write(html);
 // Csr: false ( auto since #29): a no-JS route's document ends here - no state script, no inlined bundle.
      if (route.csr === false) {
        write('</div>\\n</body>\\n</html>');
        return 200;
      }
      const state = JSON.stringify({ __route: pathname, ...JSON.parse(serializeState()) });
      // P1-6 (bug report): the JSON data block is embedded in the document.
      const stateSafe = state.replace(/</g, '\\\\u003c');
      write('</div>\\n  <script type="application/json" id="__rosefn_state">' + stateSafe + '</script>\\n  ' + clientTag + '\\n</body>\\n</html>');
      return 200;
    }
  }
  return 404;
}
// Prevent tree-shaking of invalidateRenderCache (called from prod-server.ts / edge.ts on non-GET writes).
void invalidateRenderCache;
`;
  try {
    const patterns = [...pages, ...apiRoutes].map(({ info }) => info.pattern);
    const uniq = [...new Set(patterns)].sort();
    const lit = uniq.map((p) => JSON.stringify(p)).join(" | ") || "'/'";
    const paramsOf = (pattern: string): string[] =>
      (pattern.match(/:[\w]+|\*\*[\w]+|\*[\w]+/g) ?? []).map((m) => m.replace(/^[*:]+/, ""));
    const paramSig = uniq
      .map((p) => {
        const ps = paramsOf(p);
        if (!ps.length) return "";
        return "  " + JSON.stringify(p) + ": { " + ps.map((n) => n + ": string | number").join("; ") + " };\n";
      })
      .join("");
    const outDirTs = path.join(root, "src", ".rosefn");
    await fs.promises.mkdir(outDirTs, { recursive: true });
    const srcLines = [
      "// GENERATED by rosefn build - do not edit.",
      "export type RoutePath = " + lit + ";",
      "export const routePatterns = " + JSON.stringify(uniq) + " as const;",
      "export type RouteParams = {",
      paramSig,
      "};",
      "/** Build a URL from a route pattern and its params. */",
      "export function url(",
      "  path: RoutePath,",
      "  params: RouteParams[keyof RouteParams] = {} as never,",
      "): string {",
      "  let out = path as string;",
      "  for (const [k, v] of Object.entries(params as Record<string, string | number>)) {",
      "    out = out.replace(new RegExp('[:*]+' + k, 'g'), String(v));",
      "  }",
      "  return out;",
      "}",
    ].join("\n") + "\n";
    await fs.promises.writeFile(path.join(outDirTs, "routes.ts"), srcLines);
  } catch { /* types are a convenience: never fail the build over them */ }

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

  await esbuild.build({
    entryPoints: [(() => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      for (const cand of [path.join(here, '..', 'cli', 'prod-server.ts'), path.join(here, '..', 'src', 'cli', 'prod-server.ts')]) {
        if (fs.existsSync(cand)) return cand;
      }
      return path.join(here, '..', 'cli', 'prod-server.ts');
    })()],
    bundle: true,
    outfile: path.join(outDir, 'prod.mjs'),
    format: 'esm',
    platform: 'node',
    write: true,
    banner: {
      js: "import { createRequire } from 'node:module'; import { fileURLToPath as __f2p } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = createRequire(import.meta.url); const __filename = __f2p(import.meta.url); const __dirname = __dn(__filename);"
    },
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
? `\n// the app asked for web-vitals - measure once, at boot, and let the\n// app decide where the numbers go (one 'rosefn:vitals' CustomEvent per metric).\nreportVitals();\n`
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
import { setState, resumeState, clearRequestState, resetEffects, wire, isolateStateAsync, restoreState, setRefreshHook, clearMounts, flushMounts, adoptCleanups, handlers, setActionDispatcher, setLocales, setLocalePacks, ensureLocale, isLocale, localeDir, setPrefetchOverride, serializeState, setFxOwner, resetContainerFx, esc } from './runtime.js';

// I18n: the dictionaries baked at build time - the client renders any PRELOADED locale from the bundle.
setLocales(${clientLocalesJson}, '${defaultLocale}');
setLocalePacks(${JSON.stringify(packed)});
${hasLang ? `// the default locale, kept beside setLocales' own copy so <html lang> can
// follow a route that carries no [lang] segment (a non-i18n page)
const __defLocale = '${defaultLocale}';` : ''}
${vitalsOn ? `// the app asked for web-vitals. The import is what keeps\n// reportVitals alive through minification and tree-shaking; the call is one\n// statement at boot, before the first render.\nimport { reportVitals } from './runtime.js';`: ''}
// The two pack doors, re-exported for an app that wants to warm a language before its visitor asks for it (ensureLocale) or to feed a dictionary.
export { ensureLocale, loadLocale } from './runtime.js';
${vitalsBlock}

const routes = [
  ${clientRoutes}
];

// === Mode B: lazy route chunks === Split mode's registry entries arrive without a render function: loadChain loads the route's module graph (the page).
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

// Not-found pages, deepest segment first (the server's table, client half): the root 404.rose ('/') and any pages/<seg>/_notfound.rose.
const notFoundRoutes = ${notFoundTable};
const notFoundFor = (pathname) => {
  for (const [prefix, render] of notFoundRoutes) {
    if (prefix === '/' || pathname === prefix || pathname.startsWith(prefix + '/')) return render;
  }
  return null;
};

// Pages/500.rose (with its layouts) or null -> built-in plain 500: a route whose render throws on the client degrades to this instead of breaking.
const errorPage = ${errorRender};

// Paint a fallback page (404/500) into the container, wired like any render.
async function paintFallback(container, page, builtin, keepState = false) {
  if (!keepState) __navReset(container);
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


export async function startNotFound(container, pathname) {
  const el = document.getElementById('__rosefn_state');
  if (el) resumeState(el.textContent);
  await paintFallback(container, notFoundFor(pathname), '<h1>404</h1><p>Page not found</p>', true);
}

export function matchRoute(pattern, pathname) {
  // Q0 (bug report): one canonical URL per route.
  pathname = pathname.replace(/\\/+$/, '') || '/';
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  
  const last = patternParts[patternParts.length - 1];
  if (last && (last.startsWith('*') || last.startsWith('**'))) {
    const fixed = patternParts.slice(0, -1);
    if (pathParts.length < fixed.length) return false;
    if (last.startsWith('*') && !last.startsWith('**') && pathParts.length === fixed.length) return false;
    for (let i = 0; i < fixed.length; i++) {
      if (fixed[i].startsWith(':')) continue;
      if (fixed[i] !== pathParts[i]) return false;
    }
    return true;
  }
  if (patternParts.length !== pathParts.length) return false;
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) continue;
    if (patternParts[i] !== pathParts[i]) return false;
  }
  return true;
}

// === Link prefetch === Hover / focus / touch an internal link and the target route renders NOW - $data included - against a throwaway signal map.
let prefetchMode = ${JSON.stringify(prefetchMode)};
export function setPrefetchMode(mode) { prefetchMode = mode; }
const PREFETCH_BUDGET = 8;
const PREFETCH_MAX_CACHED = 4;
const prefetchCache = new Map(); 
let prefetchQueue = Promise.resolve();
let prefetchPending = 0;


async function applyParams(route, pathname) {
  const patternParts = route.pattern.split('/');
  const pathParts = pathname.split('/');
  for (let i = 0; i < patternParts.length; i++) {
    const seg = patternParts[i];
    if (seg.startsWith(':')) setState(seg.slice(1), pathParts[i]);
    
    
    else if (seg.startsWith('*')) setState(seg.replace(/^\\*+/, ''), pathParts.slice(i));
  }
  const langIdx = patternParts.indexOf(':lang');
  if (langIdx >= 0) await ensureLocale(pathParts[langIdx]);
}


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
  if (pathname === location.pathname) return; 
  const route = routes.find((r) => matchRoute(r.pattern, pathname));
  if (!route) return;
  if (prefetchPending >= PREFETCH_BUDGET) return; // Budget spent: drop it, a later hover retries. P0-1: the link may carry a query (/search?q=cats)
  const qi = pathname.indexOf('?');
  const qOverride = qi >= 0 ? Object.fromEntries(new URLSearchParams(pathname.slice(qi))) : null;
  const p = prefetchQueue.then(async () => {
    try {
      setPrefetchOverride(qOverride);
      // The isolated render also captures the onMount callbacks the route queued and the onCleanup disposers it registered: the paint that consumes.
      const { result, state, mounts, cleanups } = await isolateStateAsync(async () => {
        await applyParams(route, pathname); // a packed locale's dictionary lands before the render
        const closes = [];
        const render = await getRender(route); 
        const html = await render(closes, '');
        return { html, closes };
      });
      const entry = { ...result, state, mounts, cleanups };
      prefetchCache.set(pathname, entry); // Promise -> result. evict oldest-first; in-flight promises are never evicted (evicting. one would only force a duplicate render)
      while (prefetchCache.size > PREFETCH_MAX_CACHED) {
        const oldest = prefetchCache.keys().next().value;
        if (prefetchCache.get(oldest) instanceof Promise) break;
        prefetchCache.delete(oldest);
      }
      return entry;
    } catch {
      prefetchCache.delete(pathname); 
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

// One delegated listener per event type on the app container: survives DOM swaps and cloned blocks, so handlers never need re-binding.
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

// === Server actions from any event === POST the body to the current route and adopt the response in place: the server runs the selected action.
async function postForm(body, container, pathname) {
 
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

// Call a page's server action by name from any event handler: <button on:click={like}> compiles to $action('like').
export async function $action(name, e) {
  if (e && e.preventDefault) e.preventDefault();
  const body = new FormData();
  body.append('__action', name);
 // An event inside a mount belongs to that mount - the attribute is kept in step with what is currently mounted.
  const box = e && e.target && e.target.closest ? e.target.closest('[data-rosefn]') : null;
  return postForm(body, box || undefined, box ? box.getAttribute('data-rosefn') : undefined);
}
// F17: hand the dispatcher to the runtime, so wire() can serve a server action bound to a non-delegated event (on:keydown="$action:save") the same way.
setActionDispatcher($action);

export { postForm };

// The live signal graph as JSON - the same serializeState the zero-hydration resume uses.
export { serializeState };

// Initial=true: adopt the SSR DOM (zero hydration) - wire reactive markers to the existing nodes and bind events.


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
// View Transition on SPA swaps (B9): the DOM swap rides one cross-fade when the browser supports it; reduced-motion users and environments without.
async function __swap(container, html) {
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof document.startViewTransition === 'function' && !reduce) {
    const vt = document.startViewTransition(() => { container.innerHTML = html; });
    await vt.updateCallbackDone.catch(() => {});
  } else {
    container.innerHTML = html;
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
      // I18n: an unknown locale paints the 404 page, same as the server (before the prefetch check: a cached entry for a bogus locale is discarded).
      const langIdx = route.pattern.split('/').indexOf(':lang');
${langDirBlock}
        await paintFallback(container, notFoundFor(pathname), '<h1>404</h1><p>Page not found</p>');
        return;
      }
      // Prefetched on hover/focus/touch: the render already ran, so paint its HTML and adopt its signal entries - events then patch the very nodes we.
      let hit = initial ? undefined : prefetchCache.get(pathname);
      if (hit && typeof hit.then === 'function') hit = await hit; // in-flight: land it first
      if (hit) {
        prefetchCache.delete(pathname); 
        __navReset(container);
        restoreState(hit.state);
        await __swap(container, hit.html);
        await __withOwner(container, () => {
          wire(container, hit.closes);
          bindEvents(container);
          hit.mounts.forEach((fn) => fn()); 
          adoptCleanups(hit.cleanups); 
        });
        return;
      }
      if (!initial) __navReset(container);
      let broken = false;
      let signal = null;
      await __withOwner(container, async () => {
        await applyParams(route, pathname);
        const closes = [];
        let html;
        try {
          const render = await getRender(route); 
          html = await render(closes, '');
        } catch (err) {
          
          if (err && err.__rosefn === 'notFound') { signal = 'notFound'; return; }
          if (err && err.__rosefn === 'redirect') { signal = err.path; return; }
          
          
          console.error('Rosefn: client render failed for', pathname, err instanceof Error ? err.message : err);
          broken = true;
          return;
        }
        if (!initial) await __swap(container, html);
        wire(container, closes);
        bindEvents(container);
        flushMounts();
      });
      if (signal === 'notFound') {
        // T17: a client-side render of a $data route without a prefetch entry has no data source (the server fills the context bag) - the correct.
        if (!initial) { try { location.assign(pathname); return; } catch {  } }
        await paintFallback(container, notFoundFor(pathname), '<h1>404</h1><p>Page not found</p>');
        return;
      }
      if (signal) {
        location.href = signal; 
        return;
      }
      if (broken) {
        await paintFallback(container, errorPage, '<h1>500</h1><p>Something went wrong rendering this page.</p>');
      }
      return;
    }
  }
  // Unmatched route: the nearest not-found page renders (with its head + interactivity) - a segment's _notfound.rose or the root 404.rose - else //.
${hasLang ? ` // the same app-root gate as above - a mount never touches the
  // host document's language or direction.
  if (container === document.getElementById('app')) {
    document.documentElement.lang = __defLocale;
    document.documentElement.removeAttribute('dir');
  }` : ''}
  await paintFallback(container, notFoundFor(pathname), '<h1>404</h1><p>Page not found</p>');
}

// Adopt a server-rendered response in place - the JS-enabled half of progressive-enhancement forms: the bootstrap POSTs a <form method="POST">.
export async function adopt(container, html, stateJson, pathname) {
 
  
  const route0 = pathname || location.pathname;
  __navReset(container);
  clearMounts(); // stale mounts from a failed render never fire
  resumeState(stateJson);
  container.innerHTML = html;
  
  const st = document.getElementById('__rosefn_state');
  if (st) st.textContent = stateJson;
  for (const route of routes) {
    if (matchRoute(route.pattern, route0)) {
      await __withOwner(container, async () => {
        await applyParams(route, route0);
        const closes = [];
        try {
          const render = await getRender(route); 
          await render(closes, '');
        } catch {
          
          
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
// === refresh() implementation === Re-render the current route in place: the client half of router.refresh() (a router refresh) / (a full invalidation).
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
  const warnGroups = new Map<string, { why: string; files: Map<string, Set<string>> }>();
  for (const { info, i } of pages) {
    if (!routeShipsNoJs(infos, compiled, i)) continue;
    for (const ci of [i, ...layoutsOf(infos, i)]) {
      for (const w of compiled[ci].jsWarnings ?? []) {
        let g = warnGroups.get(w);
        if (!g) {
          g = { why: w, files: new Map() };
          warnGroups.set(w, g);
        }
        const file = path.relative(root, infos[ci].filePath).replace(/\\/g, '/');
        let routes = g.files.get(file);
        if (!routes) {
          routes = new Set();
          g.files.set(file, routes);
        }
        routes.add(info.routePath);
      }
    }
  }
  for (const g of warnGroups.values()) {
    const allRoutes = new Set<string>();
    for (const routes of g.files.values()) for (const r of routes) allRoutes.add(r);
    const parts = [...g.files.entries()]
      .sort((a, b) => b[1].size - a[1].size)
      .map(([file, routes]) => `${file} (${routes.size === 1 ? [...routes][0] : `${routes.size} routes`})`);
    const shown = parts.slice(0, 4).join(', ');
    const more = parts.length > 4 ? `, +${parts.length - 4} more files` : '';
    console.warn(`Rosefn warning: ${allRoutes.size} routes ship zero JavaScript while their chain contains ${g.why} - ${shown}${more}`);
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
  const isNotFound = !isComponent && (base === '404' || base === '_notfound');
  const isError = !isComponent && base === '500';
  const isApi = !isComponent && (withoutExt === 'api' || withoutExt.startsWith('api/'));
  const isMiddleware = !isComponent && withoutExt === '_middleware';

  let parts = withoutExt.split('/').filter((p) => p !== '_layout' && p !== '_notfound');
  if (parts.length > 1 && parts[parts.length - 1] === 'index') parts = parts.slice(0, -1);
  const CATCH_ALL = /^\[\.\.\.(\w+)\]$/;
  const OPTIONAL_CATCH_ALL = /^\[\[\.\.\.(\w+)\]\]$/;
  const routeParts = parts.map((part) => {
    const optional = OPTIONAL_CATCH_ALL.exec(part);
    if (optional) return `**${optional[1]}`;
    const catchAll = CATCH_ALL.exec(part);
    if (catchAll) return `*${catchAll[1]}`;
    return part.startsWith('[') && part.endsWith(']') ? `:${part.slice(1, -1)}` : part;
  });

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
    paramNames: parts.flatMap((p) => {
      const optional = OPTIONAL_CATCH_ALL.exec(p);
      if (optional) return [optional[1]];
      const catchAll = CATCH_ALL.exec(p);
      if (catchAll) return [catchAll[1]];
      return p.startsWith('[') && p.endsWith(']') ? [p.slice(1, -1)] : [];
    }),
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
