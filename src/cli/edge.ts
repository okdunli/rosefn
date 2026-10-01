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
import { buildShell, shellOpen, clientScriptTag, securityHeaders } from './shell.js';

type ServerModule = {
  renderPage(pathname: string, form?: FormData): Promise<{ html: string; state: string; head: string[]; status?: number; csr?: boolean }>;
  renderPageStream(pathname: string, write: (chunk: string) => void, shellOpen: string, clientTag: string): Promise<number>;
  canStream(pathname: string): boolean;
  isNoJs(pathname: string): boolean;
  isApi(pathname: string): boolean;
  handleApi(method: string, pathname: string, request: Request): Promise<Response>;
  /** pages/_middleware.rose's handler, or null when the project has none */
  middleware: ((request: Request) => Promise<Response | void | null>) | null;
  /** run the middleware once per request; returns its short-circuit Response or null */
  runMiddleware(rawReq: any, form?: FormData): Promise<Response | null>;
  /** routes whose component reads getContext(): never prerendered, always live */
  dynamicRoutes: string[];
  /** per-route response headers (innovation #26), [] when no route exports any */
  routeHeaders: Array<{ pattern: string; headers: Record<string, string> }>;
  /** the route's own exported headers for a pathname, or null */
  headersFor(pathname: string): Record<string, string> | null;
};

/**
 * Create a fetch handler from a built rosefn project.
 * @param outDir directory containing server.js and client.js
 */
export async function createEdgeHandler(outDir: string): Promise<(request: Request) => Promise<Response>> {
  const mod: ServerModule = await import(pathToFileURL(join(outDir, 'server.js')).href);
  let client: string | null = null;
  let styles = '';
  try {
    client = await (await import('fs/promises')).readFile(join(outDir, 'client.js'), 'utf-8');
  } catch {
    client = null; // no fs (Workers): platform should inline the bundle at deploy time
  }
  try {
    styles = await (await import('fs/promises')).readFile(join(outDir, 'styles.css'), 'utf-8');
  } catch {
    styles = ''; // no component styles (or no fs): shell STYLES only
  }
  // routes whose render failed at build time: buffered, so the 500 survives
  let broken = new Set<string>();
  try {
    broken = new Set(JSON.parse(await (await import('fs/promises')).readFile(join(outDir, 'broken.json'), 'utf-8')));
  } catch {
    broken = new Set(); // no manifest: nothing known-broken
  }

  // Response headers for a page document (innovation #26): the strict CSP
  // hashed over the exact inlined bytes (the shell code is shared with the
  // Node server, so the hash matches there too) plus the route's own
  // exported headers, which win. Keys are lower-cased first: HTTP header
  // names are case-insensitive, and a Headers object built from a plain
  // object would otherwise carry BOTH spellings of an overridden header
  // as two values. Without fs there is no inlined bundle to hash, so only
  // the route's own headers ship.
  const pageHeaders = (pathname: string): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (client) for (const [k, v] of Object.entries(securityHeaders(client))) headers[k.toLowerCase()] = v;
    const own = mod.headersFor?.(pathname);
    if (own) for (const [k, v] of Object.entries(own)) headers[k.toLowerCase()] = v;
    return headers;
  };

  return async function handle(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    // Middleware (pages/_middleware.rose) runs exactly once per request,
    // before anything else: a returned Response short-circuits the whole
    // request (a redirect, an auth wall), and its getContext() bag seeds the
    // render that follows.
    if (mod.middleware) {
      const mw = await mod.runMiddleware(request);
      if (mw) return mw;
    }
    // API routes (pages/api/*.rose): the /api namespace answers JSON, never
    // the HTML shell - dispatch the method handler with the Web-standard
    // Request this runtime already provides.
    if (mod.isApi(pathname)) {
      return mod.handleApi(request.method, pathname, request);
    }
    // POST: progressive-enhancement form - run the route's server action with
    // the submitted FormData and re-render the page (works without JS).
    const form = request.method === 'POST' ? await request.formData() : undefined;
    // csr = false routes (innovation #25) buffer too: a streamed no-JS
    // document would carry the shell's default <title> - the route head is
    // applied client-side at boot, and there is no client.
    if (!form && !broken.has(pathname) && mod.canStream(pathname) && !mod.isNoJs(pathname)) {
      // streaming GET: one chunked Response, still exactly one request
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await mod.renderPageStream(
            pathname,
            (chunk) => controller.enqueue(encoder.encode(chunk)),
            shellOpen(styles),
            clientScriptTag(client)
          );
          controller.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', ...pageHeaders(pathname) }
      });
    }
    // buffered: POST actions, unmatched routes (404), known-broken routes (500).
    // The middleware already ran at the top of this handler, so the render
    // below sees its context.
    const page = await mod.renderPage(pathname, form);
    // js = page.csr !== false: a csr = false route ships no bundle, no state
    // script - the document is HTML + CSS only (innovation #25)
    const html = buildShell(page.html, page.state, client, page.head, styles, page.csr !== false);
    return new Response(html, {
      status: page.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8', ...pageHeaders(pathname) }
    });
  };
}
