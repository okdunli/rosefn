/**
 * rosefn Compiler - Compile .rose components to SSR + client-resume JS
 *
 * Features: compile-time reactivity, zero-hydration resume, file-system
 * routing, nested layouts, server data fetching ($data) with request cache.
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
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
const DECL_RE = /(?:let|const|var)\s+(\w+)[^=]*=\s*\$(state|data)\s*\(/g;
const SETSTATE_RE = /\$setState\(([^,]+),\s*([^)]+)\)/g;
const EVENT_RE = /on:(\w+)=\{([^}]+)\}/g;
const SLOT_RE = /<slot\s*\/?>/g;
// {#boundary}...{/boundary}: an error boundary - its content renders into
// its own string; a throw anywhere inside swaps in this fallback instead of
// failing the whole page. ponytail: one generic message, no per-boundary
// custom fallback yet - add {:fallback}...{/fallback} when an app needs it.
const BOUNDARY_FALLBACK = '<p>This section failed to render.</p>';
// API route handlers are exported functions named by HTTP method
// (pages/api/*.rose). ponytail: function declarations only - an arrow-exported
// handler is a syntax error at import time, which is loud enough.
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export interface CompileResult {
  ssr: string;
  client: string;
  stateKeys: string[];
  actionNames: string[];
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
  /** innovation #29: the static analysis says this component needs the client bundle */
  needsClient?: boolean;
  /** innovation #31: WHY it needs the client - the rules that fired, for the build report */
  clientReasons?: string[];
  /**
   * innovation #31: shapes that MIGHT need JavaScript but the syntactic
   * predicate cannot prove, on a component that otherwise ships none (an
   * inline on* attribute, a javascript: URL, eval/new Function). Warnings,
   * never errors: the document still ships, but the build says it out loud.
   */
  jsWarnings?: string[];
  /** the component exports `headers = { ... }` (per-route response headers) */
  headers?: Record<string, string>;
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

/** A plugin transforms a component's raw source before compilation sees it. */
export interface Plugin {
  name: string;
  transform(code: string, filePath: string): string | Promise<string>;
}

/**
 * Plugins live in `<root>/rosefn.config.js` as the default export: an array
 * of `{ name, transform }`, run over each component's raw source (template +
 * script + style, before any parsing). ponytail: ONE hook - it covers macros,
 * custom syntax, includes and auto-imports; add bundler/build hooks when a
 * real plugin needs one. The import is cache-busted per build so a config
 * edit takes effect on the dev server's next rebuild, and a missing file is
 * simply "no plugins" (existence is checked first, so a config with a syntax
 * error still fails loudly).
 */
export async function loadPlugins(root: string): Promise<Plugin[]> {
  const file = path.join(root, 'rosefn.config.js');
  if (!fs.existsSync(file)) return [];
  const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  return (mod.default as Plugin[] | undefined) ?? [];
}

