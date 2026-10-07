/**
 * rosefn Edge adapter - Web-standard fetch handler.
 *
 * Works on any edge runtime that supports the Fetch API standard
 * (Cloudflare Workers, Deno Deploy, Vercel Edge, Bun, Node 18+):
 *
 *   import { createEdgeHandler } from 'rosefn/edge';
 *   const handle = createEdgeHandler('./dist');
 *   export default { fetch: handle };
 *
 * The generated dist/server.js has zero Node built-in imports, so the same
 * bundle that runs the Node server runs at the edge. Static routes can be
 * served by the platform's asset layer; everything else renders on demand.
 * GETs to known routes stream (the static shell flushes before the render
 * completes, still one request); routes known-broken at build time
 * (dist/broken.json) stay buffered so their real 500 status survives, and
 * csr = false routes buffer so their document is complete without a client.
 */

import { pathToFileURL } from 'url';
import { join } from 'path';
import { buildShell, shellOpen, clientScriptTag, securityHeaders, mintNonce } from './shell.js';

type ServerModule = {
  renderPage(pathname: string, form?: FormData): Promise<{ html: string; state: string; head: string[]; status?: number; csr?: boolean; lang?: string; dir?: string }>;
  renderPageStream(pathname: string, write: (chunk: string) => void, shellOpen: string, clientTag: string): Promise<number>;
  canStream(pathname: string): boolean;
  isNoJs(pathname: string): boolean;
  /** P0-2: routes that exported `buffer = true` - buffered, never streamed */
  isBuffered(pathname: string): boolean;
  isApi(pathname: string): boolean;
  handleApi(method: string, pathname: string, request: Request): Promise<Response>;
 /** The document's <html lang>/<dir> for a pathname (streaming needs them before the render) */
  docAttrs(pathname: string): { lang: string; dir: string };
  /** pages/_middleware.rose's handler, or null when the project has none */
  middleware: ((request: Request) => Promise<Response | void | null>) | null;
  /** run the middleware once per request; returns its short-circuit Response or null */
  runMiddleware(rawReq: any, form?: FormData): Promise<Response | null>;
 /** The runtime plugin hooks, and whether the project declares any */
  runRequestHooks(ctx: {
    request: Request; url: URL; method: string; pathname: string; state: Record<string, unknown>;
  }): Promise<Response | null>;
  runResponseHooks(ctx: {
    request: Request; url: URL; method: string; pathname: string; state: Record<string, unknown>;
  }, res: Response): Promise<Response>;
  hasRequestHooks: boolean;
  hasResponseHooks: boolean;
  /** routes whose component reads getContext(): never prerendered, always live */
  dynamicRoutes: string[];
 /** per-route response headers [] when no route exports any */
  routeHeaders: Array<{ pattern: string; headers: Record<string, string> }>;
  /** the route's own exported headers for a pathname, or null */
  headersFor(pathname: string): Record<string, string> | null;
 /** Routes that exported `csp = { nonce: true }` - nonce policy, never baked */
  cspNonce(pathname: string): boolean;
  /** P0-1: the query of the request being rendered, for $query() */
  setQuery(query: Record<string, string>): void;
};

/**
 * CSRF: the edge twin of the Node server's guard. A state-changing request
 * that did not come from this site is refused before anything else runs -
 * middleware, hooks and routing never see it. Browsers stamp every
 * cross-origin POST with an Origin header, so the check is free for real
 * browsers; a client that sends neither Origin nor Sec-Fetch-Site (curl, a
 * health check, the test suites) is not attackable by CSRF - the attack
 * rides the victim's cookies in a browser - so it passes. Returns the
 * refusal, or null.
 */
function crossSiteWrite(request: Request): Response | null {
  const m = request.method;
  if (m !== 'POST' && m !== 'PUT' && m !== 'PATCH' && m !== 'DELETE') return null;
  const origin = request.headers.get('origin');
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return new Response('Cross-site request blocked (unparsable Origin header)', { status: 403 });
    }
    return host === new URL(request.url).host
      ? null
      : new Response('Cross-site request blocked (Origin does not match Host)', { status: 403 });
  }
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
    return new Response(`Cross-site request blocked (sec-fetch-site: ${site})`, { status: 403 });
  }
  return null;
}

/**
 * Create a fetch handler from a built rosefn project.
 * @param outDir directory containing server.js and client.js
 * @param preloaded for runtimes with NO filesystem (Cloudflare Workers /
 *   Pages): the caller statically imports the server bundle (so the deploy
 *   compiler bundles it in) and fetches the site's own static assets once
 *   per isolate. Anything provided here is used verbatim; anything absent
 *   falls back to reading it from outDir, exactly as before.
 */
