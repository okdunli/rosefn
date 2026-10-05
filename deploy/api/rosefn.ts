/**
 * The rosefn Vercel function - the dynamic half of a Vercel deploy.
 *
 * Every request that is NOT a static file in dist/ lands here: dynamic
 * pages (/sign, anything reading getContext() or $store()), /api routes,
 * and POST server actions. Static answers - prerendered documents, the
 * bundles, baked API bodies - are served by the CDN straight from dist/
 * and never touch this code. That split is the whole rosefn story: the
 * static half costs zero function invocations.
 *
 * It reuses the framework's own edge adapter (the same Web-standard fetch
 * handler the edge adapter test exercises) over the built server bundle,
 * on Vercel's Node.js runtime, whose Web Standard handler is
 * `export default { fetch }` - one handler object, every method. The
 * Node.js runtime compiles TypeScript entrypoints and their imports, so
 * this file and the adapter it pulls in stay .ts.
 *
 * Install: copy this file to <project>/api/rosefn.ts and deploy/vercel.json
 * to <project>/vercel.json, then `vercel --prod`. In a project that depends
 * on the published package the import below becomes:
 *   import { createEdgeHandler } from 'rosefn/edge';
 */
import { createEdgeHandler } from '../src/cli/edge.ts';
import { fileURLToPath } from 'node:url';

// dist/ next to the api/ directory, whatever the working directory is.
const handle = await createEdgeHandler(fileURLToPath(new URL('../dist', import.meta.url)));

export default { fetch: handle };