export async function compileComponent(filePath: string, publicDir: string, scopeKey: string, isApi = false, plugins: Plugin[] = []): Promise<CompileResult> {
  let source = await fs.promises.readFile(filePath, 'utf-8');
  // Plugins (innovation #30) see the raw source first: whatever they return
  // is what the compiler parses. A throwing plugin fails the build naming
  // itself and the file - a broken transform must never pass silently.
  for (const p of plugins) {
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
    return {
      ssr: '',
      client: '',
      stateKeys: [],
      actionNames: [],
      style: '',
      hasParams: false,
      api: `import { getContext } from './runtime.js';\n${rawScript.trim()}`,
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
  const rawScript = scriptMatch?.[1] ?? '';
  // getContext() in the script makes the route dynamic: the request bag is
  // per-request, so the build must not bake it and the servers must not
  // answer it from a prerendered file
  const usesContext = /getContext\s*\(/.test(rawScript);
  // an exported `params` marks a dynamic route for prerender enumeration
  const hasParams = /(?:^|\n)\s*export\s+(?:(?:const|let|var)\s+|(?:async\s+)?function\s+)params\b/.test(rawScript);
  // an exported `revalidate = N` opts the route into stale-while-revalidate:
  // the baked file is served for up to N seconds, then the preview server
  // answers stale and rebuilds in the background (ISR, innovation #24)
  const revalidateMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+revalidate\s*=\s*(\d+)\s*;?/);
  const revalidate = revalidateMatch ? Number(revalidateMatch[1]) : undefined;
  // Innovation #29: the compiler decides zero-JS, not the developer. This is
  // the same "does anything here need the client bundle" predicate that
  // innovation #25 used to REFUSE `csr = false`: event wiring in the
  // template, lifecycle/client APIs in the script, a server action (a form
  // target or $action), or a POST form (its in-place adopt is the
  // enhancement the bundle exists for). A route whose whole chain - the page
  // plus every layout - needs none of that ships a document with no runtime,
  // no state script and zero JavaScript, automatically: a blog post, an ISR
  // page, a localized page. `csr = true` forces the bundle back in (a
  // content page that still wants client-side navigation FROM itself);
  // `csr = false` asserts the route stays content-only and fails the build
  // the day it isn't. ponytail: syntactic, like every other check here - a
  // script that touches the DOM or mutates state outside an event handler is
  // the developer's promise (the same ceiling csr = false always had).
  // (Computed below, after actionNames: the predicate includes server
  // actions, which are only known once the exports are extracted.)
  // csr: explicit true = force the bundle in; explicit false = assert
  // content-only (build fails if it isn't); absent = the compiler decides
  // from needsClient (innovation #29).
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
  // (innovation #26) - the servers merge them OVER the framework defaults
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
  const { clean: scriptNoExports, exports: exportStmts, actions } = extractExports(rawScript);
  const script = scriptNoExports;
  const actionNames = new Set(actions.map((a) => a.name));

  // Innovation #29: does anything in this component need the client bundle?
  // (The predicate documented at the csr flag above - it lives here because
  // it includes server actions, known only after the exports are extracted.)
  // Innovation #31: every rule that fires records its reason, so the build's
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

  // Innovation #31: the predicate is SYNTACTIC, so a component that ships no
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

  // on:event={fn} -> data-on-event="fn"; a handler that names a server
  // action becomes data-on-event="$action:fn" (dispatched by $action);
  // <slot /> -> block marker
  const ssrTemplate = template
    .replace(SLOT_RE, '{__slot__}')
    .replace(/on:(\w+)=\{([^}]+)\}/g, (_, ev, fn) =>
      actionNames.has(fn.trim()) ? `data-on-${ev}="$action:${fn.trim()}"` : `data-on-${ev}="${fn}"`);

  // Replace bare state reads with getter calls (after decl removal). A plain
  // regex would also rewrite state names inside string literals - 'name' in
  // new FormData(f).get('name') becoming 'name()' - so scan the script and
  // skip strings, comments, and template-literal text (${} still rewrites).
  cleanScript = callifyStateReads(cleanScript, stateDecls.map((s) => s.name));

  const stateDeclsCode = decls
    .map((d) => {
      if (d.kind === 'state') {
        return `const [${d.name}, ${setterNames.get(d.name)!}] = state("${d.name}", ${d.expr});`;
      }
      // $data: fetch only when this key has no value yet (server: always after
      // clearRequestState; client: only on first visit or client-side nav)
      const isFn = d.expr.includes('=>') || d.expr.startsWith('function');
      const fn = isFn ? d.expr : `() => (${d.expr})`;
      return `const __had_${d.name} = hasState("${d.name}");
const [${d.name}, set${capitalize(d.name)}] = state("${d.name}", null);
if (!__had_${d.name}) set${capitalize(d.name)}(await $data(${fn}));`;
    })
    .join('\n');

  const stateKeys = decls.map((d) => d.name);

  const compiledTemplate = compileTemplate(ssrTemplate, 'h', '__c', null, 0);
  // head block: no markers (esc() inline) - the whole block re-renders per
  // call, so one reactive closure drives document title/meta on navigation.
  const compiledHead = headContent.trim() ? compileTemplate(headContent, '__hd', '__hc', null, 0, false) : '';

  // Actions ship in the SSR module only; the client bundle gets every other
  // export (params, sync helpers) but never an action body.
  const ssrExports = actions.length > 0 ? `${exportStmts}\n${actions.map((a) => a.stmt).join('\n')}` : exportStmts;
  const ssr = generateSSR(cleanScript, compiledTemplate, stateDeclsCode, ssrExports, compiledHead);
  const client = generateClient(cleanScript, compiledTemplate, stateDeclsCode, eventBindings, exportStmts, compiledHead);

  return { ssr, client, stateKeys, actionNames: [...actionNames], style: scopedStyle, hasParams, usesContext, revalidate, csr, needsClient, clientReasons, jsWarnings, headers };
}

/**
 * Scope a component's CSS to its own subtree: every selector is prefixed
 * with the component's scope attribute, recursing into @media/@supports.
 * ponytail: no full CSS parser - comma lists only, and @keyframes blocks
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

// ponytail: tolerate leading indentation - .rose script blocks are indented
const EXPORT_RE = /^[ \t]*export\s+(?:(const|let|var)|(?:async\s+)?function)\s+(\w+)/gm;

/**
 * Lift top-level `export const/let/var/function` statements out of the script
 * body. They must be self-contained (no references to state or template
 * scope) - they exist for build-time consumers like dynamic-route `params`.
 *
 * Every exported ASYNC function is a SERVER-ONLY action (Next.js semantics:
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

function extractExports(script: string): { clean: string; exports: string; actions: Array<{ name: string; stmt: string }> } {
  const stmts: string[] = [];
  const actions: Array<{ name: string; stmt: string }> = [];
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
    if (asyncFn) {
      actions.push({ name: asyncFn[1], stmt }); // server-only: kept out of the client bundle
    } else {
      stmts.push(stmt);
    }
    pos = i;
  }
  out += script.slice(pos);
  return { clean: out, exports: stmts.join('\n'), actions };
}

function extractDecls(script: string): Decl[] {
  const decls: Decl[] = [];
  DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DECL_RE.exec(script))) {
    const open = m.index + m[0].length;
    let depth = 1;
    let i = open;
    while (i < script.length && depth > 0) {
      const ch = script[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    let end = i;
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
 */
function compileTemplate(
  template: string,
  acc: string,
  closes: string,
  scope: string | null,
  depth: number,
  markers = true
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

    const candidates: Array<{ type: string; match: RegExpExecArray; index: number }> = [];
    if (ifMatch?.index !== undefined) candidates.push({ type: 'if', match: ifMatch, index: ifMatch.index });
    if (eachMatch?.index !== undefined) candidates.push({ type: 'each', match: eachMatch, index: eachMatch.index });
    if (boundaryMatch?.index !== undefined) candidates.push({ type: 'boundary', match: boundaryMatch, index: boundaryMatch.index });
    if (exprMatch?.index !== undefined) candidates.push({ type: 'expr', match: exprMatch, index: exprMatch.index });
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
      const call = cond.trim().endsWith('()') ? cond.trim() : `${cond.trim()}()`;
      const id = nextId();
      const innerScope = scope ?? '__s';
      // Inner markers live in the block's OWN closes array, so wiring an
      // adopted/cloned block never re-touches the parent's markers.
      const inner = compileTemplate(content.trim(), 'h', '__c', innerScope, depth + 1, markers);
      result += `const __b${id} = (__s, __c) => { let h = ''; ${inner} return h; };\n`;
      if (markers) {
        result += `const __c${id} = [];\n`;
        result += `const __bh${id} = __b${id}(${scope ?? 'undefined'}, __c${id});\n`;
        result += `const __i${id} = ${closes}.length;\n`;
        result += `${closes}.push(() => (${call}) ? { html: __bh${id}, closes: __c${id} } : null);\n`;
        result += `${acc} += "<!--\u27e6i:" + __i${id} + "\u27e7-->";\n`;
        result += `{ const __r = ${closes}[__i${id}](); if (__r) ${acc} += __r.html; }\n`;
        result += `${acc} += "<!--\u27e6/i:" + __i${id} + "\u27e7-->";\n`;
      } else {
        result += `${acc} += (${call}) ? __b${id}(${scope ?? 'undefined'}, []) : '';\n`;
      }
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    } else if (earliest.type === 'each') {
      const [, items, item, content] = earliest.match;
      const before = remaining.substring(0, earliest.index);
      if (before) result += emitChunk(before, acc, closes, scope);
      const call = items.trim().endsWith('()') ? items.trim() : `${items.trim()}()`;
      const id = nextId();
      // Rename the item variable to the block's scope parameter
      const scoped = content.trim().replace(new RegExp(`\\b${item}\\b`, 'g'), '__s');
      const inner = compileTemplate(scoped, 'h', '__c', '__s', depth + 1, markers);
      result += `const __b${id} = (__s, __c) => { let h = ''; ${inner} return h; };\n`;
      if (markers) {
        result += `const __i${id} = ${closes}.length;\n`;
        result += `${closes}.push(() => (${call}).map((${item}) => { const __c = []; return { html: __b${id}(${item}, __c), closes: __c, scope: ${item} }; }));\n`;
        result += `${acc} += "<!--\u27e6l:" + __i${id} + "\u27e7-->";\n`;
        result += `${closes}[__i${id}]().forEach((__r) => { ${acc} += __r.html; });\n`;
        result += `${acc} += "<!--\u27e6/l:" + __i${id} + "\u27e7-->";\n`;
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
      const inner = compileTemplate(content.trim(), 'h', closes, scope, depth + 1, markers);
      result += `const __b${id} = (__c) => { let h = ''; ${inner} return h; };\n`;
      result += `let __bd${id} = '';\n`;
      result += `try { __bd${id} = __b${id}(${closes}); } catch { __bd${id} = ${JSON.stringify(BOUNDARY_FALLBACK)}; }\n`;
      result += `${acc} += __bd${id};\n`;
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
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
      // attr={expr} -> reactive attribute; otherwise a text marker
      const attrMatch = before.match(/([\w-]+)=\s*$/);
      if (attrMatch) {
        const lit = before.slice(0, before.length - attrMatch[0].length);
        if (lit) result += emitChunk(lit, acc, closes, scope);
        result += emitAttr(attrMatch[1], trimmed, acc, closes, scope, markers);
      } else {
        if (before) result += emitChunk(before, acc, closes, scope);
        result += emitText(trimmed, acc, closes, scope, markers);
      }
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    }
  }

  return result;
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
// ponytail: fixed 4 KB cap; make it configurable when a real app cares
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

/** Emit a reactive text marker: <!--⟦m:K⟧-->escaped value. */
function emitText(expr: string, acc: string, closes: string, scope: string | null, markers = true): string {
  const arg = scope ? `${scope}` : '';
  if (!markers) {
    // head block: inline escaped value, no marker comment (clean SSR html)
    return `${acc} += esc(${expr});\n`;
  }
  return `${acc} += "<!--\u27e6m:" + (${closes}.push(${scope ? `(${scope})` : '()'} => (${expr})) - 1) + "\u27e7-->" + esc(${closes}[${closes}.length - 1](${arg}));\n`;
}

/** Emit a reactive attribute: name="value" data-b="K:name". */
function emitAttr(attr: string, expr: string, acc: string, closes: string, scope: string | null, markers = true): string {
  if (!markers) {
    return `${acc} += '${attr}="' + esc(${expr}) + '"';\n`;
  }
  const arg = scope ? `${scope}` : '';
  return `${acc} += '${attr}="' + esc(${closes}[${closes}.push(${scope ? `(${scope})` : '()'} => (${expr})) - 1](${arg})) + '" data-b="' + (${closes}.length - 1) + ':${attr}"';\n`;
}

/**
 * <slot /> -> inline the children html. The page rendered first with the same
 * shared closes array, so the top-level wire() pass resolves its markers.
 */
function compileSlot(acc: string): string {
  return `${acc} += String(children);\n`;
}

function generateSSR(script: string, templateFn: string, stateDeclsCode: string, exports = '', headFn = ''): string {
  // The head block renders to a clean html string (no markers) and is wrapped
  // in an h marker pair: renderPage extracts it for <head> injection, the
  // client's wire() applies it to the document on navigation.
  const headCode = headFn
    ? `
const __head = () => { let __hd = ''; ${headFn} return __hd; };
const __hi = closes.length;
closes.push(__head);
__html += "<!--\u27e6h:" + __hi + "\u27e7-->" + __head() + "<!--\u27e6/h:" + __hi + "\u27e7-->";`
    : '';
  return `
import { state, $data, hasState, esc, refresh, onMount, onCleanup, getContext, $t, bestLocale } from './runtime.js';

${exports}

export async function render(closes, children) {
  ${stateDeclsCode}
  ${script}
  const __root = (__c, children) => { let h = ''; ${templateFn} return h; };
  let __html = await __root(closes, children);${headCode}
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
  headFn = ''
): string {
  // Handlers live on a shared global so one delegated listener per event
  // type can dispatch for any component, including freshly cloned nodes.
  const handlerRegistry = eventBindings.length > 0
    ? `Object.assign(__handlers, { ${eventBindings.map((b) => b.fn).join(', ')} });`
    : '';
  const headCode = headFn
    ? `
const __head = () => { let __hd = ''; ${headFn} return __hd; };
const __hi = closes.length;
closes.push(__head);
__html += "<!--\u27e6h:" + __hi + "\u27e7-->" + __head() + "<!--\u27e6/h:" + __hi + "\u27e7-->";`
    : '';

  return `
import { state, $data, hasState, esc, refresh, onMount, onCleanup, getContext, $t, bestLocale } from './runtime.js';

${exports}

const __handlers = globalThis.__rosefn_handlers ?? (globalThis.__rosefn_handlers = {});

export async function render(closes, children) {
  ${stateDeclsCode}
  ${script}
  ${handlerRegistry}
  const __root = (__c, children) => { let h = ''; ${templateFn} return h; };
  let __html = await __root(closes, children);${headCode}
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
 * Innovation #29's decision as a pure function: does this route's document
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
 * The build's zero-JS lint report (innovation #31): one line per route with
 * its verdict and the exact reason - which component in the chain needs the
 * client bundle and why, or that nothing does. Pure: the same inputs the
 * route table is built from.
 */
export function buildReport(infos: RouteInfo[], compiled: CompileResult[]): string[] {
  return infos
    .map((info, i) => ({ info, i }))
    .filter(({ info }) => !info.isLayout && !info.isNotFound && !info.isError && !info.isApi && !info.isMiddleware)
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

export async function buildProject(root: string, outDir: string): Promise<RouteInfo[]> {
  await fs.promises.mkdir(outDir, { recursive: true });

  // stale intermediates from an older build layout must not survive into the
  // deploy dir (they used to live directly in outDir)
  const stale = (await fs.promises.readdir(outDir)).filter((f) =>
    /^(?:comp-\d+\.(?:ssr|client)|runtime|(?:server|client)-entry)\.js$/.test(f));
  await Promise.all(stale.map((f) => fs.promises.rm(path.join(outDir, f), { force: true })));

  const files = await scanRoseFiles(root);
  const infos = files.map((f) => ({ ...getRouteInfo(f, root) }));
  // Plugins (innovation #30): rosefn.config.js at the project root, loaded
  // fresh per build so the dev server's hot rebuild picks up config edits.
  const plugins = await loadPlugins(root);
  // scope key: the component's path under pages/ (index, _layout, blog/[id])
  // - stable across builds, unique per file, independent of scan order
  const scopeKeys = files.map((f) =>
    path.relative(path.join(root, 'src', 'pages'), f).replace(/\\/g, '/').replace(/\.rose$/, ''));
  const compiled = await Promise.all(
    files.map((f, i) => compileComponent(f, path.join(root, 'public'), scopeKeys[i], infos[i].isApi, plugins))
  );

  // Every component's scoped CSS in one stylesheet, inlined into the shell:
  // styles ship inside the document like the JS bundle - zero requests.
  const styles = compiled.map((c) => c.style).filter(Boolean).join('\n');
  if (styles) await fs.promises.writeFile(path.join(outDir, 'styles.css'), styles);
  else await fs.promises.rm(path.join(outDir, 'styles.css'), { force: true });

  // i18n (innovation #27): every JSON file in src/locales/ is a language.
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

  // Shared runtime module, bundled once into client and server output
  const runtimeEntry = path.join(root, '..', 'src', 'runtime', 'index.ts');
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
    .filter(({ info }) => !info.isLayout && !info.isNotFound && !info.isError && !info.isApi && !info.isMiddleware);

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

  // Innovation #29: the compiler decides zero-JS, not the developer. A route
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
      return names.length > 0
        ? `import { render as render_${i}, ${actionImports} } from './comp-${i}.ssr.js';`
        : `import { render as render_${i} } from './comp-${i}.ssr.js';`;
    })
    .join('\n');

  // pages/404.rose renders for unmatched routes (SSR + client), wrapped in
  // its layouts like any other page; absent -> the built-in plain 404.
  const nfIdx = infos.findIndex((info) => info.isNotFound);
  const notFoundRender = nfIdx >= 0 ? compose(nfIdx) : 'null';

  // pages/500.rose renders for routes whose render throws (a dead $data
  // source, a bad expression): the page degrades instead of crashing the
  // response; absent -> the built-in plain 500.
  const errIdx = infos.findIndex((info) => info.isError);
  const errorRender = errIdx >= 0 ? compose(errIdx) : 'null';

  // pages/_middleware.rose: the request interceptor (absent -> null).
  const middlewareIdx = infos.findIndex((info) => info.isMiddleware);

  const serverRoutes = pages
    .map(({ info, i }) => {
      // actions: name -> imported fn, so a POST's __action field (default
      // 'action', the progressive-enhancement form's conventional target)
      // selects which one runs before the render
      const actionMap = compiled[i].actionNames.map((n) => `${n}: ${n}_${i}`).join(', ');
      // csr: false rides on the route so renderPage/renderPageStream can drop
      // the state script + bundle from the document (innovation #25; the
      // decision is the compiler's since #29). An explicit opt-out is also
      // checked against the chain: a layout needing the bundle under a
      // csr = false page would ship dead handlers, so the build fails.
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
      return `{ pattern: '${info.pattern}', path: '${info.routePath}', render: ${compose(i)}, actions: ${actionMap ? `{ ${actionMap} }` : 'null'}${csrFlag} }`;
    })
    .join(',\n  ');

  const serverEntry = `
${serverImports}
import { setState, clearRequestState, serializeState, resetRequestContext, isLocale, setLocales, localeList } from './runtime.js';

// i18n (innovation #27): the dictionaries baked at build time from
// src/locales/*.json. A route segment named [lang] is the locale: the value
// must name one of these dictionaries, and $t resolves keys against it.
setLocales(${localesJson}, '${defaultLocale}');

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
// the file (ISR, innovation #24). Routes that read the request context are
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

// Routes whose DOCUMENTS ship without the client bundle (innovation #25,
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

// Per-route response headers (innovation #26): a route exporting a headers
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
      // i18n (innovation #27): a [lang] segment naming no dictionary is a
      // 404 - the URL is the contract, and rendering the page with fallback
      // strings would serve duplicate content under a bogus language
      const langIdx = patternParts.indexOf(':lang');
      if (langIdx >= 0 && !isLocale(pathParts[langIdx])) {
        if (notFound) return { ...(await renderFallback(pathname, notFound)), status: 404 };
        return { html: '<h1>404</h1><p>Page not found</p>', state: '{}', head: [], status: 404 };
      }
      if (form && route.actions) {
        const fn = route.actions[form.get('__action') || 'action'];
        if (fn) {
          const patch = await fn(form);
          if (patch && typeof patch === 'object') {
            for (const key of Object.keys(patch)) setState(key, patch[key]);
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
      // csr (innovation #25, auto since #29): false when the compiler found
      // nothing in the route's chain that needs the client (or the route
      // asserted csr = false) - the document ships no runtime, no state
      // script, zero JavaScript. Every other route keeps the bundle. The
      // caller passes this straight to the shell as js.
      return { html: rendered.html, state, head: rendered.head, status: 200, csr: route.csr !== false };
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
    // i18n (innovation #27): an unknown locale must answer 404, and a
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
      // csr: false (innovation #25, auto since #29): a no-JS route's document
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
  });

  // api routes and the middleware have no client module: they are
  // server-only handlers / interceptors
  const clientImports = compiled
    .map((_, i) => ({ i }))
    .filter(({ i }) => !infos[i].isApi && !infos[i].isMiddleware)
    .map(({ i }) => `import { render as render_${i} } from './comp-${i}.client.js';`)
    .join('\n');

  const clientRoutes = pages
    .map(({ info, i }) => `{ pattern: '${info.pattern}', render: ${compose(i)} }`)
    .join(',\n  ');

  const clientEntry = `
${clientImports}
import { setState, resumeState, clearRequestState, resetEffects, wire, isolateStateAsync, restoreState, setRefreshHook, clearMounts, flushMounts, adoptCleanups, setLocales, isLocale } from './runtime.js';

// i18n (innovation #27): the dictionaries baked at build time - the client
// renders any locale from the bundle, so switching language costs zero
// requests (the same bet as the inlined route table).
setLocales(${localesJson}, '${defaultLocale}');

const routes = [
  ${clientRoutes}
];

// pages/404.rose (with its layouts) or null -> built-in plain 404
const notFound = ${notFoundRender};

// pages/500.rose (with its layouts) or null -> built-in plain 500: a route
// whose render throws on the client degrades to this instead of breaking
// navigation.
const errorPage = ${errorRender};

// Paint a fallback page (404/500) into the container, wired like any render.
async function paintFallback(container, render, builtin) {
  resetEffects();
  clearRequestState();
  clearMounts(); // a failed render leaves stale mounts behind
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
// paints from the cached HTML: no await, no request, no spinner. SvelteKit
// and Qwik prefetch data only; Rosefn prefetches the whole render because
// the inlined bundle already contains every route.
// ponytail: the cache holds either a result or the in-flight promise (dedupes
// hover storms); one isolated render runs at a time so signal-map swapping
// stays correct without any merging logic. Entries are single-use: a consumed
// entry disappears from the cache, which is also how tests observe a hit.
const prefetchCache = new Map(); // pathname -> { html, closes, state } | Promise
let prefetchQueue = Promise.resolve();

function applyParams(route, pathname) {
  const patternParts = route.pattern.split('/');
  const pathParts = pathname.split('/');
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) setState(patternParts[i].slice(1), pathParts[i]);
  }
}

export function prefetch(pathname) {
  if (prefetchCache.has(pathname)) return;
  if (pathname === location.pathname) return; // already here: nothing to prefetch
  const route = routes.find((r) => matchRoute(r.pattern, pathname));
  if (!route) return;
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
        const html = await route.render(closes, '');
        return { html, closes };
      });
      const entry = { ...result, state, mounts, cleanups };
      prefetchCache.set(pathname, entry); // promise -> result
      return entry;
    } catch {
      prefetchCache.delete(pathname); // failed: the next hover retries
      return null;
    }
  });
  prefetchCache.set(pathname, p);
  prefetchQueue = p;
}

