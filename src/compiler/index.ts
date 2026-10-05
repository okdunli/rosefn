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

const COMPONENT_RE = /<script>([\s\S]*?)<\/script>/;
const TEMPLATE_RE = /<template>([\s\S]*?)<\/template>/;
// <head> block: per-route document metadata (title/meta/link), compiled
// without markers so the SSR output stays clean for <head> injection.
const HEAD_RE = /<head>([\s\S]*?)<\/head>/;
// <style> block: component CSS, scoped by a build-time attribute on the
// component's top-level elements and inlined into the document (zero
// stylesheet requests, same bet as the inlined JS bundle).
const STYLE_RE = /<style>([\s\S]*?)<\/style>/;
// A declaration's initializer may carry TypeScript: a type argument
// (`$state<Record<string, Post>>(...)`) and/or a cast (`$state(0) as
// Counter`). Both belong to the declaration and must be consumed with it -
// a generic list left in place makes the match fail (the declaration then
// ships verbatim and `$state` is not a real import: the name is never
// rewritten and reads it before initialization), and a cast left behind
// survives as a stray `as Counter` expression statement. The regex stops at
// `$state`/`$data`; the type-argument list is scanned (nesting and function
// types included) in extractDecls, where a regex cannot go.
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
  if (!name) throw new Error('<slot> with attributes must declare a name: <slot name="row" ... />');
  const pairs = [...attrs.matchAll(/\b(\w+)\s*=\s*\{([^}]*)\}/g)]
    .filter((m) => m[1] !== 'name')
    .map((m) => `['${m[1]}', (${m[2].trim()})]`);
  return `${JSON.stringify(name)}, [${pairs.join(', ')}]`;
}
// {#boundary}...{/boundary}: an error boundary - its content renders into
// its own string; a throw anywhere inside swaps in a fallback instead of
// failing the whole page. trade-off: one generic message, no per-boundary
// custom fallback yet - add {:fallback}...{/fallback} when an app needs it.
// Since a boundary whose content drives a server action also contains
// that action's failure, and the honest fallback for a business error is its
// message - which lives in the runtime ($boundaryFallback), so a boundary
// that catches no action keeps shipping the plain string and pays nothing.
const BOUNDARY_FALLBACK = '<p>This section failed to render.</p>';
// API route handlers are exported functions named by HTTP method
// (pages/api/*.rose). trade-off: function declarations only - an arrow-exported
// handler is a syntax error at import time, which is loud enough.
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
// A .rose <script> block is TypeScript: interfaces, annotations,
// `as`, generics. The compiler's intermediates therefore hold TypeScript,
// and esbuild must STRIP the types, not choke on them (a `.js` name made it
// parse `interface Post` as JavaScript and fail the build). The intermediates
// keep their .js names - the generated entry files import them by specifier
// and the deploy dir's static server never sees them - so the loader is
// overridden per build instead of renaming every file. esbuild's ts loader
// accepts everything the js loader does, so the compiler's own generated
// JavaScript parses unchanged under it.
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
  /** the component exports `prefetch = 'off' | 'hover' | 'viewport' | 'all'` (app-global link-prefetch strategy) */
  prefetch?: string;
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
      // string literal: copy verbatim
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
      // template literal: copy text verbatim, scan ${...} as code
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
      // comments: copy verbatim
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
      // identifier: rewrite bare state reads only
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
  return template.replace(/\{([^{}]*)\}/g, (whole, expr) =>
    `{${callifyStateReads(expr, names)}}`);
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
 */
