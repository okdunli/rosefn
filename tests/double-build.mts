import * as fs from 'node:fs';
import * as path from 'node:path';

// Double-build witness for the hot-rebuild intermediate skip: two buildProject
// calls in ONE process (what a dev server does on every save). Reports a comp
// intermediate's mtime after each build plus whether the server bundle is
// byte-identical, so the suite can prove unchanged files are neither rewritten
// nor served stale.
const root = process.argv[2];
if (!root) {
  console.error('usage: double-build.mts <project-dir>');
  process.exit(2);
}
const out = path.join(root, 'dist');
const { buildProject } = await import('../src/compiler/index.ts');

const buildDirs = () => {
  const base = path.join(root, '.rosespan-build');
  try {
    return fs.readdirSync(base).filter((d) => /^\d+-[0-9a-f]+$/.test(d)).map((d) => path.join(base, d));
  } catch { return []; }
};
const probe = (): number => {
  for (const dir of buildDirs()) {
    try { return fs.statSync(path.join(dir, 'comp-0.ssr.js')).mtimeMs; } catch { /* try the next dir */ }
  }
  return 0;
};

await buildProject(root, out, { minify: false });
const mtimeAfterFirst = probe();
const serverAfterFirst = fs.readFileSync(path.join(out, 'server.js'), 'utf8');
await new Promise((r) => setTimeout(r, 25));
await buildProject(root, out, { minify: false });
const mtimeAfterSecond = probe();
const serverAfterSecond = fs.readFileSync(path.join(out, 'server.js'), 'utf8');

process.stdout.write(`${JSON.stringify({
  mtimeAfterFirst,
  mtimeAfterSecond,
  serverUnchanged: serverAfterFirst === serverAfterSecond,
})}\n`);
