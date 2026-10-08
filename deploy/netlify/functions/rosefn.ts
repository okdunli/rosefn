/**
 * The rosefn Netlify function - the dynamic half of a Netlify deploy.
 *
 * Every request that is NOT a static file in dist/ lands here: dynamic
 * pages (/sign, anything reading getContext() or $store()), /api routes,
 * and POST server actions. Static answers - prerendered documents, the
 * bundles, baked API bodies - are served by the CDN straight from dist/
 * (the `publish` directory) and never touch this code. That split is the
 * whole rosefn story: the static half costs zero function invocations.
 *
 * It reuses the framework's own edge adapter (the same Web-standard fetch
 * handler the edge adapter test exercises) over the built server bundle,
 * on Netlify's Functions v2 Web-standard signature - `export default`
 * taking a Request and returning a Response. Netlify compiles TypeScript
 * entrypoints and their imports, so this file and the adapter it pulls in
 * stay .ts. The Lambda runtime has a filesystem, so `included_files`
 * (`dist/**` in netlify.toml) carries dist/ into the bundle and the
 * adapter reads server.js / client.js from it at boot.
 *
 * Install: copy this file to <project>/netlify/functions/rosefn.ts and
 * deploy/netlify.toml to <project>/netlify.toml, then push (or
 * `netlify deploy --prod`). In a project that depends on the published
 * package the import below becomes:
 *   import { createEdgeHandler } from 'rosefn/edge';
 */
import { createEdgeHandler } from '../../src/cli/edge.ts';
import { fileURLToPath } from 'node:url';

// dist/ two levels up from netlify/functions/, whatever the working
// directory is. Built on the first request (a cold start reads the files
// once per isolate) and cached for the isolate's lifetime.
let handle: ((request: Request) => Promise<Response>) | null = null;

export default async function rosefn(request: Request): Promise<Response> {
  if (!handle) {
    handle = await createEdgeHandler(fileURLToPath(new URL('../../dist', import.meta.url)));
  }
  return handle(request);
}