export interface Plugin {
  name: string;
  transform?(code: string, filePath: string): string | Promise<string>;
  /** Before routing and middleware. Return a Response to short-circuit (auth wall, rate limit, maintenance page). */
  onRequest?(ctx: RequestHookContext): Response | void | Promise<Response | void>;
  /** After the response exists, before it is sent. Return a Response to replace it. */
  onResponse?(ctx: RequestHookContext, res: Response): Response | void | Promise<Response | void>;
  /** Worker start: open a connection pool, warm a cache. */
  onServe?(meta: { port: number; workers: number }): void | Promise<void>;
  /** Worker drain, before exit: close the pool. */
  onShutdown?(): void | Promise<void>;
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
 * next rebuild, and a missing file is simply "no plugins" (existence is
 * checked first, so a config with a syntax error still fails loudly).
 */
export async function loadPlugins(root: string): Promise<Plugin[]> {
  const file = path.join(root, 'rosefn.config.js');
  if (!fs.existsSync(file)) return [];
  const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  return (mod.default as Plugin[] | undefined) ?? [];
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
  const resolve = (spec: string): { index: number; scopeKey: string } => {
    const abs = path.resolve(path.dirname(fromFile), spec);
    const hit = registry.get(abs);
    if (!hit) {
      throw new Error(`${path.basename(fromFile)}: cannot import '${spec}' - no .rose file at ${abs}. A component lives under src/components/ (or src/pages/) and is imported by relative path.`);
    }
    return hit;
  };
  // A default import becomes a named one: the compiled module exports
  // `render`, and the parent's `<Card>` tag calls exactly that.
  let rewritten = script.replace(/import\s+(\w+)\s+from\s*(['"])([^'"]+\.rose)\2/g, (whole, name, q, spec) => {
    const hit = resolve(spec);
    imports.push({ name, specifier: spec, index: hit.index });
    return `import { render as ${name} } from ${q}__rose_${hit.index}__${q}`;
  });
  // A named import (`import { render as Card }`) keeps its clause; only the
  // specifier becomes the placeholder.
  rewritten = rewritten.replace(/import\s*(\{[^}]*\})\s*from\s*(['"])([^'"]+\.rose)\2/g, (whole, clause, q, spec) => {
    const hit = resolve(spec);
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
  // Same template extraction compileComponent does: a <template> block when
  // the file has one, otherwise everything that is not script/style/head.
  const noBlocks = src.replace(STYLE_RE, '');
  const tpl = noBlocks.match(TEMPLATE_RE)?.[1] ?? noBlocks.replace(HEAD_RE, '').replace(COMPONENT_RE, '').trim();
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
  if (buf) imports.push(buf.join('\n')); // unterminated import: keep it whole
  return { imports: imports.join('\n'), rest: rest.join('\n') };
}

export async function compileComponent(filePath: string, publicDir: string, scopeKey: string, isApi = false, plugins: Plugin[] = [], registry: RoseRegistry = new Map()): Promise<CompileResult> {
  let source = await fs.promises.readFile(filePath, 'utf-8');
 // Plugins see the raw source first: whatever they return
  // is what the compiler parses. A throwing plugin fails the build naming
  // itself and the file - a broken transform must never pass silently.
  for (const p of plugins) {
    // a runtime-only plugin (onRequest/onServe, no transform) has nothing to
    // rewrite - it must not break the build for lacking a build-time hook
    if (!p.transform) continue;
    try {
      source = await p.transform(source, filePath);
    } catch (err) {
      throw new Error(`plugin ${p.name} failed on ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // API route (pages/api/*.rose): no template, no state, no markers - the
  // script's exported functions ARE the handlers, kept verbatim so the
  // server/edge bundle can dispatch them by HTTP method. The only import is
  // getContext(): handlers read the middleware's per-request bag (auth on
  // data endpoints), and esbuild drops it when unused.
  if (isApi) {
    const scriptMatch = source.match(COMPONENT_RE);
    const rawScript = scriptMatch?.[1] ?? '';
    const apiMethods = [...rawScript.matchAll(/(?:^|\n)\s*export\s+(?:async\s+)?function\s+(\w+)\s*\(/g)]
      .map((m) => m[1])
      .filter((name) => HTTP_METHODS.has(name));
    // a handler that reads the request context cannot be baked: the bag is
    // per-request, a baked body would freeze one request's answer
    const usesContext = /getContext\s*\(/.test(rawScript);
    const hasPrerender = !usesContext && /(?:^|\n)\s*export\s+(?:const|let|var)\s+prerender\s*=\s*true\b/.test(rawScript);
    const hoisted = hoistImports(resolveRoseImports(rawScript, filePath, registry).script);
    return {
      ssr: '',
      client: '',
      stateKeys: [],
      actionNames: [],
      guardName: null,
      style: '',
      hasParams: false,
      api: `import { getContext } from './runtime.js';\n${rewriteRoseImports(`${hoisted.imports}\n${hoisted.rest}`, 'ssr').trim()}`,
      apiMethods,
      hasPrerender,
      usesContext,
    };
  }

  // strip the <style> block first: its CSS is scoped and inlined into the
  // shell, and it must not leak into the template (or the <head> scan)
  const styleMatch = source.match(STYLE_RE);
  const scopedStyle = styleMatch?.[1] ? scopeCss(styleMatch[1], scopeKey) : '';
  const sourceNoBlocks = source.replace(STYLE_RE, '');

  const scriptMatch = sourceNoBlocks.match(COMPONENT_RE);
 // Resolve `import Card from '../components/Card.rose'` against the
  // build registry before anything else looks at the script: the rewritten
  // specifier (a `__rose_N__` placeholder) is what the generators see, and an
  // unresolvable path fails the build here, naming the file and the import.
  const roseResolved = resolveRoseImports(scriptMatch?.[1] ?? '', filePath, registry);
  const rawScript = roseResolved.script;
  const roseImports = roseResolved.imports;
 // The imports (a component import above all) belong at module scope,
  // not inside render() - hoisted here, emitted by the generators.
  const { imports: importStmts, rest: scriptNoImports } = hoistImports(rawScript);
  // A component (src/components/*.rose) is not a route: the build marks it in
  // the registry with a `components/...` scope key, which is also the cheapest
  // reliable way to tell the two apart here.
  const isComponent = registry.get(filePath)?.scopeKey.startsWith('components/') ?? false;
 // Boundary, stated loudly at build time: a component renders INSIDE
  // its parent's template phase, which is synchronous by design (that is what
  // keeps wire() - and the whole zero-hydration resume - synchronous). $data
  // is an await, so it cannot live there. The rosefn answer is the one the
  // layout chain already uses: the route (or the middleware) fetches, and the
  // value rides down as a prop.
  if (isComponent && /\$data\s*\(/.test(rawScript)) {
    throw new Error(
      `${filePath}: $data() is not allowed in a component - an imported component renders synchronously inside its parent. ` +
      `Fetch in the page's $data (or pages/_middleware.rose) and pass the value down as a prop: <Card user={user()}>.`
    );
  }
  // getContext() in the script makes the route dynamic: the request bag is
  // per-request, so the build must not bake it and the servers must not
 // answer it from a prerendered file. $store earns the same
  // treatment for the same reason: the store is per-process mutable state, so
  // a baked document would freeze one worker's snapshot of it.
  const usesContext = /getContext\s*\(/.test(rawScript) || /\$store\s*\(/.test(rawScript);
  // an exported `params` marks a dynamic route for prerender enumeration
  const hasParams = /(?:^|\n)\s*export\s+(?:(?:const|let|var)\s+|(?:async\s+)?function\s+)params\b/.test(rawScript);
  // an exported `revalidate = N` opts the route into stale-while-revalidate:
  // the baked file is served for up to N seconds, then the preview server
 // answers stale and rebuilds in the background (ISR)
  const revalidateMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+revalidate\s*=\s*(\d+)\s*;?/);
  const revalidate = revalidateMatch ? Number(revalidateMatch[1]) : undefined;
  // P1: an exported `prefetch = '...'` sets the app-global
  // link-prefetch strategy - 'off', 'hover', 'viewport' or 'all' (the original
  // behavior: hover/focus/touch + viewport/idle). Validated here like headers:
  // a typo would silently disable prefetching with no other signal.
  const prefetchMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+prefetch\s*=\s*['"`](\w+)['"`]\s*;?/);
  const prefetch = prefetchMatch ? prefetchMatch[1] : undefined;
  if (prefetch && !['off', 'hover', 'viewport', 'all'].includes(prefetch)) {
    throw new Error(`${filePath}: export const prefetch must be 'off', 'hover', 'viewport' or 'all'`);
  }
 // The bundle mode - the fix for the large-app
  // architecture gap. 'inline' (the default) is the single-document mode:
  // the whole client bundle rides inside the HTML, one request, zero
  // hydration. 'split' is mode B: every route module becomes its own chunk,
  // loaded on demand, and the document references /client.js externally -
  // the document stops growing with the app. Declared once (the root
  // layout), validated like headers because a typo would silently keep the
  // wrong mode.
  const bundleMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+bundle\s*=\s*['"`](\w+)['"`]\s*;?/);
  const bundle = bundleMatch ? bundleMatch[1] : undefined;
  if (bundle && !['inline', 'split'].includes(bundle)) {
    throw new Error(`${filePath}: export const bundle must be 'inline' or 'split'`);
  }
 // The compiler decides zero-JS, not the developer. This is
  // the same "does anything here need the client bundle" predicate that
 // Used to REFUSE `csr = false`: event wiring in the
  // template, lifecycle/client APIs in the script, a server action (a form
  // target or $action), or a POST form (its in-place adopt is the
  // enhancement the bundle exists for). A route whose whole chain - the page
  // plus every layout - needs none of that ships a document with no runtime,
  // no state script and zero JavaScript, automatically: a blog post, an ISR
  // page, a localized page. `csr = true` forces the bundle back in (a
  // content page that still wants client-side navigation FROM itself);
  // `csr = false` asserts the route stays content-only and fails the build
  // the day it isn't. trade-off: syntactic, like every other check here - a
  // script that touches the DOM or mutates state outside an event handler is
  // the developer's promise (the same ceiling csr = false always had).
  // (Computed below, after actionNames: the predicate includes server
  // actions, which are only known once the exports are extracted.)
  // csr: explicit true = force the bundle in; explicit false = assert
  // content-only (build fails if it isn't); absent = the compiler decides
 // from needsClient .
  const csrMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+csr\s*=\s*(true|false)\s*;?/);
  const csr: boolean | undefined = csrMatch ? csrMatch[1] !== 'false' : undefined;
  if (csr === false) {
    const dead = /\son:[a-z]+\s*=/.exec(source) ?? /\b(?:onMount|onCleanup|refresh)\s*\(/.exec(rawScript);
    if (dead) {
      throw new Error(
        `${filePath}: csr = false cannot ship ${dead[0].trim()} - event wiring, onMount/onCleanup and refresh() all need the client bundle. ` +
        `(Forms still work without JS: a native POST runs the server action.)`
      );
    }
  }

  // An exported `headers = { ... }` sets this route's response headers
 // - the servers merge them OVER the framework defaults
  // (the strict CSP), so an app can tighten or relax the policy per route.
  // Flat string map only, validated here: a non-string value would ship
  // verbatim into the server bundle and blow up at request time.
  let headers: Record<string, string> | undefined;
  const headersLiteral = extractObjectLiteral(rawScript, 'headers');
  if (headersLiteral) {
    let value: unknown;
    try {
      value = new Function(`return ${headersLiteral}`)();
    } catch {
      throw new Error(`${filePath}: export const headers must be an object literal`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value as object).some((v) => typeof v !== 'string')) {
      throw new Error(`${filePath}: export const headers must be a flat map of string -> string`);
    }
    headers = value as Record<string, string>;
  }

  // Top-level `export` statements (e.g. `export const params = {...}` for
  // dynamic-route prerendering) are hoisted to module scope: the script body
  // itself is embedded inside render(), where export is a syntax error.
  // Every exported async function is a server-only action: it reaches the
  // SSR module but never the client bundle.
  const { clean: scriptNoExports, exports: exportStmts, actions, props, guard } = extractExports(scriptNoImports);
  const script = scriptNoExports;
  const actionNames = new Set(actions.map((a) => a.name));

 // Does anything in this component need the client bundle?
  // (The predicate documented at the csr flag above - it lives here because
  // it includes server actions, known only after the exports are extracted.)
 // Every rule that fires records its reason, so the build's
  // lint report can tell the developer WHY a route carries the runtime.
  const clientReasons: string[] = [];
  if (/\son:[a-z]+\s*=/.test(source)) clientReasons.push('event wiring (on:)');                       // event wiring in the template
  if (/<form[\s>]/.test(source)) clientReasons.push('a <form> (its in-place adopt is the enhancement)'); // a POST form
  const lifecycle = rawScript.match(/\b(?:onMount|onCleanup|refresh|adopt|\$action|\$setState)\s*\(/);
  if (lifecycle) clientReasons.push(`${lifecycle[0].replace(/\s*\($/, '')}()`);                        // lifecycle / client-only APIs
  if (actionNames.size > 0) {                                                                          // a server action (form target or $action)
    clientReasons.push(`server action${actionNames.size > 1 ? 's' : ''} (${[...actionNames].join(', ')})`);
  }
  const needsClient = clientReasons.length > 0;

 // The predicate is SYNTACTIC, so a component that ships no
  // runtime is scanned for the shapes that would silently need one - an
  // inline on* attribute or a javascript: URL cannot fire without the bundle,
  // and eval/new Function is client code by definition. The route-level
  // check in buildProject decides whether the warning is real (the document
  // must actually be JS-free for the handler to be dead code).
  const jsWarnings: string[] = [];
  if (!needsClient) {
    if (/\son[a-z]+\s*=\s*["'][^"']*["']/i.test(source)) {
      jsWarnings.push('an inline on* attribute (e.g. onclick="...") - it cannot fire without the bundle; use on:click or set csr = true');
    }
    if (/javascript:/i.test(source)) {
      jsWarnings.push('a javascript: URL - it needs the bundle to run; link to a real route');
    }
    if (/\b(?:eval|new Function)\s*\(/.test(rawScript)) {
      jsWarnings.push('eval()/new Function() - client code the predicate cannot see');
    }
    // Browser-only globals. The script block is embedded inside render() on
    // BOTH sides, and a JS-free document never ships it to the browser: most
    // of these throw on the server (a loud 500), but the dual-existence
    // names (the timers, navigator) run there and the client effect the
    // developer wanted silently never happens. The predicate cannot see the
    // intent either way - say it out loud.
    if (/\b(?:document|window|localStorage|sessionStorage)\s*\.|\b(?:add|remove)EventListener\s*\(|\brequestAnimationFrame\s*\(|\bMutationObserver\b|\bnavigator\s*\.|\blocation\s*\.\s*(?:href|assign|replace|reload|pathname|search|hash|origin)\b|\b(?:setTimeout|setInterval)\s*\(/.test(rawScript)) {
      jsWarnings.push('browser-only code (document./window./addEventListener/a timer/...) - a JS-free document never ships this script to the browser, so it throws on the server or runs there and never reaches the client; if the route needs the browser, set csr = true');
    }
  }

  const templateMatch = sourceNoBlocks.match(TEMPLATE_RE);
  // strip the <head> block so it never leaks into the page template
  const headMatch = sourceNoBlocks.match(HEAD_RE);
  const headContent = headMatch?.[1] ?? '';
  const sourceNoHead = sourceNoBlocks.replace(HEAD_RE, '');
  const rawTemplate = templateMatch
    ? templateMatch[1]
    : sourceNoHead.replace(COMPONENT_RE, '').trim();
  // a component with styles carries its scope attribute on every top-level
  // element, so its rules match only its own subtree
  const template = scopedStyle
    ? injectScopeAttr(inlineImages(rawTemplate, publicDir), scopeKey)
    : inlineImages(rawTemplate, publicDir);

  // Extract state / data declarations with balanced-paren scanning
  const decls = extractDecls(script);
  const stateDecls = decls.filter((d) => d.kind === 'state');

  // setter name per state: setCount
  const setterNames = new Map<string, string>();
  stateDecls.forEach((s) => setterNames.set(s.name, `set${capitalize(s.name)}`));

  // Extract event bindings from original template. Handlers bound to a
  // server action never reach the client registry: they compile to
  // data-on-*="$action:name" and dispatch through $action instead.
  const eventBindings: Array<{ event: string; fn: string }> = [];
  let em: RegExpExecArray | null;
  EVENT_RE.lastIndex = 0;
  while ((em = EVENT_RE.exec(template))) {
    if (!actionNames.has(em[2].trim())) eventBindings.push({ event: em[1], fn: em[2] });
  }

  // Remove declarations from script, rewrite $setState to setters
  let cleanScript = removeRanges(script, decls.map((d) => [d.start, d.end] as [number, number]));
  cleanScript = cleanScript.replace(SETSTATE_RE, (_, key, val) => {
    const trimmedKey = key.trim().replace(/^['"`]|['"`]$/g, '');
    const setter = setterNames.get(trimmedKey) || `set${capitalize(trimmedKey)}`;
    return `${setter}(${val})`;
  });

  // Replace bare state reads with getter calls (after decl removal). A plain
  // regex would also rewrite state names inside string literals - 'name' in
  // new FormData(f).get('name') becoming 'name()' - so scan the script and
  // skip strings, comments, and template-literal text (${} still rewrites).
  cleanScript = callifyStateReads(cleanScript, stateDecls.map((s) => s.name));

  // The template gets the same treatment: the script auto-calls a bare state
  // read, so `{liked}` must not silently render the getter's source text.
  // EXPRESSIONS ONLY - the word "likes" in prose stays prose (the same rule
  // the {#each} rename follows). This runs BEFORE the slot encoding below so
  // a slot prop that shadows a state name still resolves (the slot rewrite
  // happens on the already-called expression).
  const templateCalled = callifyTemplateExprs(template, stateDecls.map((s) => s.name));

  // on:event={fn} -> data-on-event="fn"; a handler that names a server
  // action becomes data-on-event="$action:fn" (dispatched by $action);
  // <slot /> -> block marker
 // A NAMED slot (<slot name="row" item={post} />) becomes a call of
  // the per-render __slot() helper the generators emit: array pairs, never an
  // object literal, because the template scanner cannot see nested braces.
  const ssrTemplate = templateCalled
    .replace(SLOT_NAMED_RE, (_w, attrs) => `{__slot(${encodeSlotCall(attrs)})}`)
    .replace(SLOT_RE, '{__slot__}')
    .replace(/on:(\w+)=\{([^}]+)\}/g, (_, ev, fn) =>
      actionNames.has(fn.trim()) ? `data-on-${ev}="$action:${fn.trim()}"` : `data-on-${ev}="${fn}"`);

  const stateDeclsCode = decls
    .map((d) => {
 // A component's state keys are namespaced by its file, so two
      // components that both declare `let open = $state(false)` no longer
      // share one signal (the signal map is global per document). The prefix
      // is identical on both sides of the wire - it is generated code.
      const key = isComponent ? `${scopeKey}:${d.name}` : d.name;
      if (d.kind === 'state') {
        return `const [${d.name}, ${setterNames.get(d.name)!}] = state(${JSON.stringify(key)}, ${d.expr});`;
      }
      // $data: fetch only when this key has no value yet (server: always after
      // clearRequestState; client: only on first visit or client-side nav)
      const isFn = d.expr.includes('=>') || d.expr.startsWith('function');
      const fn = isFn ? d.expr : `() => (${d.expr})`;
      return `const __had_${d.name} = hasState(${JSON.stringify(key)});
const [${d.name}, set${capitalize(d.name)}] = state(${JSON.stringify(key)}, null);
if (!__had_${d.name}) set${capitalize(d.name)}(await $data(${fn}));`;
    })
    .join('\n');

  const stateKeys = decls.map((d) => d.name);

 // The local name -> module map for the components this file imports,
  // handed to the template compiler so `<Card title={x}>` becomes a call to
  // the imported module's render() instead of literal HTML. The slot
  // declarations ride along: the parent must know which names the child
  // passes INTO a slot to resolve them in the slot content it writes.
  const comps = new Map(roseImports.map((r) => {
    const abs = path.resolve(path.dirname(filePath), r.specifier);
    const hit = registry.get(abs)!;
    return [r.name, { index: hit.index, slots: hit.slots }] as const;
  }));
  const compiledTemplate = compileTemplate(ssrTemplate, 'h', '__c', null, 0, true, comps);
  // head block: no markers (esc() inline) - the whole block re-renders per
  // call, so one reactive closure drives document title/meta on navigation.
  const compiledHead = headContent.trim() ? compileTemplate(headContent, '__hd', '__hc', null, 0, false) : '';
  // A named slot in the template needs the __slot() helper in the module.
  const hasNamedSlots = /<slot\s+[^>]*\bname\s*=/.test(template);

  // Actions ship in the SSR module only; the client bundle gets every other
  // export (params, sync helpers) but never an action body.
  const ssrExports = actions.length > 0 ? `${exportStmts}\n${actions.map((a) => a.stmt).join('\n')}` : exportStmts;
 // The guard is emitted at the SSR module's scope, beside the actions
  // it fronts - the server entry imports it as `beforeAction_<i>` and the
  // dispatch awaits it before the selected action. Never in the client
  // bundle: a permission check that ships to the browser is not one.
  const ssrGuard = guard ? `\n${guard}` : '';
  // pages/_middleware.rose is a hook module, not a route: no template, no
  // state, no head. Its script therefore belongs at MODULE scope, because
  // `handle` is hoisted there and the things a middleware actually needs -
  // a database connection, a cache, a client - are declared beside it.
  // Inside render() those declarations would be unreachable: the server
  // entry imports middlewareMod.handle and never calls render(). (This is
  // exactly how a first DB-backed page was written: the page's $data body
  // ships to the browser, so the query lives in the middleware, which the
  // compiler keeps server-side.)
  const isMiddleware = path.basename(filePath) === '_middleware.rose';
  const ssr = isMiddleware
    ? `${RUNTIME_IMPORTS}\n\n${importStmts}\n\n${ssrExports}\n${ssrGuard}\n\n${cleanScript}\n`
    : generateSSR(cleanScript, compiledTemplate, stateDeclsCode, ssrExports, compiledHead, props, hasNamedSlots, importStmts, isComponent, ssrGuard);
  const client = generateClient(cleanScript, compiledTemplate, stateDeclsCode, eventBindings, exportStmts, compiledHead, props, hasNamedSlots, importStmts, isComponent);

  // One rewrite for both bundles and every branch above: the `__rose_N__`
  // placeholder resolves to this bundle's own module path, and nothing else in
  // the generated source can contain that token.
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
    prefetch,
    bundle,
    needsClient,
    clientReasons,
    jsWarnings,
    headers,
    props,
    roseImports,
    isComponent,
  };
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
        // at-rule: keep the prelude, scope the inner rules (keyframes pass
        // through: their 0%/from/to "selectors" are not selectors)
        out += `${sel} { ${/^@(?:-[\w]+-)?keyframes/.test(sel) ? block : scopeCss(block, key)} }`;
      } else if (sel) {
        const scoped = sel.split(',').map((s) => `${attr} ${s.trim()}`).join(', ');
        out += `${scoped} { ${block} }`;
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
    // scan one tag, respecting quoted attribute values
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
    const tagText = template.slice(lt, j + 1); // includes < and >
    const closing = /^<\//.test(tagText);
    const nameMatch = tagText.match(/^<\/?([a-zA-Z][\w-]*)/);
    const selfClosing = /\/>$/.test(tagText) || (nameMatch && VOID_TAGS.has(nameMatch[1].toLowerCase()));
    if (nameMatch && !closing && depth === 0 && !selfClosing) {
      // inject before the closing > (or before a trailing />)
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

// Trade-off: tolerate leading indentation - .rose script blocks are indented
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

// Exported for `rosefn check`: it synthesizes a module declaration for every
// imported .rose component from the SAME prop parse the compiler uses, so the
// two can never disagree about what a component's props are.
export function extractExports(script: string): { clean: string; exports: string; actions: Array<{ name: string; stmt: string }>; props: Array<{ name: string; def: string | null }>; guard: string } {
  const stmts: string[] = [];
  const actions: Array<{ name: string; stmt: string }> = [];
 // `export let` is a PROP, not a module-scope value - it is read from
  // the caller's props object per invocation. `export const/var` keeps its
  // old meaning (a build-time consumer's value: params, headers, csr, ...).
  const props: Array<{ name: string; def: string | null }> = [];
 // `export async function beforeAction(name, form)` is the page's
  // action GUARD - it runs before every action and vetoes with an
  // ActionError. Server-only and never callable as an action itself, so it is
  // kept out of both lists and emitted at module scope of the SSR module only.
  const guards: string[] = [];
  let out = '';
  let pos = 0;
  let m: RegExpExecArray | null;
  EXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_RE.exec(script))) {
    const kind = m[1]; // const/let/var, or undefined for function
    const start = m.index + m[0].indexOf('export'); // skip leading indentation
    let i = start + m[0].length - m[0].indexOf('export');
    if (kind) {
      // balanced scan: object/array literals, calls, arrows end at their
      // matching close; primitive literals end at `;` or a plain newline.
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
      // function declaration: skip the parameter list, balance the body
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
      guards.push(stmt); // the guard: server-only, never an action target
    } else if (asyncFn) {
      actions.push({ name: asyncFn[1], stmt }); // server-only: kept out of the client bundle
    } else if (kind === 'let') {
 // A prop. The declaration never reaches module scope - the
      // generated render reads it from the props object (with this default),
      // so every invocation of the component gets its own value.
      const pm = stmt.match(/^export\s+let\s+(\w+)\s*(?:=\s*([\s\S]*?))?\s*;?$/);
      if (pm) props.push({ name: pm[1], def: pm[2]?.trim() ?? null });
      else stmts.push(stmt); // a destructuring pattern: not a prop, keep it shared
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
    // The regex matched up to `$state`/`$data`; what follows is an optional
    // type-argument list and then the call. Scan the list by hand: it can
    // nest (`Record<string, Post>`), and a function type inside it
    // (`<() => void>`) has a `>` that is not a closing bracket.
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
        } else if (ch === '=' && script[j + 1] === '>') j++; // `=>`: both chars are one token
        j++;
      }
      skipSpace();
    }
    if (script[j] !== '(') continue; // `$state` used as a value, not a call
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

function removeRanges(text: string, ranges: Array<[number, number]>): string {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [start, end] of sorted) {
    out += text.slice(pos, start);
    pos = end;
  }
  out += text.slice(pos);
  return out;
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
    const ifMatch = remaining.match(/\{#if\s+([^}]+)\}([\s\S]*?)\{\/if\}/) as RegExpExecArray | null;
    const eachMatch = remaining.match(/\{#each\s+([\w.]+(?:\(\))?)\s+as\s+(\w+)\}([\s\S]*?)\{\/each\}/) as RegExpExecArray | null;
    const boundaryMatch = remaining.match(/\{#boundary\}([\s\S]*?)\{\/boundary\}/) as RegExpExecArray | null;
    const exprMatch = remaining.match(/\{([^{}]+)\}/) as RegExpExecArray | null;
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
      // Inner markers live in the block's OWN closes array, so wiring an
      // adopted/cloned block never re-touches the parent's markers.
      const inner = compileTemplate(content.trim(), 'h', '__c', innerScope, depth + 1, markers, comps);
      result += `const __b${id} = (__s, __c) => { let h = ''; ${inner} return h; };\n`;
      if (markers) {
        // The content renders the FIRST time the block shows, never before -
        // see the runtime's ifMark for why the eager version crashed
        // `{#if user()}{user().name}{/if}`. The snapshot is memoized per
        // render (wire() clones it when the block re-appears), so a block
        // that never shows costs nothing and one that shows renders once.
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
      // Rename the item variable to the block's scope parameter - INSIDE
      // EXPRESSIONS ONLY. A plain text replace would also rewrite the word in
      // prose ("row {row.id}" -> "__s {row.id}"); the scanner below sees
      // {…}, {#if …} and {#each …} alike, so a condition or a nested loop that
      // reads the item still resolves.
      const itemRe = new RegExp(`\\b${item}\\b`, 'g');
      const scoped = content.trim().replace(/\{([^{}]*)\}/g, (whole, expr) =>
        `{${expr.replace(itemRe, '__s')}}`);
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
      // Error boundary: the content renders into its OWN string and is only
      // appended on success - a throw anywhere inside swaps in the fallback,
      // so one broken widget never blanks the page. The content is inline
      // (no marker, no condition), so its markers share the enclosing closes
      // array and wire exactly like unwrapped content. Sync by design: the
      // template phase is sync ($data awaits happen before it), and the same
      // code runs on server and client.
 // A boundary whose content drives a server action (an $action
      // binding or a POST form inside it) asks the runtime first whether the
      // action that produced THIS response failed, and contains it - the
      // section degrades to the error message instead of rendering a widget
      // built on work that never happened. Syntactic, like every other
      // compiler rule here: a nested component's action binding is not seen.
      // A boundary that drives no action keeps the plain string fallback and
      // ships no runtime for this at all.
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
 // <Card prop={x}>...</Card> -> Card(closes, children, props, slots).
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
        if (closeIdx < 0) throw new Error(`unclosed <${tag.name}> - every component tag needs its matching close tag`);
        childrenSrc = remaining.substring(tag.end, closeIdx);
        rest = remaining.substring(closeIdx + tag.name.length + 3);
      }
      const { def, named } = splitSlots(childrenSrc);
      // Default children render at CALL time with the enclosing scope (inside
      // an {#each} that scope is the item), exactly like a layout's children.
      result += `const __ch${id} = (__s, __c) => { let h = ''; ${compileTemplate(def, 'h', '__c', scope, depth + 1, markers, comps)} return h; };\n`;
      // Named slots are functions of the object the child passes in AND of a
      // marker array of their own: their content is a block scoped to that
      // object (see SLOT_HELPER), so its markers must not land in the
      // parent's array. The child's declared prop names resolve against the
      // object (__s), so the parent writes plain `{item.title}` and the child
      // owns the contract. Only inside {…} expressions: literal text must
      // never be rewritten.
      const slotFns = named.map(([nm, src]) => {
        const decl = entry.slots.find((s) => s.name === nm);
        let content = src;
        for (const p of decl?.props ?? []) {
          content = content.replace(/\{([^{}]*)\}/g, (whole, expr) =>
            `{${expr.replace(new RegExp(`\\b${p}\\b`, 'g'), `__s.${p}`)}}`);
        }
        return `${JSON.stringify(nm)}: (__s, __c) => { let h = ''; ${compileTemplate(content, 'h', '__c', '__s', depth + 1, markers, comps)} return h; }`;
      });
      const propsObj = parseCompAttrs(tag.attrs)
        .filter((a) => a.name !== 'slot')
        .map((a) => {
          // on:click={fn} is an event outward: the child receives it as the
          // `onClick` prop and calls it - no extra machinery, a prop is a
          // function like any other value.
          const key = a.name.startsWith('on:') ? `on${capitalize(a.name.slice(3))}` : a.name;
          const val = a.kind === 'expr' ? `(${a.value})` : a.kind === 'str' ? JSON.stringify(a.value) : 'true';
          return `${JSON.stringify(key)}: ${val}`;
        })
        .join(', ');
      // The imported binding IS the child's render function (a default
      // `import Card from '...rose'` compiles to `import { render as Card }`),
      // so the call is direct - not a property access on a namespace.
      result += `${acc} += ${tag.name}(${closes}, __ch${id}(${scope ?? 'undefined'}, ${closes}), { ${propsObj} }, { ${slotFns.join(', ')} });\n`;
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
      // <slot name="x" item={post}> -> the child's named slot, rendered from
      // the parent's content with the object the child passes in. The name is
      // quoted either way: the template encoder uses JSON.stringify, a
      // hand-written call in a page may use single quotes.
      const slotCall = /^__slot\((['"])(\w+)\1, \[([\s\S]*)\]\)$/.exec(trimmed);
      if (slotCall) {
        if (before) result += emitChunk(before, acc, closes, scope);
        // The slot renders markup, so it is concatenated raw - esc() would
        // turn the parent's own elements into text. It rides in a block so
        // its markers are scoped to the slot object (see SLOT_HELPER).
        result += `${acc} += __slotBlock(${closes}, __sl, ${JSON.stringify(slotCall[2])}, [${slotCall[3]}]);\n`;
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      // attr={expr} -> reactive attribute; otherwise a text marker
      const attrMatch = before.match(/([\w-]+)=\s*$/);
      if (attrMatch) {
        const lit = before.slice(0, before.length - attrMatch[0].length);
        if (lit) result += emitChunk(lit, acc, closes, scope);
        result += emitAttr(attrMatch[1], trimmed, acc, closes, scope, markers);
      } else {
        if (before) result += emitChunk(before, acc, closes, scope);
        // A marker whose value is followed by LITERAL TEXT needs an end
        // marker: the wire patches the text node after the start marker, so
        // without the pair it would overwrite the prose that follows the
        // value ("likes {n} left" -> "likes 1ft"). Before a tag or another
        // expression the value owns its text node already - no pair, no
        // bytes (the common case stays exactly as small as it was).
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
      throw new Error(`slot="${hit[1]}" on <${nm[2]}> is nested inside slot="${outer}" - a slot must be a direct child of the component`);
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
      throw new Error(`slot="${slotName}" on <${nm[2]}> must be a direct child of the component - it is nested inside another element or an {#if}/{#each} block`);
    }
    if (slotName) {
      const stripped = tagText.replace(/\s*slot\s*=\s*["']\w+["']/, '');
      if (selfClosing || isVoid) {
        named.set(slotName, (named.get(slotName) ?? '') + stripped);
      } else {
        const closeIdx = findClose(src, end, nm[2]);
        if (closeIdx < 0) throw new Error(`unclosed <${nm[2]}> inside slot="${slotName}"`);
        const tail = `</${nm[2]}>`;
        const inner = src.slice(end, closeIdx);
        // The same rule one level down: a slot= INSIDE a named slot's
        // content is nested too, and the child would silently never call it.
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

// --- Build-time image inlining -------------------------------------------
// One fewer request per small local image: <img src="/logo.svg"> ships as a
// data URI inside the (already single-request) document. Bigger files stay
// real requests - base64 would inflate them 33% for no round-trip saved.

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
// Trade-off: fixed 4 KB cap; make it configurable when a real app cares
const INLINE_IMG_MAX = 4096;

function inlineImages(template: string, publicDir: string): string {
  return template.replace(IMG_RE, (tag) => {
    const src = tag.match(/\bsrc="(\/[^"{}]+)"/); // static, site-root-relative only
    if (!src) return tag; // reactive/remote/missing src: leave it alone
    const ext = path.extname(src[1]).toLowerCase();
    const mime = IMG_MIME[ext];
    if (!mime) return tag;
    let file: Buffer;
    try {
      file = fs.readFileSync(path.join(publicDir, src[1]));
    } catch {
      return tag; // not in public/ at build time: keep the URL, server 404s honestly
    }
    if (file.length > INLINE_IMG_MAX) return tag;
    // SVG inlines as text (percent-encoded for #, ", %); binaries as base64
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
    // head block: inline escaped value, no marker comment (clean SSR html)
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

// The runtime's public surface, as one import line. Three generators emit it
// (page SSR, page client, the middleware module) - one constant so the list
// can never drift between them. esbuild tree-shakes what a module never
// references, so a page that uses none of the action helpers ships none
// of them.
const RUNTIME_IMPORTS = `import { state, $data, hasState, esc, refresh, onMount, onCleanup, getContext, $t, bestLocale, $cookies, $sessionCookie, $store, ActionError, $actionError, $actionErrorOrThrow, $boundaryFallback, $append, $prepend, $merge, applyStateDeltas, textMark, attrMark, ifMark, eachMark, headMark } from './runtime.js';`;

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

// The named-slot helpers, identical in both bundles . __slot resolves
// the parent's slot function and builds the object its <slot name item={...}>
// declared; __slotBlock wraps the rendered content in block markers and
// registers a closure that re-renders it with a FRESH marker array scoped to
// that object. The wire adopts the server-rendered nodes in place (identity
// preserved) and re-renders from the closure afterwards - the same path an
// {#if} block takes, with the slot object as the scope. Without the block,
// the slot's markers would be invoked with the ENCLOSING scope and read the
// wrong variables.
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

function generateSSR(script: string, templateFn: string, stateDeclsCode: string, exports = '', headFn = '', props: Array<{ name: string; def: string | null }> = [], namedSlots = false, imports = '', isComponent = false, guard = ''): string {
  // The head block renders to a clean html string (no markers) and is wrapped
  // in an h marker pair: renderPage extracts it for <head> injection, the
  // client's wire() applies it to the document on navigation.
  const headCode = headFn
    ? `
const __head = () => { let __hd = ''; ${headFn} return __hd; };
__html += headMark(closes, __head);`
    : '';
  // A page's render is async ($data awaits); a component's is not - its
  // parent calls it inside a string concatenation (`h += Card(...)`), and a
  // Promise there would stringify to "[object Promise]". $data() is banned
  // in components (build error in compileComponent), so there is nothing to
  // await.
  return `
${RUNTIME_IMPORTS}

${imports}

${exports}
${guard}

${namedSlots ? SLOT_HELPER : ''}

export ${isComponent ? 'function' : 'async function'} render(closes, children, __props, __slots) {
  ${props.length > 0 ? 'const __p = __props || {};' : ''}
  ${namedSlots ? 'const __sl = __slots || {};' : ''}
  ${propsCode(props)}
  ${stateDeclsCode}
 // The incremental patches of the action that produced THIS response,
  // applied to the state the declarations above just established (a no-op on
  // every path that is not a server action's re-render - see the runtime).
  ${isComponent ? '' : 'applyStateDeltas();'}
  ${script}
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
  isComponent = false
): string {
  // Handlers live on a shared global so one delegated listener per event
  // type can dispatch for any component, including freshly cloned nodes.
  const handlerRegistry = eventBindings.length > 0
    ? `Object.assign(__handlers, { ${eventBindings.map((b) => b.fn).join(', ')} });`
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

const __handlers = globalThis.__rosefn_handlers ?? (globalThis.__rosefn_handlers = {});

${namedSlots ? SLOT_HELPER : ''}

export ${isComponent ? 'function' : 'async function'} render(closes, children, __props, __slots) {
  ${props.length > 0 ? 'const __p = __props || {};' : ''}
  ${namedSlots ? 'const __sl = __slots || {};' : ''}
  ${propsCode(props)}
  ${stateDeclsCode}
  ${script}
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
    .sort((a, b) => b.li.filePath.length - a.li.filePath.length) // deepest first
    .map(({ i }) => i);

/**
 * 's decision as a pure function: does this route's document
 * ship without the client bundle? Shared by the route table (csr: false) and
 * the build report (#31), so the report can never disagree with the build.
 */
const routeShipsNoJs = (infos: RouteInfo[], compiled: CompileResult[], i: number): boolean => {
  if (compiled[i].csr === true) return false;
  if (compiled[i].needsClient) return false;
  // a layout needing the client bundles every document under it: its
  // handlers would be dead code in a runtime-less document
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

export async function buildProject(root: string, outDir: string): Promise<{ routes: RouteInfo[]; bundle: string }> {
  await fs.promises.mkdir(outDir, { recursive: true });

  // stale intermediates from an older build layout must not survive into the
  // deploy dir (they used to live directly in outDir)
  const stale = (await fs.promises.readdir(outDir)).filter((f) =>
    /^(?:comp-\d+\.(?:ssr|client)|runtime|(?:server|client)-entry)\.js$/.test(f));
  await Promise.all(stale.map((f) => fs.promises.rm(path.join(outDir, f), { force: true })));

  const pageFiles = await scanRoseFiles(root);
  const compFiles = await scanComponentFiles(root);
  const files = [...pageFiles, ...compFiles];
 // A build that silently produces nothing is the worst possible
  // failure mode (an empty dist/ deploys as a blank site). Say it plainly:
  // this is not a project root, or the pages live somewhere else.
  if (pageFiles.length === 0) {
    throw new Error(`no .rose pages found under ${path.join(root, 'src', 'pages')} - run rosefn from a project root, or pass one: rosefn build <dir>`);
  }
  const infos = files.map((f) => ({ ...getRouteInfo(f, root) }));
 // Plugins: rosefn.config.js at the project root, loaded
  // fresh per build so the dev server's hot rebuild picks up config edits.
  const plugins = await loadPlugins(root);
  // scope key: the component's path under pages/ (index, _layout, blog/[id])
  // - stable across builds, unique per file, independent of scan order.
  // A component (src/components/**) is keyed under src/ instead, so its
  // scope key can never collide with a page's.
  const scopeKeys = files.map((f, i) => {
    const base = infos[i].isComponent ? path.join(root, 'src') : path.join(root, 'src', 'pages');
    return path.relative(base, f).replace(/\\/g, '/').replace(/\.rose$/, '');
  });
 // The build-wide import registry: absolute path -> module index,
  // scope key, and the named slots the component declares. It exists before
  // any compilation because every importer needs it, and the indices are the
  // same for pages and components - one module index space.
  const registry: RoseRegistry = new Map(
    files.map((f, i) => [f, { index: i, scopeKey: scopeKeys[i], slots: scanSlotDecls(f) }])
  );
  const compiled = await Promise.all(
    files.map((f, i) => compileComponent(f, path.join(root, 'public'), scopeKeys[i], infos[i].isApi, plugins, registry))
  );

  // A component that needs the client drags every page that imports it into
  // the client bundle - the page renders it, so it must be able to resume
  // it. Walk each module's IMPORT closure (what it imports, transitively),
  // memoized and cycle-safe.
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
  // The walk reports WHICH dependency needs the client, so the build's lint
  // line names the component instead of the page.
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

  // Reachability: a component no page (transitively) imports ships in neither
  // bundle - not the server's, not the client's.
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

  // Every component's scoped CSS in one stylesheet, inlined into the shell:
  // styles ship inside the document like the JS bundle - zero requests.
  const styles = compiled
    .map((c, i) => (reachable.has(i) ? c.style : ''))
    .filter(Boolean).join('\n');
  if (styles) await fs.promises.writeFile(path.join(outDir, 'styles.css'), styles);
  else await fs.promises.rm(path.join(outDir, 'styles.css'), { force: true });

 // i18n: every JSON file in src/locales/ is a language.
  // The dictionaries are baked into BOTH bundles at build time - the client
  // must be able to render any locale without a request (the same one-request
  // bet as the route table). No locales dir -> i18n is simply off. < is
  // escaped so a dictionary value can never close the client bundle's
  // inline <script> tag.
  let locales: Record<string, Record<string, string>> = {};
  try {
    for (const f of await fs.promises.readdir(path.join(root, 'src', 'locales'))) {
      if (!f.endsWith('.json')) continue;
      locales[f.slice(0, -5)] = JSON.parse(await fs.promises.readFile(path.join(root, 'src', 'locales', f), 'utf-8'));
    }
  } catch {
    locales = {}; // no src/locales/: the app ships no translations
  }
  const defaultLocale = locales.en ? 'en' : Object.keys(locales).sort()[0] ?? 'en';
  const localesJson = JSON.stringify(locales).replace(/</g, '\\u003c');

  // Intermediates (component modules, shared runtime, bundle entries) live in
  // a build dir that is removed before returning: both bundles are fully
  // self-contained, and the deploy dir's static server would otherwise serve
  // the unminified component sources to anyone who asks for them.
  const buildDir = path.join(outDir, '.build');
  await fs.promises.rm(buildDir, { recursive: true, force: true });
  await fs.promises.mkdir(buildDir, { recursive: true });

 // The runtime half of the plugins. A transform already ran at
  // build time (in compileComponent); onRequest/onResponse must run per
  // request INSIDE the server bundle, so the config's runtime hooks are
  // bundled into dist/server.js - the config itself is not deployed, and
  // dist/ stays self-contained (the same rule that keeps the component
  // modules out of the deploy dir). The module is written only when a plugin
  // actually declares a runtime hook: no hook, no module, no import - and a
  // transform-only config keeps its (possibly node-only) imports out of the
  // server bundle entirely.
  const runtimePlugins = plugins.filter((p) => p && (p.onRequest || p.onResponse));
  if (runtimePlugins.length > 0) {
    // Relative from .build/, so the build works from any cwd (`rosefn build
    // <dir>` from elsewhere). The whole config module is bundled, not just
    // the hooks - a named re-export still evaluates the module - hence the
    // "no node-only imports in the config" rule on the Plugin type.
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

  // Shared runtime module, bundled once into client and server output.
  // The runtime ships WITH THE COMPILER, not with the app: resolve it from
  // this file's own location so any project root builds (the in-repo
  // example used to be the only layout that worked). Two layouts answer: in
  // the repo this module sits at src/compiler/, in the published package the
  // compiler is bundled to dist-cli/compiler/index.mjs with the sources
  // beside it - so the source is either a sibling or two levels down.
  const runtimeEntry = ['../runtime/index.ts', '../src/runtime/index.ts']
    .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
    .find((p) => fs.existsSync(p));
  if (!runtimeEntry) throw new Error('Rosefn: the runtime source (src/runtime/index.ts) was not found next to the compiler');
  await esbuild.build({
    entryPoints: [runtimeEntry],
    bundle: true,
    outfile: path.join(buildDir, 'runtime.js'),
    format: 'esm',
    platform: 'browser',
    write: true,
  });

  for (let i = 0; i < compiled.length; i++) {
    // api routes compile to a handler module (no render): still an
    // intermediate, still removed with the rest of the build dir
    const src = compiled[i].api ?? compiled[i].ssr;
    await fs.promises.writeFile(path.join(buildDir, `comp-${i}.ssr.js`), src);
    if (!infos[i].isApi) {
      await fs.promises.writeFile(path.join(buildDir, `comp-${i}.client.js`), compiled[i].client);
    }
  }

  const pages = infos
    .map((info, i) => ({ info, i }))
    .filter(({ info }) => !info.isLayout && !info.isNotFound && !info.isError && !info.isApi && !info.isMiddleware && !info.isComponent);

  // API routes (pages/api/*.rose) dispatch handlers, never render HTML: they
  // live in the server bundle only and are excluded from the client route
  // table entirely.
  const apiRoutes = infos
    .map((info, i) => ({ info, i }))
    .filter(({ info }) => info.isApi);

  // Compose render chains: page wrapped by its layouts (deepest first)
  const compose = (idx: number): string => {
    let expr = `render_${idx}`;
    for (const i of layoutsOf(infos, idx)) {
      expr = `(async (closes, children) => await render_${i}(closes, await (${expr})(closes, children)))`;
    }
    return expr;
  };

 // Mode B. `export const bundle = 'split'`
  // (declared once, the root layout) turns every route's client module into
  // its own chunk: the document references /client.js externally instead of
  // inlining the whole app, so it stops growing with the route count.
  // 'inline' (the default) is the untouched single-document mode. First
  // declaration wins, like the prefetch strategy.
  const bundleMode = compiled.find((c) => c.bundle)?.bundle ?? 'inline';
  const split = bundleMode === 'split';
  // The chain a route's chunk graph must load: the page first, then its
  // layouts deepest-first - exactly compose()'s nesting order, so the
  // runtime composition is semantically identical to mode A's.
  const chainOf = (idx: number): number[] => [idx, ...layoutsOf(infos, idx)];
  // Mode B's loader expression: literal dynamic imports (esbuild needs the
  // paths statically analyzable to emit one chunk per module), composed at
  // runtime by loadChain() in the client entry.
  const loaderInner = (idx: number): string =>
    `load: () => loadChain([${chainOf(idx).map((i) => `() => import('./comp-${i}.client.js')`).join(', ')}])`;
  const loaderOf = (idx: number): string => `{ ${loaderInner(idx)} }`;

 // The compiler decides zero-JS, not the developer. A route
  // ships no client bundle - no runtime, no state script, zero JavaScript -
  // when NOTHING in its chain needs one: no event wiring, no lifecycle or
  // client-only APIs, no server action, no form, in the page OR any of its
  // layouts. An exported `csr = true` forces the bundle back in (a content
  // page that still wants client-side navigation FROM itself); an exported
  // `csr = false` is the old assertion - content-only, or the build fails.
  // The route's render function still rides in the client bundle either
  // way, so client-side navigation and a static deploy's SPA fallback paint
  // it normally; only the document is JS-free.
  const routeNoJs = (i: number): boolean => routeShipsNoJs(infos, compiled, i);

  const serverImports = compiled
    .map((_, i) => {
      if (!reachable.has(i)) return ''; // an unimported component ships nowhere
      if (infos[i].isMiddleware) {
        // pages/_middleware.rose: server-only, imported as a namespace so a
        // missing `handle` export is simply "no middleware" (null), never a
        // build error
        return `import * as middlewareMod from './comp-${i}.ssr.js';`;
      }
      if (infos[i].isApi) {
        // api route: import its HTTP-method handlers (aliased per component)
        const names = compiled[i].apiMethods ?? [];
        const handlerImports = names.map((n) => `${n} as ${n}_${i}`).join(', ');
        return handlerImports
          ? `import { ${handlerImports} } from './comp-${i}.ssr.js';`
          : `import './comp-${i}.ssr.js';`;
      }
      // a page's server actions are imported alongside its render; layouts
      // and the 404 page never receive POSTs, so they never need one
      const isPage = !infos[i].isLayout && !infos[i].isNotFound;
      const names = isPage ? compiled[i].actionNames : [];
      const actionImports = names.map((n) => `${n} as ${n}_${i}`).join(', ');
 // The action guard rides the same import, server-only like the
      // actions it fronts
      const guardImport = isPage && compiled[i].guardName ? `beforeAction as beforeAction_${i}` : '';
      const named = [actionImports, guardImport].filter(Boolean).join(', ');
      return named
        ? `import { render as render_${i}, ${named} } from './comp-${i}.ssr.js';`
        : `import { render as render_${i} } from './comp-${i}.ssr.js';`;
    })
    .join('\n');

  // pages/404.rose renders for unmatched routes (SSR + client), wrapped in
  // its layouts like any other page; absent -> the built-in plain 404.
  const nfIdx = infos.findIndex((info) => info.isNotFound);
  const notFoundRender = nfIdx >= 0 ? (split ? loaderOf(nfIdx) : compose(nfIdx)) : 'null';

  // pages/500.rose renders for routes whose render throws (a dead $data
  // source, a bad expression): the page degrades instead of crashing the
  // response; absent -> the built-in plain 500.
  const errIdx = infos.findIndex((info) => info.isError);
  const errorRender = errIdx >= 0 ? (split ? loaderOf(errIdx) : compose(errIdx)) : 'null';

  // pages/_middleware.rose: the request interceptor (absent -> null).
  const middlewareIdx = infos.findIndex((info) => info.isMiddleware);

  const serverRoutes = pages
    .map(({ info, i }) => {
      // actions: name -> imported fn, so a POST's __action field (default
      // 'action', the progressive-enhancement form's conventional target)
      // selects which one runs before the render
      const actionMap = compiled[i].actionNames.map((n) => `${n}: ${n}_${i}`).join(', ');
      // csr: false rides on the route so renderPage/renderPageStream can drop
 // the state script + bundle from the document (; the
      // decision is the compiler's since #29). An explicit opt-out is also
      // checked against the chain: a layout needing the bundle under a
      // csr = false page would ship dead handlers, so the build fails.
      if (compiled[i].csr === false && compiled[i].needsClient) {
        throw new Error(
          `${info.filePath}: csr = false but this route needs the client bundle ` +
          `(${(compiled[i].clientReasons ?? ['needs the client']).join(' + ')}).`
        );
      }
      if (compiled[i].csr === false) {
        const needy = layoutsOf(infos, i).find((li) => compiled[li].needsClient);
        if (needy !== undefined) {
          throw new Error(
            `${info.filePath}: csr = false cannot ship under ${infos[needy].filePath} - the layout needs the client bundle ` +
            `(event wiring, onMount/onCleanup, refresh() or a server action).`
          );
        }
      }
      const csrFlag = routeNoJs(i) ? ', csr: false' : '';
 // Guard - runs before every action of this route (null when the
      // page exports no beforeAction)
      const guardFlag = compiled[i].guardName ? `, guard: beforeAction_${i}` : '';
      return `{ pattern: '${info.pattern}', path: '${info.routePath}', render: ${compose(i)}, actions: ${actionMap ? `{ ${actionMap} }` : 'null'}${guardFlag}${csrFlag} }`;
    })
    .join(',\n  ');

  const serverEntry = `
${serverImports}
import { setState, clearRequestState, serializeState, resetRequestContext, isLocale, setLocales, localeList, setStoreTransport, applyStorePatch, ActionError, StateDelta, setStateDelta } from './runtime.js';
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

// Routes whose component reads the request context (getContext()): the bag
// is per-request, so these are dynamic - the build never bakes them and the
// servers never answer them from a prerendered file. Public routes keep the
// static fast path (file cache, ETag/304, streaming) untouched.
export const dynamicRoutes = [
  ${pages.filter(({ i }) => compiled[i].usesContext).map(({ info }) => `'${info.routePath}'`).join(',\n  ')}
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

// Paint a fallback page (404/500) and serialize its state.
async function renderFallback(pathname, render) {
  const { html, head } = extractHead(await render([], ''));
  const state = JSON.stringify({ __route: pathname, ...JSON.parse(serializeState()) });
  return { html, state, head };
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
        return { html: '<h1>404</h1><p>Page not found</p>', state: '{}', head: [], status: 404 };
      }
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
        return { html: '<h1>500</h1><p>Something went wrong rendering this page.</p>', state: '{}', head: [], status: 500 };
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
      return { html: rendered.html, state, head: rendered.head, status: actionStatus || 200, csr: route.csr !== false };
    }
  }
  if (notFound) {
    return { ...(await renderFallback(pathname, notFound)), status: 404 };
  }
  return { html: '<h1>404</h1><p>Page not found</p>', state: '{}', head: [], status: 404 };
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

  // api routes and the middleware have no client module: they are
  // server-only handlers / interceptors. Mode B has no static client
  // imports at all - every route module arrives in its own chunk.
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

  // P1: the app-global prefetch strategy, declared once
  // (the root layout) as `export const prefetch = 'off' | 'hover' | 'viewport'
  // | 'all'`. First declaration wins; absent -> 'all' = the original behavior
  // (hover/focus/touch + viewport/idle). trade-off: app-global, not per-route.
  const prefetchMode = compiled.find((c) => c.prefetch)?.prefetch ?? 'all';

  const clientEntry = `
${clientImports}
import { setState, resumeState, clearRequestState, resetEffects, wire, isolateStateAsync, restoreState, setRefreshHook, clearMounts, flushMounts, adoptCleanups, setLocales, isLocale } from './runtime.js';

// i18n: the dictionaries baked at build time - the client
// renders any locale from the bundle, so switching language costs zero
// requests (the same bet as the inlined route table).
setLocales(${localesJson}, '${defaultLocale}');

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
  resetEffects();
  clearRequestState();
  clearMounts(); // a failed render leaves stale mounts behind
  // inline mode passes the render itself; split mode passes a loader
  const render = page ? await getRender(page) : null;
  if (render) {
    const closes = [];
    const html = await render(closes, '');
    container.innerHTML = html;
    wire(container, closes);
    bindEvents(container);
    flushMounts();
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

function applyParams(route, pathname) {
  const patternParts = route.pattern.split('/');
  const pathParts = pathname.split('/');
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) setState(patternParts[i].slice(1), pathParts[i]);
  }
}

export function prefetch(pathname, source = 'hover') {
  if (prefetchMode === 'off') return;
  if (prefetchMode === 'hover' && source !== 'hover') return;
  if (prefetchMode === 'viewport' && source !== 'viewport') return;
  if (prefetchCache.has(pathname)) return;
  if (pathname === location.pathname) return; // already here: nothing to prefetch
  const route = routes.find((r) => matchRoute(r.pattern, pathname));
  if (!route) return;
  if (prefetchPending >= PREFETCH_BUDGET) return; // budget spent: drop it, a later hover retries
  const p = prefetchQueue.then(async () => {
    try {
      // the isolated render also captures the onMount callbacks the route
      // queued and the onCleanup disposers it registered: the paint that
      // consumes this entry replays the mounts after wiring and adopts the
      // cleanups, so the prefetched route's timers are disposed on the next
      // navigation like any live route's
      const { result, state, mounts, cleanups } = await isolateStateAsync(async () => {
        applyParams(route, pathname);
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
      prefetchPending--;
    }
  });
  prefetchPending++;
  prefetchCache.set(pathname, p);
  prefetchQueue = p;
}

export function prefetchStats() {
  return { cached: prefetchCache.size, pending: prefetchPending, mode: prefetchMode };
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
      const h = globalThis.__rosefn_handlers[fn];
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
async function postForm(body) {
  const res = await fetch(location.pathname, { method: 'POST', body });
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const next = doc.getElementById('app');
  const st = doc.getElementById('__rosefn_state');
  const paint = () => {
    const container = document.getElementById('app');
    adopt(container, next ? next.innerHTML : '', st ? st.textContent : '{}');
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
  return postForm(body);
}

export { postForm };

// initial=true: adopt the SSR DOM (zero hydration) - wire reactive markers to
// the existing nodes and bind events. initial=false: client-side navigation -
// re-render the route chain from scratch and wire the fresh DOM.
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
      if (langIdx >= 0 && !isLocale(pathname.split('/')[langIdx])) {
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
        resetEffects();
        restoreState(hit.state);
        container.innerHTML = hit.html;
        wire(container, hit.closes);
        bindEvents(container);
        hit.mounts.forEach((fn) => fn()); // the prefetched route's mounts
        adoptCleanups(hit.cleanups); // and its cleanups, for the next resetEffects
        return;
      }
      if (!initial) {
        resetEffects();
        clearRequestState();
      }
      applyParams(route, pathname);
      const closes = [];
      let html;
      try {
        const render = await getRender(route); // split mode: loads the route's chunk here
        html = await render(closes, '');
      } catch {
        // the route itself is broken: degrade to pages/500.rose (or the
        // built-in plain 500) instead of leaving the container empty
        await paintFallback(container, errorPage, '<h1>500</h1><p>Something went wrong rendering this page.</p>');
        return;
      }
      if (!initial) container.innerHTML = html;
      wire(container, closes);
      bindEvents(container);
      flushMounts();
      return;
    }
  }
  // unmatched route: pages/404.rose renders (with its head + interactivity),
  // else the built-in plain 404
  await paintFallback(container, notFound, '<h1>404</h1><p>Page not found</p>');
}

// Adopt a server-rendered response in place - the JS-enabled half of
// progressive-enhancement forms: the bootstrap POSTs a <form method="POST">
// via fetch and hands the response here. The DOM is swapped and wired with
// the same zero-render trick as boot: re-run the route's render to rebuild
// the marker closures, wire them against the adopted nodes. The page never
// re-renders visibly, no hydration payload, no second request beyond the POST.
export async function adopt(container, html, stateJson) {
  resetEffects();
  clearRequestState();
  clearMounts(); // stale mounts from a failed render never fire
  resumeState(stateJson);
  container.innerHTML = html;
  // keep the embedded state in sync so a later SPA-fallback check agrees
  const st = document.getElementById('__rosefn_state');
  if (st) st.textContent = stateJson;
  for (const route of routes) {
    if (matchRoute(route.pattern, location.pathname)) {
      applyParams(route, location.pathname);
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
 // Mode B: esbuild code splitting. One chunk per route module,
    // the shared runtime in its own vendor chunk (both content-hashed, so a
    // deploy that does not touch a route leaves its chunk byte-identical and
    // the browser's cached copy stays valid), and the entry at a STABLE
    // /client.js - the document's only script reference, revalidated with a
    // weak ETag instead of being inlined. Stale chunks from an older build
    // are removed first: a dead hash is dead weight in dist and in the Go
    // binary's embed.
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

  // the deploy dir now holds only real artifacts
  await fs.promises.rm(buildDir, { recursive: true, force: true });

  const publicDir = path.join(root, 'public');
  if (fs.existsSync(publicDir)) {
    const outPublic = path.join(outDir, 'public');
    await fs.promises.mkdir(outPublic, { recursive: true });
    const assets = await fs.promises.readdir(publicDir);
    await Promise.all(
      assets.map((a) => fs.promises.copyFile(path.join(publicDir, a), path.join(outPublic, a)))
    );
  }

 // The build's zero-JS lint report - every route, its
  // verdict, and the reason. Printed on every build (dev rebuilds included)
  // so the decision is auditable instead of silent. The warnings are
  // route-level on purpose: a danger pattern only matters when the document
  // actually ships JS-free (under an interactive route the bundle is there
  // and the handler works).
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
 // A component (src/components/**) is not a route at all - it is
  // imported by one. Everything below still runs so a broken file reports a
  // sane routePath in build errors, but the flags that would put it in the
  // route table (api/middleware/layout/404/500) are all off.
  const isComponent = filePath.replace(/\\/g, '/').includes('/src/components/');
  const isLayout = !isComponent && base === '_layout';
  const isNotFound = !isComponent && base === '404';
  const isError = !isComponent && base === '500';
  // pages/api/*.rose: Web-standard handler routes (JSON in, JSON out), never
  // HTML pages - they dispatch by method and never reach the client bundle.
  const isApi = !isComponent && (withoutExt === 'api' || withoutExt.startsWith('api/'));
  // pages/_middleware.rose: the request interceptor. It runs before every
  // render and is not a route: it matches nothing and never reaches the
  // client bundle. trade-off: root only - one chain, no matcher config.
  const isMiddleware = !isComponent && withoutExt === '_middleware';

  let parts = withoutExt.split('/').filter((p) => p !== '_layout');
  // a trailing `index` segment names its directory (blog/index -> /blog,
  // api/index -> /api); only the root index collapses to '/'
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
