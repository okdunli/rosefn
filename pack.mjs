/**
 * pack.mjs - build the PUBLISHED package: the CLI and its library entries as
 * self-contained ESM bundles, so `npm i -g rosefn` needs nothing but Node.
 *
 * Why a script and not a shell one-liner: the bin needs a shebang, and '#'
 * is a comment character in two of the three shells npm might run a script
 * through. esbuild's JS API takes it as data instead of as shell text.
 *
 * esbuild stays EXTERNAL: the compiler drives it at build time (it bundles
 * the app), and its platform binary resolves relative to its own package -
 * bundling it here would break that. It is a runtime dependency for exactly
 * this reason.
 *
 * The bundles resolve two things relative to themselves (src/runtime for the
 * app's bundles, package.json for the version banner), so src/ ships in the
 * tarball beside dist-cli/ - see "files" in package.json.
 */
import { build } from 'esbuild';
import * as fs from 'node:fs';

const OUT = 'dist-cli';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const entries = [
  // [source, output, is-the-bin]
  ['src/cli/index.ts', `${OUT}/rosefn.mjs`, true],
  ['src/cli/edge.ts', `${OUT}/edge.mjs`, false],
  ['src/runtime/index.ts', `${OUT}/runtime.mjs`, false],
  ['src/compiler/index.ts', `${OUT}/compiler.mjs`, false],
];

for (const [entry, outfile, isBin] of entries) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['esbuild'],
    banner: isBin ? { js: '#!/usr/bin/env node' } : {},
    logLevel: 'warning',
  });
  const { size } = fs.statSync(outfile);
  console.log(`packed ${outfile.padEnd(22)} ${(size / 1024).toFixed(1).padStart(6)} KB  <- ${entry}`);
}
console.log(`\n${entries.length} bundles in ${OUT}/ - the tarball also ships src/ (the runtime source the compiler feeds esbuild), deploy/, and the docs`);