export async function createEdgeHandler(
  outDir: string,
  preloaded?: { server?: ServerModule; client?: string; styles?: string; broken?: string[] },
): Promise<(request: Request) => Promise<Response>> {
  const mod: ServerModule = preloaded?.server ?? await import(pathToFileURL(join(outDir, 'server.js')).href);
  let client: string | null = null;
  let styles = '';
  if (preloaded && 'client' in preloaded) {
    client = preloaded.client ?? null;
  } else {
    try {
      client = await (await import('fs/promises')).readFile(join(outDir, 'client.js'), 'utf-8');
    } catch {
      client = null; // no fs (Workers): platform should inline the bundle at deploy time
    }
  }
  if (preloaded && 'styles' in preloaded) {
    styles = preloaded.styles ?? '';
  } else {
    try {
      styles = await (await import('fs/promises')).readFile(join(outDir, 'styles.css'), 'utf-8');
    } catch {
      styles = ''; // no component styles (or no fs): shell STYLES only
    }
  }
  // routes whose render failed at build time: buffered, so the 500 survives
  let broken = new Set<string>();
  if (preloaded && 'broken' in preloaded) {
    broken = new Set(preloaded.broken);
  } else {
    try {
      broken = new Set(JSON.parse(await (await import('fs/promises')).readFile(join(outDir, 'broken.json'), 'utf-8')));
    } catch {
      broken = new Set(); // no manifest: nothing known-broken
    }
  }

 // Response headers for a page document: the strict CSP
  // hashed over the exact inlined bytes (the shell code is shared with the
  // Node server, so the hash matches there too) plus the route's own
  // exported headers, which win. Keys are lower-cased first: HTTP header
  // names are case-insensitive, and a Headers object built from a plain
  // object would otherwise carry BOTH spellings of an overridden header
  // as two values. Without fs there is no inlined bundle to hash, so only
 // the route's own headers ship. `nonce` switches this one response
  // to the nonce policy; the caller stamps the same value on the script tag.
  const pageHeaders = (pathname: string, nonce = ''): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (client) for (const [k, v] of Object.entries(securityHeaders(client, nonce))) headers[k.toLowerCase()] = v;
    const own = mod.headersFor?.(pathname);
    if (own) for (const [k, v] of Object.entries(own)) headers[k.toLowerCase()] = v;
    return headers;
  };

  return async function handle(request: Request): Promise<Response> {
    // CSRF: the same guard the Node server runs first - a state-changing
    // request that did not come from this site is refused before anything
    // else (middleware, hooks, routing) ever sees it.
    const refused = crossSiteWrite(request);
    if (refused) return refused;
    const { pathname, searchParams } = new URL(request.url);
    // P0-1: the query reaches the render through $query() - routing itself
    // matches the pathname, exactly as the Node server does.
    mod.setQuery?.(Object.fromEntries(searchParams));
 // Runtime hooks: onRequest runs before middleware and routing
    // and may short-circuit with its own Response - an auth wall, a rate
    // limit. The context is built only when the project declares a hook, so
    // a hook-less deployment pays nothing.
    const hookCtx = mod.hasRequestHooks || mod.hasResponseHooks
      ? { request, url: new URL(request.url), method: request.method, pathname, state: {} as Record<string, unknown> }
      : null;
    if (hookCtx) {
      const short = await mod.runRequestHooks(hookCtx);
      if (short) return mod.runResponseHooks(hookCtx, short);
    }
    // Middleware (pages/_middleware.rose) runs exactly once per request,
    // before anything else: a returned Response short-circuits the whole
    // request (a redirect, an auth wall), and its getContext() bag seeds the
    // render that follows.
    if (mod.middleware) {
      const mw = await mod.runMiddleware(request);
      if (mw) return hookCtx ? mod.runResponseHooks(hookCtx, mw) : mw;
    }
    // API routes (pages/api/*.rose): the /api namespace answers JSON, never
    // the HTML shell - dispatch the method handler with the Web-standard
    // Request this runtime already provides.
    if (mod.isApi(pathname)) {
      const apiRes = await mod.handleApi(request.method, pathname, request);
      return hookCtx ? mod.runResponseHooks(hookCtx, apiRes) : apiRes;
    }
    // POST: progressive-enhancement form - run the route's server action with
    // the submitted FormData and re-render the page (works without JS).
    const form = request.method === 'POST' ? await request.formData() : undefined;
 // csr = false routes buffer too: a streamed no-JS
    // document would carry the shell's default <title> - the route head is
    // applied client-side at boot, and there is no client.
    if (!form && !broken.has(pathname) && !mod.isBuffered?.(pathname) && mod.canStream(pathname) && !mod.isNoJs(pathname)) {
 // The nonce is minted before the Response exists, because its
      // headers are fixed from then on - and the document's script tag is
      // written into that same stream, so both halves carry this one value.
      const nonce = mod.cspNonce?.(pathname) ? mintNonce() : '';
      // streaming GET: one chunked Response, still exactly one request.
 // onResponse runs before the stream is created, while the
      // status and headers can still change; a replacement body is ignored,
      // because the stream produces the body - the honest limit of a
      // streamed response.
      const streamed = new Response(null, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', ...pageHeaders(pathname, nonce) }
      });
      const head = hookCtx ? await mod.runResponseHooks(hookCtx, streamed) : streamed;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
 // The shell opens before the render, so its <html lang>/<dir>
          // come from the pathname (the server bundle's docAttrs)
          const doc = mod.docAttrs(pathname);
          await mod.renderPageStream(
            pathname,
            (chunk) => controller.enqueue(encoder.encode(chunk)),
            shellOpen(styles, doc.lang, doc.dir),
            clientScriptTag(client, nonce)
          );
          controller.close();
        }
      });
      return new Response(stream, { status: head.status, headers: head.headers });
    }
    // buffered: POST actions, unmatched routes (404), known-broken routes (500).
    // The middleware already ran at the top of this handler, so the render
    // below sees its context.
    const page = await mod.renderPage(pathname, form);
 // '' for every hashed route, so the document is byte-identical to
    // what it was before nonce mode existed.
    const nonce = mod.cspNonce?.(pathname) ? mintNonce() : '';
    // js = page.csr !== false: a csr = false route ships no bundle, no state
 // script - the document is HTML + CSS only . page.lang /
 // page.dir are the locale the render used and its direction .
    const html = buildShell(page.html, page.state, client, page.head, styles, page.csr !== false, page.lang, page.dir, nonce);
    const buffered = new Response(html, {
      status: page.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8', ...pageHeaders(pathname, nonce) }
    });
    return hookCtx ? mod.runResponseHooks(hookCtx, buffered) : buffered;
  };
}
