/**
 * The rosefn Cloudflare Pages function - the dynamic half of a Pages
 * deploy.
 *
 * Pages answers static assets (everything in dist/: prerendered
 * documents, bundles, baked API bodies) from its own asset server and
 * invokes this function only for the paths that are NOT files. So the
 * split is the same as on every other target - the static half never
 * pays a function invocation, and the dynamic half (dynamic routes, live
 * /api routes, POST server actions) renders here, one request per page.
 *
 * The `[[path]]` filename is Pages' catch-all: this file handles every
 * incoming URL the asset layer did not answer.
 *
 * workerd has NO filesystem, which is the one real difference from the
 * Node targets: the adapter cannot read dist/ at boot. Two things close
 * that gap, both visible below:
 *
 *   1. `import * as server from '../../dist/server.js'` - a STATIC import,
 *      so Pages' deploy-time compiler bundles the server module into the
 *      function. (The generated bundle has zero Node built-in imports, so
 *      it runs on workerd as-is.)
 *   2. the client bundle, the component styles and the broken-route
 *      manifest are fetched from this very site once per isolate - they
 *      are static assets of the same deployment, and the function only
 *      ever sees non-asset paths, so the fetch cannot re-enter it.
 *
 * The CSP is then computed from the exact fetched bytes, identical to what
 * the Node server hashes: same documents, same headers, every target.
 *
 * Install: copy this file to <project>/functions/[[path]].ts and
 * deploy/cloudflare/wrangler.toml to <project>/wrangler.toml, then
 * `npx wrangler pages deploy` (or push, with the Pages git integration).
 * In a project that depends on the published package the import below
 * becomes:
 *   import { createEdgeHandler } from 'rosefn/edge';
 */
import { createEdgeHandler } from '../src/cli/edge.ts';
import * as server from '../dist/server.js';

// Built on the first request this isolate serves, then cached: one cold
// start, three internal asset fetches, and every later request is the
// same single-request page.
let handle: ((request: Request) => Promise<Response>) | null = null;

export const onRequest = async (context: { request: Request }): Promise<Response> => {
  if (!handle) {
    const base = new URL(context.request.url);
    const [client, styles, broken] = await Promise.all([
      fetch(new URL('/client.js', base)).then((r) => r.text()),
      fetch(new URL('/styles.css', base)).then((r) => (r.ok ? r.text() : '')),
      fetch(new URL('/broken.json', base)).then((r) => (r.ok ? r.json() : [])),
    ]);
    handle = await createEdgeHandler('./dist', {
      server,
      client,
      styles,
      broken: broken as string[],
    });
  }
  return handle(context.request);
};
