/**
 * Vercel function entry: the edge adapter, unchanged.
 *
 * vercel.json rewrites every unmatched path here and ships dist/ with the
 * bundle (the adapter imports dist/server.js at runtime, so the function
 * cannot start without it). The handler is createEdgeHandler's returned
 * (request) => Response, exposed behind Vercel's Web Standard signature.
 *
 * The dist path goes through fileURLToPath, NOT URL.pathname: on Windows a
 * pathname carries the drive as `/C:/...` and the leading slash makes the
 * dynamic import resolve against the drive root instead of this directory.
 */
import { fileURLToPath } from 'node:url';
import { createEdgeHandler } from '../src/cli/edge.ts';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const handle = await createEdgeHandler(dist);

export default { fetch: handle };