export function prefetchStats() {
  return { cached: prefetchCache.size };
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
        html = await route.render(closes, '');
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
        await route.render(closes, '');
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
// (Next.js) / invalidateAll() (SvelteKit). Same machinery as a client-side
// navigation to the current path - $data re-runs, state re-seeds from the
// fresh render, wire() patches the marked nodes - but a refresh never lands
// a prefetch entry: a hover from a minute ago is exactly what it exists to
// bypass. Zero requests: the render (and its $data) runs in the page.
// ponytail: state resets like navigation (no per-key retention); add
// retention when an app needs refresh-without-losing-input.
setRefreshHook(async () => {
  prefetchCache.delete(location.pathname);
  await start(document.getElementById('app'), location.pathname, false);
});
`;
  await fs.promises.writeFile(path.join(buildDir, 'client-entry.js'), clientEntry);
  await esbuild.build({
    entryPoints: [path.join(buildDir, 'client-entry.js')],
    bundle: true,
    outfile: path.join(outDir, 'client.js'),
    format: 'esm',
    platform: 'browser',
    minify: true,
    write: true,
  });

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

  // Innovation #31: the build's zero-JS lint report - every route, its
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

  return pages.map(({ info }) => info);
}

async function scanRoseFiles(root: string): Promise<string[]> {
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
  const isLayout = base === '_layout';
  const isNotFound = base === '404';
  const isError = base === '500';
  // pages/api/*.rose: Web-standard handler routes (JSON in, JSON out), never
  // HTML pages - they dispatch by method and never reach the client bundle.
  const isApi = withoutExt === 'api' || withoutExt.startsWith('api/');
  // pages/_middleware.rose: the request interceptor. It runs before every
  // render and is not a route: it matches nothing and never reaches the
  // client bundle. ponytail: root only - one chain, no matcher config.
  const isMiddleware = withoutExt === '_middleware';

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
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
