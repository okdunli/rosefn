/**
 * The canonical .rose authoring contract, printed by `rosefn prompt`.
 *
 * Why a command and not a doc page: the audience is as often an AI agent as
 * a human, and the agent needs the contract at the moment it writes code,
 * not a URL to go read. One command, stdout, no network - the same shape as
 * every other tool an agent already shells out to.
 *
 * The content is the compiler's actual rules, in the order a page meets
 * them: file layout, the script block, the template, head and styles,
 * events and actions, the exports, the npm boundary, and the error
 * contract. Anything the compiler REFUSES is listed as a rule here, so a
 * correct page compiles on the first try.
 */
export const AI_PROMPT = `# Rosefn authoring contract (printed by \`rosefn prompt\`)

Rosefn is a zero-hydration web framework: a .rose file compiles to a server
render plus a client resume bundle, one request per page, no hydration. Write
the smallest thing that works - the compiler decides what ships.

## File layout (all paths relative to the project root)

- src/pages/index.rose            -> route /
- src/pages/about.rose            -> route /about
- src/pages/blog/[id].rose        -> route /blog/:id (the param is readable as state \`id()\`)
- src/pages/[lang]/about.rose     -> localized route (see i18n below)
- src/pages/_layout.rose          -> root layout wrapping every route (app-global exports live here)
- src/pages/_middleware.rose      -> server-only request middleware (handle(request), getContext())
- src/pages/404.rose, 500.rose    -> error pages
- src/pages/api/posts.rose        -> JSON API route (export async function GET/POST/...)
- src/components/Card.rose        -> reusable component, imported by relative path
- src/locales/en.json             -> i18n dictionaries (one file per language)

## A page

\`\`\`rose
<script>
  let count = $state(0);                       // reactive state: read it as count()
  let posts = $data(async () => db.query());   // server data: awaited on the server,
                                               // resumed on the client - never re-fetched
  const total = count() + 1;                   // a top-level read AFTER the declaration is fine
  async function like() {                      // a server action (progressive enhancement)
    return $merge({ likes: 1 });
  }
</script>

<h1>Posts</h1>
<p>Total: {total}</p>
<button on:click={() => $setState('count', count() + 1)}>+1</button>
<form method="POST"><input type="hidden" name="__action" value="like"><button type="submit">Like</button></form>
\`\`\`

Rules the compiler enforces (breaking one fails the build):

- The script block is TypeScript. Types, interfaces, \`import type\`, \`as\` casts and
  type arguments ($state<Post[]>([])) are all erased from the shipped bundles.
- $state / $data declarations are top-level statements. The declared name IS the
  getter: write count() in the template and the script, never bare count.
- A route param (pages/blog/[id].rose) is read as state too: declare it
  (\`let id = $state('1')\`) and read id() - the server overwrites the default
  with the URL's value, and export const params = { id: [...] } bakes those
  values at build time.
- $data() is banned in components (src/components/**) - a component renders
  synchronously inside its parent. Fetch in the page or the middleware and pass
  the value down as a prop.
- Template interpolation {expr} is HTML-escaped. {@html expr} is the explicit
  trusted-HTML escape hatch - use it only for content you control.
- Blocks: {#if cond}...{/if}, {#each items as item}...{/each},
  {#boundary}...{/boundary}. There is NO {:else} - nest a second {#if}.
- A <slot> with attributes is a named slot and must declare its name:
  <slot name="row" item={post} />. A named slot must be a DIRECT child of the
  component tag - never inside another element or an {#if}/{#each} block.
- Every component tag needs its matching close tag (or self-closes with />).
- In <head>: <title>, <meta>, <link>, <style>, <script>, <noscript> all pass
  through. A <style> inside <head> is document CSS; a <style> in the body is
  the component's scoped stylesheet.
- Node-only modules (node:fs, better-sqlite3, pg, redis, ...) are REFUSED in
  pages and components: their script ships to the browser. Import them in
  src/pages/_middleware.rose or a pages/api/*.rose handler instead, and pass
  the rows to the page through getContext().

## Events and server actions

- on:click={handler} wires a client event. The handler is a named function from
  the script or an inline arrow: on:click={() => $setState('n', n() + 1)}.
- A server action is an exported async function. Call it from a native form
  (method="POST", no JS needed - progressive enhancement) or from any event
  (on:click={like} - one POST, in-place adopt). Its return value is an
  incremental patch: $append(row) / $prepend(row) / $merge({...}).
- A form selects its action by the __action FIELD: name the function
  \`action\` (the default) or add <input type="hidden" name="__action"
  value="like">. The server reads the field, not the URL.
- Business failures: throw new ActionError('message', 422, 'field'). It lands
  in ordinary state - $actionError() reads it back, a {#boundary} contains it.
- beforeAction(name, form) is the per-page guard that vetoes an action.

## Route exports (in the script block, validated at build time)

- export const csr = false | true   force/assert zero-JS (absent = the compiler decides)
- export const buffer = true        keep this route off the streaming path
- export const headers = { ... }    flat string map, merged over the strict CSP default
- export const csp = { nonce: true } per-response nonce instead of the hash (route becomes dynamic)
- export const prefetch = 'off' | 'hover' | 'viewport' | 'all'   app-global, root layout only
- export const bundle = 'inline' | 'split'   app-global; 'split' = mode B for large apps
- export const vitals = true        opt into the web-vitals hook
- export const revalidate = N       stale-while-revalidate ISR window, seconds
- export const params = { id: ['1'] }  prerender these param values at build time
- export const prerender = true     (api routes) bake the GET body for static deploys

## i18n

src/locales/<lang>.json is a dictionary; a [lang] route segment selects one;
$t('key', { name }) translates reactively; unknown locales answer 404.

## When a build fails

Every compiler failure is structured: { code, file, line, message, hint }.
Run \`rosefn build --json\` to read it as JSON, fix the named file at the named
line, and build again. Codes: E-IMPORT (unresolvable .rose import), E-PLUGIN
(transform threw), E-NODE-ONLY (server-only import in a page/component),
E-EXPORT (invalid export const value), E-TEMPLATE (unclosed tag / slot
placement), E-ROUTE (no pages found), E-INTERNAL (installation problem).

## The one invariant worth protecting

A route ships ONE request with ZERO hydration: the whole client bundle is
inlined in the document. Keep it that way - browser-only code (document.,
window., timers) belongs in onMount, and anything the predicate cannot see
(inline on* attributes, javascript: URLs, eval) is reported by the build.
`;
