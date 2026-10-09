// Rosefn Edge adapter - Web-standard fetch handler.

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

// CSRF: the edge twin of the Node server's guard.
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
      client = null;
    }
  }
  if (preloaded && 'styles' in preloaded) {
    styles = preloaded.styles ?? '';
  } else {
    try {
      styles = await (await import('fs/promises')).readFile(join(outDir, 'styles.css'), 'utf-8');
    } catch {
      styles = '';
    }
  }
  let broken = new Set<string>();
  if (preloaded && 'broken' in preloaded) {
    broken = new Set(preloaded.broken);
  } else {
    try {
      broken = new Set(JSON.parse(await (await import('fs/promises')).readFile(join(outDir, 'broken.json'), 'utf-8')));
    } catch {
      broken = new Set();
    }
  }

  const pageHeaders = (pathname: string, nonce = ''): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (client) for (const [k, v] of Object.entries(securityHeaders(client, nonce))) headers[k.toLowerCase()] = v;
    const own = mod.headersFor?.(pathname);
    if (own) for (const [k, v] of Object.entries(own)) headers[k.toLowerCase()] = v;
    return headers;
  };

  return async function handle(request: Request): Promise<Response> {
    const refused = crossSiteWrite(request);
    if (refused) return refused;
    const { pathname, searchParams } = new URL(request.url);
    const canonical = pathname.replace(/\/+$/, '') || '/';
    if (canonical !== pathname) {
      return new Response(null, { status: 308, headers: { location: canonical + new URL(request.url).search } });
    }
    mod.setQuery?.(Object.fromEntries(searchParams));
    const hookCtx = mod.hasRequestHooks || mod.hasResponseHooks
      ? { request, url: new URL(request.url), method: request.method, pathname, state: {} as Record<string, unknown> }
      : null;
    if (hookCtx) {
      const short = await mod.runRequestHooks(hookCtx);
      if (short) return mod.runResponseHooks(hookCtx, short);
    }
    if (mod.middleware) {
      const mw = await mod.runMiddleware(request);
      if (mw) return hookCtx ? mod.runResponseHooks(hookCtx, mw) : mw;
    }
    if (mod.isApi(pathname)) {
      const apiRes = await mod.handleApi(request.method, pathname, request);
      return hookCtx ? mod.runResponseHooks(hookCtx, apiRes) : apiRes;
    }
    const form = request.method === 'POST' ? await request.formData() : undefined;
    if (!form && !broken.has(pathname) && !mod.isBuffered?.(pathname) && mod.canStream(pathname) && !mod.isNoJs(pathname)) {
      const nonce = mod.cspNonce?.(pathname) ? mintNonce() : '';
      const streamed = new Response(null, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', ...pageHeaders(pathname, nonce) }
      });
      const head = hookCtx ? await mod.runResponseHooks(hookCtx, streamed) : streamed;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
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
    const page = await mod.renderPage(pathname, form);
    const nonce = mod.cspNonce?.(pathname) ? mintNonce() : '';
    const html = buildShell(page.html, page.state, client, page.head, styles, page.csr !== false, page.lang, page.dir, nonce);
    const buffered = new Response(html, {
      status: page.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8', ...pageHeaders(pathname, nonce) }
    });
    return hookCtx ? mod.runResponseHooks(hookCtx, buffered) : buffered;
  };
}
