import fs from 'node:fs';
import path from 'node:path';

const PARALLEL = 64;
const STALE_BUILD_MS = 30 * 60 * 1000;

async function rmRetry(p: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rm(p, { force: true });
      return;
    } catch (err) {
      if (attempt >= 2 || !/EPERM|EBUSY|EACCES/.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

async function chunked(items: string[]): Promise<void> {
  for (let c = 0; c < items.length; c += PARALLEL) {
    await Promise.all(items.slice(c, c + PARALLEL).map(rmRetry));
  }
}

async function entriesOf(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function rmTreeParallel(dir: string): Promise<void> {
  const entries = await entriesOf(dir);
  const files: string[] = [];
  const dirs: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) dirs.push(path.join(dir, e.name));
    else files.push(path.join(dir, e.name));
  }
  await chunked(files);
  await Promise.all(dirs.map((d) => rmTreeParallel(d)));
  await fs.promises.rmdir(dir).catch(() => {});
}

const PRERENDERED_RE = /\.(?:html|json)(?:\.br)?$/;

// Delete prerendered files that are NOT in `keep` (their routes vanished).
// Without a keep-set this deleted everything, and the write pass immediately
// recreated it - a full unlink tax per build on files whose bytes had not
// changed. With one, a steady-state rebuild deletes nothing.
export async function prunePrerendered(dir: string, keep?: Set<string>, depth = 0): Promise<void> {
  const entries = await entriesOf(dir);
  const files: string[] = [];
  const dirs: string[] = [];
  for (const e of entries) {
    if (depth === 0 && e.name === 'locales' && e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      dirs.push(p);
      continue;
    }
    if (!PRERENDERED_RE.test(e.name)) continue;
    const base = p.endsWith('.br') ? p.slice(0, -3) : p;
    if (keep && keep.has(base)) continue;
    files.push(p);
  }
  await chunked(files);
  await Promise.all(dirs.map((d) => prunePrerendered(d, keep, depth + 1)));
}

export function sweepStaleBuildDirs(parent: string): void {
  fs.promises.readdir(parent).then((names) => {
    const now = Date.now();
    for (const n of names) {
      const p = path.join(parent, n);
      fs.promises.stat(p).then((st) => {
        if (st.isDirectory() && now - st.mtimeMs > STALE_BUILD_MS) {
          rmTreeParallel(p).catch(() => {});
        }
      }).catch(() => {});
    }
  }).catch(() => {});
}
