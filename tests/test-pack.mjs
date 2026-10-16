/**
 * test-pack.mjs - the PUBLISHED package, not the repo.
 *
 * `npm i -g rosespan` has to work with nothing but Node on the machine: no
 * tsx, no TypeScript, no repo. So this suite packs the real tarball, installs
 * it into a scratch project exactly as a user would, and then:
 *
 *   1. the tarball carries what it must (the five bundles, the runtime source
 *      the compiler feeds esbuild, deploy templates, LICENSE, docs) and none
 *      of what it must not (tests, the demo, dist/, node_modules).
 *   2. the bin builds a project from OUTSIDE this repo (the same gate the
 *      cli suite holds for the source tree, now through the installed bin).
 *   3. `rosespan/edge` - the import every deploy template promises - resolves
 *      from the installed package and serves the built dist through a Web
 *      Standard handler (the exact call Vercel/Cloudflare make).
 *
 * Run: npm run test:pack   (packs first, so it never tests a stale bundle)
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
};

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const shell = process.platform === 'win32';

console.log('packing...');
const bundle = spawn(npm, ['run', 'pack'], { cwd: REPO, stdio: 'inherit', shell });
assert(await new Promise((r) => bundle.on('close', (c) => r(c === 0))), 'npm run pack succeeded (the bundles are fresh)');

const pack = spawn(npm, ['pack', '--json'], { cwd: REPO, encoding: 'utf8', shell });
let packOut = '';
pack.stdout.on('data', (c) => { packOut += c; });
const packedInfo = await new Promise((resolve) => pack.on('close', (code) => {
  try { resolve(JSON.parse(packOut)[0]); } catch { resolve(null); }
}));
assert(packedInfo && packedInfo.filename, `npm pack produced a tarball (${packOut.trim().slice(0, 120)})`);
const tgz = packedInfo.filename;

const packed = packedInfo.files.map((f) => f.path);
const has = (p) => packed.includes(p);
assert(has('dist-cli/rosespan.mjs') && has('dist-cli/edge.mjs') && has('dist-cli/runtime.mjs') && has('dist-cli/compiler.mjs') && has('dist-cli/test.mjs'), 'the tarball ships all five bundles');
assert(has('src/runtime/index.ts'), 'the tarball ships the runtime source the compiler feeds esbuild');
assert(has('src/FRAMEWORK_VERSION'), 'the tarball ships the framework version stamp');
const stamp = fs.readFileSync(path.join(REPO, 'src', 'FRAMEWORK_VERSION'), 'utf8').trim();
const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
assert(stamp === pkgVersion, `the version stamp matches package.json (${stamp} vs ${pkgVersion})`);
assert(has('deploy/api/rosespan.ts') && has('deploy/vercel.json'), 'the tarball ships the deploy templates');
assert(has('deploy/netlify.toml') && has('deploy/netlify/functions/rosespan.ts'), 'the tarball ships the Netlify template');
assert(has('deploy/cloudflare/wrangler.toml') && has('deploy/cloudflare/functions/[[path]].ts'), 'the tarball ships the Cloudflare Pages template');
assert(has('LICENSE'), 'the tarball ships the license');
for (const t of ['blog', 'api', 'admin', 'site']) {
  assert(has(`templates/${t}/package.json`), `the tarball ships the ${t} template`);
}
assert(has('devtools/manifest.json') && has('devtools/devtools.html') && has('devtools/devtools.js') && has('devtools/panel.html') && has('devtools/panel.js'), 'the tarball ships the devtools extension');
const packedManifest = JSON.parse(fs.readFileSync(path.join(REPO, 'devtools', 'manifest.json'), 'utf8'));
assert(packedManifest.devtools_page === 'devtools.html' && packedManifest.manifest_version === 3, 'the devtools manifest is a valid MV3 entry');
assert(!packed.some((p) => p.startsWith('dist/') || p.startsWith('node_modules/') || p.startsWith('example/')), 'the tarball ships no demo, no build output, no deps');
assert(!packed.some((p) => p.startsWith('test-') || p === 'benchmark.ts'), 'the tarball ships no test suites');
console.log(`tarball contents: ${packed.length} files`);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rosespan-pack-'));
const project = path.join(scratch, 'my-app');
fs.mkdirSync(path.join(project, 'src', 'pages'), { recursive: true });
fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({
  name: 'my-app', private: true, type: 'module', dependencies: { rosespan: `file:${path.join(REPO, tgz)}` },
}, null, 2));
fs.writeFileSync(path.join(project, 'src', 'pages', 'index.rose'),
  '<h1>Hello from the installed package</h1>\n<p>The pack test built me.</p>\n');

const install = spawn(npm, ['install', '--no-audit', '--no-fund', '--loglevel', 'error'], { cwd: project, stdio: 'inherit', shell });
assert(await new Promise((r) => install.on('close', (c) => r(c === 0))), 'npm install of the tarball succeeded');
assert(fs.existsSync(path.join(project, 'node_modules', 'rosespan', 'dist-cli', 'rosespan.mjs')), 'the package installed its bundles');

const shebang = fs.readFileSync(path.join(project, 'node_modules', 'rosespan', 'dist-cli', 'rosespan.mjs'), 'utf8').split('\n')[0];
assert(shebang === '#!/usr/bin/env node', `the bin bundle starts with a shebang (${JSON.stringify(shebang)})`);

const bin = path.join(project, 'node_modules', '.bin', process.platform === 'win32' ? 'rosespan.cmd' : 'rosespan');
assert(fs.existsSync(bin), 'npm linked the rosespan bin');
const built = spawn(bin, ['build'], { cwd: project, stdio: 'inherit', shell });
assert(await new Promise((r) => built.on('close', (c) => r(c === 0))), 'the installed bin built the project (bare command, cwd default)');
const html = fs.readFileSync(path.join(project, 'dist', 'index.html'), 'utf8');
assert(html.includes('Hello from the installed package'), 'the built document carries the project page');
assert((html.match(/<script/g) || []).length === 0, 'the built document is zero-JS (the compiler found the runtime source from inside the package)');

const consumer = path.join(project, 'consumer.mjs');
fs.writeFileSync(consumer, `
import { createEdgeHandler } from 'rosespan/edge';
import { fileURLToPath } from 'node:url';
const handle = await createEdgeHandler(fileURLToPath(new URL('../dist', import.meta.url)));
const home = await handle(new Request('http://localhost/'));
const body = await home.text();
const missing = await handle(new Request('http://localhost/api/missing'));
const missingType = missing.headers.get('content-type') || '';
console.log(JSON.stringify({
  edgeStatus: home.status, edgeBody: body.includes('Hello from the installed package'),
  missingStatus: missing.status, missingJson: missingType.includes('application/json') && (await missing.text()).includes('not found'),
}));
`);
const ran = spawn(process.execPath, ['consumer.mjs'], { cwd: project, encoding: 'utf8' });
let out = '';
ran.stdout.on('data', (c) => { out += c; });
ran.stderr.on('data', (c) => { out += c; });
const code = await new Promise((r) => ran.on('close', r));
assert(code === 0, `the consumer ran (${out.trim().slice(-200)})`);
const r = JSON.parse(out.trim().split('\n').pop() || '{}');
assert(r.edgeStatus === 200 && r.edgeBody, 'rosespan/edge served the built document (200, the project content)');
assert(r.missingStatus === 404 && r.missingJson, 'rosespan/edge answers a JSON 404 for an unknown api path');

const tester = path.join(project, 'tester.mjs');
fs.writeFileSync(tester, `
import { test } from 'rosespan/test';
const app = await test('src/pages/index.rose');
const home = await app.get('/');
console.log(JSON.stringify({
  testStatus: home.status,
  testContent: home.html.includes('Hello from the installed package'),
  testState: home.state && typeof home.state === 'object',
}));
`);
const tested = spawn(process.execPath, ['tester.mjs'], { cwd: project, encoding: 'utf8' });
let testOut = '';
tested.stdout.on('data', (c) => { testOut += c; });
tested.stderr.on('data', (c) => { testOut += c; });
const testCode = await new Promise((r) => tested.on('close', r));
assert(testCode === 0, `the testing API ran (${testOut.trim().slice(-200)})`);
const t = JSON.parse(testOut.trim().split('\n').pop() || '{}');
assert(t.testStatus === 200 && t.testContent, 'rosespan/test compiled and rendered the project page (200, the content)');
assert(t.testState, 'rosespan/test handed back the parsed state the client resumes');

const scaffolded = spawn(bin, ['new', 'app2'], { cwd: project, stdio: 'inherit', shell });
assert(await new Promise((r) => scaffolded.on('close', (c) => r(c === 0))), 'rosespan new created a project');
const app2 = path.join(project, 'app2');
assert(fs.existsSync(path.join(app2, 'src', 'pages', 'index.rose')), 'the scaffold has a page');
const dep = JSON.parse(fs.readFileSync(path.join(app2, 'package.json'), 'utf8')).dependencies?.rosespan;
assert(dep && dep.startsWith('^'), `the scaffold depends on the rosespan package (${dep})`);
const built2 = spawn(bin, ['build'], { cwd: app2, stdio: 'inherit', shell });
assert(await new Promise((r) => built2.on('close', (c) => r(c === 0))), 'the scaffolded project builds (bare command, cwd default)');
const html2 = fs.readFileSync(path.join(app2, 'dist', 'index.html'), 'utf8');
assert(html2.includes('RoseSpan') && html2.includes('Increment'), 'the scaffolded document carries the page');
assert((html2.match(/<script/g) || []).length === 2, 'the scaffolded interactive page carries the state script and the inlined bundle');
assert(html2.includes('id="__rosespan_state"'), 'the scaffolded document carries its state');

const blocked = spawn(process.execPath, ['--input-type=module', '-e', "import 'rosespan/dist-cli/edge.mjs'"], { cwd: project, encoding: 'utf8' });
const blockedCode = await new Promise((res) => blocked.on('close', res));
assert(blockedCode !== 0, 'a deep import outside the exports map is refused (ERR_PACKAGE_PATH_NOT_EXPORTED)');

fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(path.join(REPO, tgz), { force: true });
console.log(`\nAll package checks passed - ${packed.length} files packed, installed, built, and served`);
