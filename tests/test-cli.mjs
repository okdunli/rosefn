/**
 * test-cli.mjs - the CLI builds ANY project
 *
 * The gate that makes rosefn a framework instead of a demo: `rosefn
 * build [dir]` compiles a project that is not this repository, defaults to
 * the current directory, reads that project's rosefn.config.js, and fails
 * loudly instead of silently emitting an empty dist/.
 *
 * Run: node tests/test-cli.mjs   (needs the repo's node_modules; run from the repo root)
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const REPO = process.cwd();
const TSX = [path.join(REPO, 'node_modules/tsx/dist/cli.mjs'), path.join(REPO, 'src/cli/index.ts')];

let checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) {
    console.error('FAIL: ' + msg);
    process.exit(1);
  }
  console.log('ok - ' + msg);
}

/** Run the CLI with args, in cwd; resolve with { code, out, err }. */
function run(args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [...TSX, ...args], { cwd });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'rosefn-cli-'));
const app = path.join(tmp, 'myapp');
fs.cpSync(path.join(REPO, 'example'), app, { recursive: true });
assert(fs.existsSync(path.join(app, 'rosefn.config.js')), 'the copied project carries its own rosefn.config.js');

const built = await run(['build', app], REPO);
assert(built.code === 0, `rosefn build <dir> exits 0 on a foreign project (stderr: ${built.err.slice(0, 200)})`);
const home = path.join(REPO, 'dist', 'index.html');
assert(fs.existsSync(home), 'the build wrote dist/index.html');
assert(fs.readFileSync(home, 'utf-8').includes('Guestbook'), 'the foreign project really rendered (its home page is in dist/)');

const garden = path.join(REPO, 'dist', 'garden', 'index.html');
assert(fs.existsSync(garden), 'the foreign project prerendered its content routes');
const gardenHtml = fs.readFileSync(garden, 'utf-8');
assert(gardenHtml.includes('\u{1F339}') && !gardenHtml.includes('@thorn'), 'the project\'s own rosefn.config.js plugin transformed the build');
assert(fs.readFileSync(path.join(app, 'src', 'pages', 'garden.rose'), 'utf-8').includes('@thorn'), 'the source on disk keeps its token (the transform never mutated it)');

const cwdBuilt = await run(['build'], app);
assert(cwdBuilt.code === 0, 'rosefn build with no dir exits 0');
assert(fs.existsSync(path.join(app, 'dist', 'index.html')), 'the default project dir is the cwd (dist landed inside it)');

const parentBuilt = await run(['build', app], tmp);
assert(parentBuilt.code === 0, 'rosefn build <dir> works from any cwd');
assert(fs.existsSync(path.join(tmp, 'dist', 'index.html')), 'the output lands in ./dist of the cwd, wherever the project lives');

const bare = path.join(tmp, 'bare');
fs.mkdirSync(path.join(bare, 'src', 'pages'), { recursive: true });
const failed = await run(['build', bare], REPO);
assert(failed.code !== 0, 'a project with no pages fails the build (non-zero exit)');
assert(failed.err.includes('no .rose pages found'), 'the failure says what is wrong');
assert(failed.err.includes(path.join(bare, 'src', 'pages')), 'the failure names the directory it looked in');
assert(failed.err.includes('rosefn build <dir>'), 'the failure names the fix');

const usage = await run([], REPO);
assert(usage.out.includes('[dir]') && usage.out.includes('current directory'), 'the usage line documents the dir argument and its default');

const newUsage = await run(['new'], REPO);
assert(newUsage.out.includes('rosefn new <name>'), 'rosefn new with no name prints its usage');
const scaffoldDir = path.join(tmp, 'my-app');
const scaffolded = await run(['new', scaffoldDir], REPO);
assert(scaffolded.code === 0, 'rosefn new <name> exits 0');
assert(fs.existsSync(path.join(scaffoldDir, 'src', 'pages', 'index.rose')), 'the scaffold writes src/pages/index.rose');
assert(JSON.parse(fs.readFileSync(path.join(scaffoldDir, 'package.json'), 'utf8')).dependencies.rosefn.startsWith('^'), 'the scaffold depends on the rosefn package');
const again = await run(['new', scaffoldDir], REPO);
assert(again.code !== 0 && again.err.includes('already exists'), 'rosefn new refuses to overwrite an existing directory');
const scaffoldBuilt = await run(['build'], scaffoldDir);
assert(scaffoldBuilt.code === 0, 'the scaffolded project builds from its own directory');
const scaffoldHtml = fs.readFileSync(path.join(scaffoldDir, 'dist', 'index.html'), 'utf-8');
assert(scaffoldHtml.includes('Increment'), 'the scaffolded document carries its page');
assert((scaffoldHtml.match(/<script/g) || []).length === 2, 'the scaffolded page ships the state script and the inlined bundle (its click handler needs the client)');
assert(fs.existsSync(path.join(scaffoldDir, 'rosefn-env.d.ts')), 'the scaffold carries the env reference');
assert(fs.readFileSync(path.join(scaffoldDir, 'rosefn-env.d.ts'), 'utf8').includes('reference types="rosefn"'), 'the env reference points at the package');
const tsconfig = JSON.parse(fs.readFileSync(path.join(scaffoldDir, 'tsconfig.json'), 'utf8'));
assert(tsconfig.compilerOptions?.strict === true, 'the scaffold tsconfig is strict');
assert((tsconfig.include ?? []).includes('rosefn-env.d.ts'), 'the tsconfig includes the env reference (so tsc sees the globals)');
const scaffoldPkg = JSON.parse(fs.readFileSync(path.join(scaffoldDir, 'package.json'), 'utf8'));
assert(scaffoldPkg.scripts.check === 'rosefn check', 'the scaffold has a check script');
assert(scaffoldPkg.devDependencies?.typescript, 'the scaffold depends on typescript (check needs the project\'s own copy)');

const relBuilt = await run(['build', 'example'], REPO);
assert(relBuilt.code === 0, `a relative dir argument builds the repo demo (stderr: ${relBuilt.err.slice(0, 300)})`);

const tsDir = path.join(REPO, '.tmp-ts-check');
fs.rmSync(tsDir, { recursive: true, force: true });
const tsPage = path.join(tsDir, 'src', 'pages', 'index.rose');
fs.mkdirSync(path.dirname(tsPage), { recursive: true });
const writeTyped = (bad) => fs.writeFileSync(tsPage, `<script>
  interface Post { id: number; title: string }

  let count = $state(0);
  let posts = $state<Post[]>([{ id: 1, title: 'typed' }, { id: 2, title: 'generics' }]);
  let first = $data(async (): Promise<Post> => JSON.parse('{"id":3,"title":"cast"}') as Post);
  let broken: number = ${bad ? "'oops'" : '0'};

  function bump(): void { $setState('count', count() + 1); }
</script>

<h1>{count()} {first().title} {broken}</h1>
<ul>{#each posts() as p}<li>{p.id}: {p.title}</li>{/each}</ul>
`);
try {
  writeTyped(false);
  const tsBuilt = await run(['build'], tsDir);
  assert(tsBuilt.code === 0, `a typed .rose script builds - interface, generics, cast and all (stderr: ${tsBuilt.err.slice(0, 300)})`);
  const tsHtml = fs.readFileSync(path.join(tsDir, 'dist', 'index.html'), 'utf8');
  assert(tsHtml.includes('typed') && tsHtml.includes('generics') && tsHtml.includes('cast'), 'the typed page renders every value');
  const tsClient = fs.readFileSync(path.join(tsDir, 'dist', 'client.js'), 'utf8');
  for (const syntax of ['interface Post', 'Promise<Post>', ' as Post', ': number']) {
    assert(!tsClient.includes(syntax), `the client bundle carries no \`${syntax}\` - the types were erased`);
  }
  const tsChecked = await run(['check'], tsDir);
  assert(tsChecked.code === 0, `rosefn check passes on a typed project (stderr: ${tsChecked.err.slice(0, 300)})`);
  assert(tsChecked.out.includes('no errors'), 'the check says so out loud');
  writeTyped(true);
  const stillBuilds = await run(['build'], tsDir);
  assert(stillBuilds.code === 0, 'the build still succeeds with a wrong type - esbuild strips types, it does not check them');
  const tsBad = await run(['check'], tsDir);
  assert(tsBad.code !== 0, 'rosefn check fails on a type error');
  const badNamesLine = tsBad.err.includes('index.rose(7,');
  if (!badNamesLine) console.error(tsBad.err);
  assert(badNamesLine, 'the error names the file and the exact .rose line');
  assert(tsBad.err.includes('TS2322'), 'the error is the real TypeScript diagnostic');
  assert(/type error/.test(tsBad.err), 'the summary counts the errors');
  writeTyped(false);
  fs.mkdirSync(path.join(tsDir, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(tsDir, 'src', 'components', 'Greet.rose'), `<script>
  export let name = 'world';
</script>

<p>hello {name}</p>
`);
  const writeComps = (bad) => fs.writeFileSync(path.join(tsDir, 'src', 'pages', 'comps.rose'), `<script>
  import Greet from '../components/Greet.rose';

  let who = $state('rose');
  Greet([], '', { name: ${bad ? '42' : 'who()'} });
</script>

<h1>comps</h1>
`);
  writeComps(false);
  const compsChecked = await run(['check'], tsDir);
  assert(compsChecked.code === 0, `rosefn check passes with an imported .rose component (stderr: ${compsChecked.err.slice(0, 300)})`);
  writeComps(true);
  const compsBad = await run(['check'], tsDir);
  assert(compsBad.code !== 0, 'a wrong prop type through a component import is a type error');
  const compsNamed = compsBad.err.includes('comps.rose(') && /TS2322|TS2345/.test(compsBad.err);
  if (!compsNamed) console.error(compsBad.err);
  assert(compsNamed, 'the error names the file and the real diagnostic');
  assert(compsBad.err.includes("is not assignable to type 'string'"), 'the synthesized declaration types the prop from the component\'s own export let');
  fs.rmSync(path.join(tsDir, 'src', 'pages', 'comps.rose'));
  const noTsDir = path.join(tmp, 'no-ts');
  fs.mkdirSync(path.join(noTsDir, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(noTsDir, 'src', 'pages', 'index.rose'), '<h1>no typescript here</h1>\n');
  let tsResolvable = true;
  try { createRequire(path.join(noTsDir, 'package.json')).resolve('typescript'); } catch { tsResolvable = false; }
  if (tsResolvable) {
    console.log('note: typescript resolves from the TEMP fixture - the no-typescript path is skipped');
  } else {
    const noTs = await run(['check'], noTsDir);
    assert(noTs.code !== 0 && noTs.err.includes('npm i -D typescript'), 'a project without typescript gets the fix, not silence');
  }
} finally {
  fs.rmSync(tsDir, { recursive: true, force: true });
}

const takePort = async (fixed) => {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const srv = createServer();
    const on = () => { const p = srv.address().port; srv.close(() => resolve(p)); };
    if (fixed) { srv.once('error', () => resolve(null)); srv.listen(fixed, on); } else srv.listen(0, on);
  });
};

const hooksDir = path.join(tmp, 'hooked');
fs.mkdirSync(path.join(hooksDir, 'src', 'pages', 'api'), { recursive: true });
fs.writeFileSync(path.join(hooksDir, 'rosefn.config.js'), `
export default [
  {
    name: 'guard',
    onRequest(ctx) {
      if (ctx.pathname === '/blocked') {
        return new Response('blocked by the guard plugin', { status: 418, headers: { 'content-type': 'text/plain' } });
      }
      ctx.state.hits = (ctx.state.hits || 0) + 1;
    },
    onResponse(ctx, res) {
      const headers = new Headers(res.headers);
      headers.set('x-plugin-hits', String(ctx.state.hits ?? 0));
      return new Response(res.body, { status: res.status, headers });
    },
    onServe(meta) {
      console.log('guard onServe port=' + meta.port + ' workers=' + meta.workers);
    },
    onShutdown() {
      console.log('guard onShutdown');
    },
  },
];
`);
fs.writeFileSync(path.join(hooksDir, 'src', 'pages', 'index.rose'), `<script>\n  let n = $state(1);\n</script>\n\n<h1>hooked {n()}</h1>\n`);
fs.writeFileSync(path.join(hooksDir, 'src', 'pages', 'store.rose'), `<script>\n  const box = $store('hits', 0);\n</script>\n\n<h1>store {box.get()}</h1>\n`);
fs.writeFileSync(path.join(hooksDir, 'src', 'pages', 'api', 'ping.rose'), `<script>\n  export async function GET() {\n    return { pong: true };\n  }\n</script>\n`);
const hookedBuilt = await run(['build'], hooksDir);
assert(hookedBuilt.code === 0, `a project with runtime hooks builds (stderr: ${hookedBuilt.err.slice(0, 200)})`);
const hookedServer = fs.readFileSync(path.join(hooksDir, 'dist', 'server.js'), 'utf8');
assert(hookedServer.includes('blocked by the guard plugin'), 'the runtime hooks are bundled into dist/server.js (the config itself is never deployed)');
assert(hookedServer.includes('runRequestHooks') && hookedServer.includes('runResponseHooks'), 'the generated server exports the hook runners');
const hookPort = await takePort(0);
const prev = spawn(process.execPath, [...TSX, 'preview'], {
  cwd: hooksDir,
  env: { ...process.env, PORT: String(hookPort) },
});
let prevOut = '';
prev.stdout.on('data', (c) => { prevOut += c; });
prev.stderr.on('data', (c) => { prevOut += c; });
const hookBase = `http://localhost:${hookPort}`;
try {
  for (let i = 0; i < 100; i++) {
    try { await fetch(hookBase + '/'); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  const hooked = await fetch(hookBase + '/');
  assert(hooked.status === 200 && hooked.headers.get('x-plugin-hits') === '1', 'onResponse runs on the prerendered-file path (a header plugin sees EVERY response)');
  const blocked = await fetch(hookBase + '/blocked');
  assert(blocked.status === 418, 'onRequest short-circuits the request with its own Response (418)');
  assert((await blocked.text()).includes('blocked by the guard plugin'), 'the short-circuit body is the hook\'s own');
  assert(blocked.headers.get('x-plugin-hits') === '0', 'the short-circuit rides through onResponse (its context state is visible there)');
  const ping = await fetch(hookBase + '/api/ping');
  assert(ping.status === 200 && (await ping.text()).includes('pong'), 'the API route still answers under a hook');
  assert(ping.headers.get('x-plugin-hits') === '1', 'onResponse runs on API responses');
  const stored = await fetch(hookBase + '/store');
  assert(stored.status === 200 && stored.headers.get('x-plugin-hits') === '1', 'onResponse runs on the streamed path (status + headers, before the first flush)');
  const missing = await fetch(hookBase + '/nope');
  assert(missing.status === 404 && missing.headers.get('x-plugin-hits') === '1', 'onResponse runs on the buffered 404 render');
} finally {
  prev.kill();
}
const hookServePort = await takePort(0);
const srv2 = spawn(process.execPath, [...TSX, 'serve'], {
  cwd: hooksDir,
  env: { ...process.env, PORT: String(hookServePort), ROSEFN_WORKERS: '1' },
});
let hookServeOut = '';
srv2.stdout.on('data', (c) => { hookServeOut += c; });
srv2.stderr.on('data', (c) => { hookServeOut += c; });
try {
  for (let i = 0; i < 100 && !hookServeOut.includes('onServe'); i++) {
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(hookServeOut.includes(`guard onServe port=${hookServePort} workers=1`), 'onServe runs in the worker with the port and the worker count');
  const served2 = await fetch(`http://localhost:${hookServePort}/`);
  assert(served2.status === 200 && served2.headers.get('x-plugin-hits') === '1', 'the served document carries the hook header too');
} finally {
  srv2.kill();
}
const tOnly = path.join(tmp, 'transform-only');
fs.mkdirSync(path.join(tOnly, 'src', 'pages'), { recursive: true });
fs.writeFileSync(path.join(tOnly, 'rosefn.config.js'), `export default [{ name: 'marker-transform-only', transform(code) { return code; } }];\n`);
fs.writeFileSync(path.join(tOnly, 'src', 'pages', 'index.rose'), `<script>\n  let n = $state(1);\n</script>\n\n<h1>plain {n()}</h1>\n`);
const tBuilt = await run(['build'], tOnly);
assert(tBuilt.code === 0, 'a transform-only project builds');
const tServer = fs.readFileSync(path.join(tOnly, 'dist', 'server.js'), 'utf8');
assert(!tServer.includes('marker-transform-only'), 'a transform-only config is NOT bundled into the server (no runtime hook, no config import)');
assert(tServer.includes('runRequestHooks'), 'the no-op runners are still exported, so the servers call them unconditionally');

const compsDir = path.join(tmp, 'comps');
fs.mkdirSync(path.join(compsDir, 'src', 'components', 'ui'), { recursive: true });
fs.mkdirSync(path.join(compsDir, 'src', 'pages'), { recursive: true });
fs.writeFileSync(path.join(compsDir, 'src', 'components', 'ui', 'Card.rose'), `<script>
  export let title = 'untitled';
  export let tone = 'calm';
  export let onLike = null;
  let likes = $state(0);
  function like() {
    $setState('likes', likes() + 1);
    if (onLike) onLike(likes());
  }
</script>

<style>
  .card { border: 1px solid #ccc; padding: 0.5rem; }
  .card h3 { margin: 0 0 0.25rem; }
</style>

<div class="card">
  <h3>{title}</h3>
  <p>tone: {tone} - likes {likes()}</p>
  <button on:click={like}>like</button>
  <slot />
  <footer><slot name="foot" note={tone} /></footer>
</div>
`);
fs.writeFileSync(path.join(compsDir, 'src', 'components', 'Badge.rose'), `<script>
  export let label = 'badge';
</script>

<span class="badge">{label}</span>
`);
fs.writeFileSync(path.join(compsDir, 'src', 'components', 'Unused.rose'), `<style>.unused { color: red; }</style>\n<div class="unused">never imported</div>\n`);
fs.writeFileSync(path.join(compsDir, 'src', 'pages', 'index.rose'), `<script>
  import Card from '../components/ui/Card.rose';
  import Badge from '../components/Badge.rose';

  let liked = $state('nobody yet');
  function onLike(n) {
    $setState('liked', 'liked ' + n + ' times');
  }
</script>

<h1>components</h1>
<Card title="hello" tone="many" onLike={onLike}>
  <Badge label="inside the default slot" />
  <p>{liked}</p>
  <strong slot="foot">the foot sees note: {note}</strong>
</Card>
`);
fs.writeFileSync(path.join(compsDir, 'src', 'pages', 'list.rose'), `<script>
  import Card from '../components/ui/Card.rose';

  let rows = $data(async () => [{ id: 1, t: 'one' }, { id: 2, t: 'two' }]);
</script>

<h1>a list of cards</h1>
{#each rows() as row}
  <Card title={row.t}>
    <p>row {row.id}</p>
  </Card>
{/each}
`);
const compsBuilt = await run(['build'], compsDir);
assert(compsBuilt.code === 0, `a project with imported components builds (stderr: ${compsBuilt.err.slice(0, 300)})`);
const compsHome = fs.readFileSync(path.join(compsDir, 'dist', 'index.html'), 'utf8');
const compsStyles = fs.readFileSync(path.join(compsDir, 'dist', 'styles.css'), 'utf8');
const compsServer = fs.readFileSync(path.join(compsDir, 'dist', 'server.js'), 'utf8');
assert(compsHome.includes('<h3><!--') && compsHome.includes('hello</h3>'), 'a passed prop renders inside the component');
assert(/tone: <!--[^>]*-->many/.test(compsHome), 'an expression prop is evaluated in the PARENT scope and passed down');
assert(compsHome.includes('calm'), 'the component\'s own default applies when the prop is omitted');
assert(compsHome.includes('<span class="badge">') && compsHome.includes('inside the default slot'), 'a component nested in the default slot renders (the import graph is followed transitively)');
assert(compsHome.includes('the foot sees note: ') && /the foot sees note: <!--[^>]*-->many/.test(compsHome), 'a named slot receives the child\'s scoped prop (note = tone)');
assert(compsHome.includes('nobody yet'), 'a bare state read in the template auto-calls ({liked}, not {liked()})');
assert(/likes <!--[^>]*-->0/.test(compsHome), 'component state is namespaced per component (two Cards do not share one signal)');
assert(compsHome.includes('data-on-click="like"'), 'the component\'s own on:click handler is wired like any other');
assert(compsStyles.includes('[data-rosefn-c="components/ui/Card"] .card'), 'the component\'s styles are scoped by its own file path');
assert(!compsStyles.includes('.unused'), 'an unimported component\'s styles never reach the stylesheet');
assert(!compsServer.includes('never imported'), 'an unimported component is in neither bundle');
assert(!fs.existsSync(path.join(compsDir, 'dist', 'components')), 'a component is not a route (no dist/components/)');
assert(compsBuilt.out.includes('/  client JS') && compsBuilt.out.includes('imported component Card.rose needs the client'), 'needsClient propagates up the import graph and the report names the component');
assert(compsHome.includes('__rosefn_state'), 'the page that renders an interactive component ships the bundle');
const compsList = fs.readFileSync(path.join(compsDir, 'dist', 'list', 'index.html'), 'utf8')
  .replace(/<script[\s\S]*?<\/script>/g, '');
assert((compsList.match(/class="card"/g) ?? []).length === 2, 'a component inside {#each} renders once per row');
assert(compsList.includes('one') && compsList.includes('two'), 'each row passes its own prop value');
assert(/row <!--[^>]*-->1/.test(compsList) && /row <!--[^>]*-->2/.test(compsList), 'the loop item resolves in the slot content and stays out of the prose');
assert(!compsHome.includes('[object Promise]'), 'a component renders synchronously inside its parent (no Promise in the document)');

const badBase = path.join(tmp, 'badcomps');
const badCase = async (name, files, needle) => {
  const dir = path.join(badBase, name);
  fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const r = await run(['build'], dir);
  assert(r.code !== 0 && r.err.includes(needle), `${name}: ${needle}`);
};
await badCase('data-in-component', {
  'src/components/Widget.rose': `<script>\n  let v = $data(async () => 1);\n</script>\n<div>{v()}</div>\n`,
  'src/pages/index.rose': `<script>\n  import Widget from '../components/Widget.rose';\n</script>\n<Widget />\n`,
}, '$data() is not allowed in a component');
await badCase('missing-import', {
  'src/pages/index.rose': `<script>\n  import Ghost from '../components/Ghost.rose';\n</script>\n<Ghost />\n`,
}, "cannot import '../components/Ghost.rose'");
await badCase('unclosed-tag', {
  'src/components/Widget.rose': `<script>\n  export let label = 'w';\n</script>\n<span>{label}</span>\n`,
  'src/pages/index.rose': `<script>\n  import Widget from '../components/Widget.rose';\n</script>\n<Widget label="x">\n`,
}, 'unclosed <Widget>');
await badCase('nested-slot-attr', {
  'src/components/Widget.rose': `<script>\n  export let label = 'w';\n</script>\n<div><slot /></div>\n`,
  'src/pages/index.rose': `<script>\n  import Widget from '../components/Widget.rose';\n</script>\n<Widget><span slot="cell"><b slot="cell">x</b></span></Widget>\n`,
}, 'slot=');

const actDir = path.join(tmp, 'actions');
fs.mkdirSync(path.join(actDir, 'src', 'pages'), { recursive: true });
fs.writeFileSync(path.join(actDir, 'src', 'pages', 'index.rose'), `<script>
  export async function beforeAction(name, form) {
    if (name === 'sign' && !String(form.get('name') ?? '').trim()) {
      throw new ActionError('A signature needs a name.', 422, 'name');
    }
  }

  export async function sign(form) {
    const name = String(form.get('name') ?? '').trim();
    return { guests: $prepend(name), meta: $merge({ last: name }) };
  }

  let guests = $state(['seed']);
  let meta = $state({ hits: 0 });
</script>

<h1>actions</h1>
{#boundary}
  <form method="POST">
    <input name="name" aria-label="name">
    <button type="submit">sign</button>
  </form>
{/boundary}
<p>last: {meta().last ?? 'none'}</p>
<ul>
  {#each guests() as g}<li>{g}</li>{/each}
</ul>
`);
const actBuilt = await run(['build'], actDir);
assert(actBuilt.code === 0, `a project using the action model builds (stderr: ${actBuilt.err.slice(0, 300)})`);
const actServer = await import(pathToFileURL(path.join(actDir, 'dist', 'server.js')).href);
const post = (name, fields) => {
  const form = new FormData();
  form.append('__action', name);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return actServer.renderPage('/', form);
};
const veto = await post('sign', { name: '   ' });
assert(veto.status === 422, `a guard veto answers 422, not a 500 (got ${veto.status})`);
assert(JSON.parse(veto.state).actionError?.field === 'name', 'the failure names the offending field for the form UI');
assert(veto.html.includes('A signature needs a name.'), 'the page renders with the failure message in it');
assert(!veto.html.includes('<form'), 'the boundary around the action contains the failure instead of rendering the form');
const signed = await post('sign', { name: 'Ada' });
assert(signed.status === 200, 'a successful action answers 200');
const signedLis = [...signed.html.matchAll(/<li><!--[^>]*-->([^<]*)</g)].map((m) => m[1]);
assert(signedLis.join(',') === 'Ada,seed', `the prepend patch applies exactly once, to the declared state (${signedLis.join(',')})`);
assert(/last: <!--[^>]*-->Ada/.test(signed.html), 'the merge patch fills the key the action set and keeps the rest');
assert(signed.html.includes('<form'), 'the boundary renders the form when the action succeeded');
const plain = await actServer.renderPage('/');
assert(plain.status === 200 && !plain.html.includes('Ada'), 'a plain GET re-renders from scratch: no stale delta survives the request');
assert(/last: <!--[^>]*-->none/.test(plain.html), 'the merged key is gone on the next request too');

const bugDir = path.join(tmp, 'bugfix');
fs.mkdirSync(path.join(bugDir, 'src', 'pages', 'api'), { recursive: true });
fs.writeFileSync(path.join(bugDir, 'src', 'pages', 'index.rose'), `<script>
  // P0-1: the query is read through $query(); routing itself matches the
  // pathname. P1-2: {@html} is trusted markup. The title below carries a
  // template literal INSIDE the expression - the case the old flat regex
  
  let q = $state($query().q ?? '');
  let hits = $data(async () => {
    const rows = [{ title: 'alpha', body: 'one <strong>bold</strong> word' }, { title: 'beta', body: 'two <em>tilted</em> words' }];
    const t = q().toLowerCase();
    return t ? rows.filter((r) => r.title.includes(t)) : rows;
  });
</script>

<head>
  <title>{q() ? \`term: \${q()}\` : 'all terms'} - rosefn</title>
  <!-- A head-level <style> and a JSON-LD data block (bug report 2026.9.22
       11:46): a CMS theme system ships its per-request CSS and its structured
       data in <head>. Both used to be dropped by the server's head merge and
       by the client's applyHead. -->
  <style>.hit { color: #2e7d32; }</style>
  <script type="application/ld+json">{"@type":"SearchResultsPage"}</script>
</head>

<h1>term: {q() || 'none'}</h1>
<p>{@html hits()[0]?.body ?? ''}</p>
<ul>{#each hits() as h}<li>{@html h.body}</li>{/each}</ul>
<form method="GET" action="/">
  <input name="q" aria-label="q" value={q()}>
  <button type="submit">go</button>
</form>
`);
fs.writeFileSync(path.join(bugDir, 'src', 'pages', 'native.rose'), `<script>
  export async function action(form) {
    const name = String(form.get('name') ?? '').trim();
    if (!name) throw new ActionError('A name is needed.', 422, 'name');
    $setState('signed', [...(hasState('signed') ? signed() : []), name]);
  }
  let signed = $state([]);
</script>

{#if $actionError()}<p><strong>{$actionError().message}</strong></p>{/if}
<form method="POST">
  <input name="name" aria-label="name">
  <button type="submit">Sign</button>
</form>
<ul>{#each signed() as s}<li>{s}</li>{/each}</ul>
`);
fs.writeFileSync(path.join(bugDir, 'src', 'pages', 'buffered.rose'), `<script>
  export const buffer = true;
  let slow = $data(async () => 'buffered body');
</script>

<h1>buffered</h1><p>{slow()}</p>
`);
fs.writeFileSync(path.join(bugDir, 'src', 'pages', 'api', 'echo.rose'), `<script>
  export function GET(request) {
    return { said: new URL(request.url).searchParams.get('say') ?? '', viaQuery: $query().say ?? '' };
  }
</script>
`);
const bugBuilt = await run(['build'], bugDir);
assert(bugBuilt.code === 0, `the bug-report fixture builds (stderr: ${bugBuilt.err.slice(0, 300)})`);
const bugServer = await import(pathToFileURL(path.join(bugDir, 'dist', 'server.js')).href);
const text = (h) => h.replace(/<!--\u27e6[^>]*?\u27e7-->/g, '');

bugServer.setQuery({ q: 'alpha' });
const q1 = await bugServer.renderPage('/');
assert(q1.status === 200, 'a route rendered with a query answers 200');
assert(text(q1.html).includes('term: alpha'), '$query() reaches the render');
assert(q1.html.includes('<strong>bold</strong>'), '{@html} emits trusted markup verbatim');
assert(!q1.html.includes('&lt;strong&gt;'), '{@html} does not escape');
assert(text(q1.html).includes('<li>one <strong>bold</strong> word</li>'), '{@html} resolves inside an {#each} against the row');
assert((q1.head ?? []).join('').includes('<title>term: alpha - rosefn</title>'), 'a template literal inside a template expression compiles (it used to emit `term: $alpha`)');
assert((q1.head ?? []).join('').includes('<style>.hit { color: #2e7d32; }</style>'), 'a head-level <style> reaches the rendered document (the merge used to drop it)');
assert((q1.head ?? []).join('').includes('application/ld+json'), 'a JSON-LD data block reaches the rendered document');
assert(!(q1.head ?? []).join('').includes('<!--'), 'head comments are notes, not content (they are dropped at compile time)');
bugServer.setQuery({});
const q0 = await bugServer.renderPage('/');
assert(text(q0.html).includes('term: none'), 'a render with no query sees an empty one');
bugServer.setQuery({ say: 'hi' });
const echo = await bugServer.handleApi('GET', '/api/echo', new Request('http://localhost/api/echo?say=hi'));
const echoJson = await echo.json();
assert(echo.status === 200 && echoJson.said === 'hi' && echoJson.viaQuery === 'hi', 'an api handler reads the query from its Request and through $query()');
assert(bugServer.isBuffered('/buffered') === true, 'isBuffered() is true for a buffer = true route');
assert(bugServer.isBuffered('/') === false, 'isBuffered() is false for a normal route');
assert((bugServer.dynamicRoutes ?? []).includes('/buffered'), 'a buffer = true route is never prerendered (it must render per request to be buffered)');
const nativeBaked = fs.readFileSync(path.join(bugDir, 'dist', 'native', 'index.html'), 'utf8');
assert((nativeBaked.match(/<script/g) ?? []).length === 0, 'a pure native form page bakes with zero script tags');
assert(!nativeBaked.includes('id="app"'), 'the zero-JS document carries no #app wrapper');
assert(!nativeBaked.includes('font-family'), 'the zero-JS document carries no demo stylesheet');
const formOf = (name) => {
  const f = new FormData();
  f.append('__action', 'action');
  if (name !== null) f.append('name', name);
  return f;
};
const adopted = await bugServer.renderPage('/native', formOf('ada'));
assert(adopted.status === 200 && text(adopted.html).includes('<li>ada</li>'), "an action's $setState seeds the state the re-render adopts");
const vetoed = await bugServer.renderPage('/native', formOf(''));
assert(vetoed.status === 422, 'a business failure answers 422 without JS');
assert(text(vetoed.html).includes('A name is needed.'), 'the failure is visible in the page');

const { createServer } = await import('node:net');
const occupied = await takePort(0);
const squatter = createServer(() => {});
await new Promise((r) => squatter.listen(occupied, r));
const hopDir = path.join(tmp, 'hop');
fs.cpSync(path.join(REPO, 'example'), hopDir, { recursive: true });
try {
  const hop = spawn(process.execPath, [...TSX, 'preview'], {
    cwd: hopDir,
    env: { ...process.env, PORT: String(occupied) },
  });
  let hopOut = '';
  hop.stdout.on('data', (c) => { hopOut += c; });
  hop.stderr.on('data', (c) => { hopOut += c; });
  try {
    let answered = null;
    for (let i = 0; i < 120; i++) {
      for (const p of [occupied + 1, occupied + 2]) {
        try {
          const r = await fetch(`http://localhost:${p}/`);
          if (r.status === 200) { answered = p; break; }
        } catch {  }
      }
      if (answered) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert(answered !== null, `a preview whose port is taken hops to the next free one and serves (squatter still owns ${occupied})`);
    assert(hopOut.includes(String(answered)), `the banner names the port it actually bound (${answered})`);
    assert((await fetch(`http://localhost:${answered}/`)).status === 200);
  } finally {
    hop.kill('SIGKILL');
  }
} finally {
  squatter.close();
  try {
    fs.rmSync(hopDir, { recursive: true, force: true });
  } catch {  }
}

await badCase('node-import-in-page', {
  'src/pages/index.rose': `<script>\n  import { readFileSync } from 'node:fs';\n  let body = $state('x');\n</script>\n<p>{body}</p>\n`,
}, "cannot import 'node:fs' in a page or component");
await badCase('driver-import-in-component', {
  'src/components/Widget.rose': `<script>\n  import Database from 'better-sqlite3';\n  export let label = 'w';\n</script>\n<span>{label}</span>\n`,
  'src/pages/index.rose': `<script>\n  import Widget from '../components/Widget.rose';\n</script>\n<Widget />\n`,
}, "cannot import 'better-sqlite3' in a page or component");
const nodeMsg = await (async () => {
  const dir = path.join(badBase, 'node-msg');
  fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'pages', 'index.rose'), `<script>\n  import pg from 'pg';\n</script>\n<p>x</p>\n`);
  return (await run(['build'], dir)).err;
})();
assert(nodeMsg.includes('src/pages/_middleware.rose') && nodeMsg.includes('pages/api/*.rose'), 'the failure names where the import belongs instead');
assert(nodeMsg.includes('index.rose'), 'the failure names the offending file');
const okDir = path.join(tmp, 'npmok');
fs.mkdirSync(path.join(okDir, 'src', 'pages', 'api'), { recursive: true });
fs.writeFileSync(path.join(okDir, 'src', 'pages', '_middleware.rose'), `<script>\n  import { readFileSync } from 'node:fs';\n  export async function handle(request) { getContext().build = typeof readFileSync === 'function'; }\n</script>\n`);
fs.writeFileSync(path.join(okDir, 'src', 'pages', 'index.rose'), `<script>\n  import type { Stats } from 'node:fs';\n  import { sparkle } from 'sparkle-fx';\n  let label = $state('typed import');\n  let s: Stats | null = null;\n  let fx = sparkle(3);\n</script>\n<p>{label} {fx}</p>\n`);
fs.writeFileSync(path.join(okDir, 'src', 'pages', 'api', 'stats.rose'), `<script>\n  import { readFileSync } from 'node:fs';\n  export function GET() { return { ok: typeof readFileSync === 'function' };\n}\n</script>\n`);
const pkgDir = path.join(okDir, 'node_modules', 'sparkle-fx');
fs.mkdirSync(pkgDir, { recursive: true });
fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'sparkle-fx', version: '1.0.0', type: 'module', main: 'index.mjs' }));
fs.writeFileSync(path.join(pkgDir, 'index.mjs'), `export function sparkle(n) { return 'x'.repeat(n); }\n`);
const okBuilt = await run(['build'], okDir);
assert(okBuilt.code === 0, `a page may import a browser-safe npm package (stderr: ${okBuilt.err.slice(0, 300)})`);
const okHome = fs.readFileSync(path.join(okDir, 'dist', 'index.html'), 'utf-8');
assert(text(okHome).includes('typed import xxx'), 'the npm package ships inside the single document, like every other dependency');
assert((okHome.match(/<script/g) ?? []).length === 0, 'an npm import does not by itself put the bundle in the document (the compiler still decides zero-JS)');

const servePort = await takePort(0);
const srv = spawn(process.execPath, [...TSX, 'serve'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(servePort), ROSEFN_WORKERS: '2', ROSEFN_MAX_BODY: '200' },
});
let serveOut = '';
srv.stdout.on('data', (c) => { serveOut += c; });
srv.stderr.on('data', (c) => { serveOut += c; });
const serveBase = `http://localhost:${servePort}`;
try {
  for (let i = 0; i < 100; i++) {
    try { await fetch(serveBase + '/'); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  const served = await fetch(serveBase + '/');
  assert(served.status === 200, 'rosefn serve answers the built home page');
  assert((await served.text()).includes('Guestbook'), 'the served document is the built one (serve never rebuilds on the fly)');
  assert(serveOut.includes('2 workers'), 'the banner names the worker count');
  await new Promise((r) => setTimeout(r, 250));
  const getLines = serveOut.split('\n').filter((l) => l.includes(' GET / 200 '));
  assert(getLines.length > 0, 'every request writes an access line');
  const last = getLines[getLines.length - 1];
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \[w\d+\] GET \/ 200 \d+B [\d.]+(ms|us)$/.test(last), `the access line is greppable and worker-tagged: ${last}`);
  const http = await import('node:http');
  const get = (url) => new Promise((resolve, reject) => {
    http.get(url, { agent: new http.Agent({ keepAlive: false }) }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
  const listening = serveOut.match(/worker (\d+) listening/g) ?? [];
  assert(listening.length === 2, `two worker processes are listening (${listening.length})`);
  const pids = () => new Set([...serveOut.matchAll(/\[w(\d+)\]/g)].map((m) => m[1]));
  for (let i = 0; i < 200 && pids().size < 2; i++) {
    await get(serveBase + '/');
    if (i % 20 === 19) await new Promise((r) => setTimeout(r, 200));
  }
  assert(pids().size === 2, `both workers answered traffic (distinct pids: ${[...pids()].join(', ')})`);
  const http2 = await import('node:http');
  const pin = () => new http2.Agent({ keepAlive: true, maxSockets: 1 });
  const req = (agent, url, init = {}) => new Promise((resolve, reject) => {
    const r = http2.request(url, { agent, ...init }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    if (init.body) r.write(init.body);
    r.end();
  });
  const signLines = () => serveOut.split('\n').filter((l) => l.includes('GET /sign 200'));
  const waitForSignPid = async (before) => {
    for (let i = 0; i < 100; i++) {
      const lines = signLines();
      if (lines.length > before) return lines[lines.length - 1].match(/\[w(\d+)\]/)?.[1] ?? null;
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  };
  let agentA = pin();
  let agentB = pin();
  let pidA = null;
  let pidB = null;
  for (let i = 0; i < 50 && (!pidA || !pidB || pidA === pidB); i++) {
    agentA.destroy();
    agentB.destroy();
    agentA = pin();
    agentB = pin();
    const beforeA = signLines().length;
    await req(agentA, serveBase + '/sign');
    pidA = await waitForSignPid(beforeA);
    const beforeB = signLines().length;
    await req(agentB, serveBase + '/sign');
    pidB = await waitForSignPid(beforeB);
  }
  assert(!!pidA && !!pidB && pidA !== pidB, `two pinned sockets ride two different workers (${pidA}, ${pidB})`);
  const posted = await req(agentA, serveBase + '/sign', {
    method: 'POST',
    body: new URLSearchParams({ name: 'Cross Worker' }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert(posted.status === 200 && posted.body.includes('Cross Worker'), 'the action response on worker A carries the new signature');
  let crossed = false;
  for (let i = 0; i < 40 && !crossed; i++) {
    const r = await req(agentB, serveBase + '/sign');
    if (r.body.includes('Cross Worker')) crossed = true;
    else await new Promise((res) => setTimeout(res, 50));
  }
  assert(crossed, 'the signature crossed workers: worker B renders what worker A wrote ($store broadcast through the primary)');
  agentA.destroy();
  agentB.destroy();
  const big = await fetch(serveBase + '/api/hello', { method: 'POST', body: 'x'.repeat(400) });
  assert(big.status === 413, `an oversized body is refused with 413 (got ${big.status})`);
  const small = await fetch(serveBase + '/api/hello', {
    method: 'POST',
    body: new URLSearchParams({ name: 'x'.repeat(30) }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert(small.status === 200, 'a body under the limit still runs');
} finally {
  srv.kill();
}
let bindable = false;
for (let i = 0; i < 20 && !bindable; i++) {
  bindable = (await takePort(servePort)) !== null;
  if (!bindable) await new Promise((r) => setTimeout(r, 250));
}
assert(bindable, 'no orphan worker holds the port after the primary dies');

const vercel = JSON.parse(fs.readFileSync(path.join(REPO, 'deploy/vercel.json'), 'utf8'));
assert(vercel.outputDirectory === 'dist', 'vercel.json builds into dist/');
assert(vercel.buildCommand === 'npm run build', 'vercel.json builds the app the documented way');
assert(Array.isArray(vercel.rewrites) && vercel.rewrites.some((r) => r.destination === '/api/rosefn'), 'every unmatched path is rewritten to the function');
assert(vercel.functions?.['api/rosefn.ts']?.includeFiles === 'dist/**', 'the function bundle carries dist/ (its server.js is imported at runtime)');
const fn = fs.readFileSync(path.join(REPO, 'deploy/api/rosefn.ts'), 'utf8');
assert(fn.includes("from '../src/cli/edge.ts'"), 'the function imports the edge adapter that ships in this repo');
assert(fn.includes('createEdgeHandler') && fn.includes('export default { fetch: handle }'), 'the function reuses createEdgeHandler behind Vercel\'s Web Standard handler');
assert(fs.existsSync(path.join(REPO, 'src/cli/edge.ts')), 'the imported adapter file exists');
const nodeDocker = fs.readFileSync(path.join(REPO, 'deploy/Dockerfile.node'), 'utf8');
assert(nodeDocker.includes('npm run build') && nodeDocker.includes('"serve"'), 'the Node container builds, then runs rosefn serve (the cluster runner)');
assert(JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts.serve, 'npm run serve exists for the platforms that call it');
const fly = fs.readFileSync(path.join(REPO, 'deploy/fly.toml'), 'utf8');
assert(fly.includes('Dockerfile.node') && /internal_port\s*=\s*3000/.test(fly), 'fly.toml runs the Node container on the port rosefn serve listens on');
assert(/^app = "\S+"/m.test(fly), 'fly.toml names an app (fly launch fills the rest)');
const k8s = fs.readFileSync(path.join(REPO, 'deploy/k8s/rosefn.yaml'), 'utf8');
assert((k8s.match(/kind: Deployment/g) ?? []).length === 2, 'the k8s manifests declare the two tiers (static binary + dynamic node)');
assert(/name: rosefn-static/.test(k8s) && /name: rosefn-dynamic/.test(k8s), 'both tiers are named, and the UPSTREAM target is one of them');
assert(/UPSTREAM\s*\n\s*value: http:\/\/rosefn-dynamic:3000/.test(k8s), 'the static tier proxies the dynamic half through the in-cluster Service DNS');
assert(/value: "8080"/.test(k8s) && /value: "3000"/.test(k8s), 'each tier listens on the port its container documents');
assert(/command: \["rosefn", "serve"\]/.test(k8s), 'the dynamic tier runs the cluster runner');
assert(/type: ClusterIP/.test(k8s), 'the dynamic Service is cluster-internal (it is reached through the static proxy, never directly)');
assert(/prometheus\.io\/scrape/.test(k8s) && /prometheus\.io\/port: "8080"/.test(k8s), 'the static tier advertises the /metrics endpoint the binary serves');
const goSrc = fs.readFileSync(path.join(REPO, 'main.go'), 'utf8');
assert(goSrc.includes('UPSTREAM') && goSrc.includes('PORT'), 'the binary reads the two env vars the manifests set');
const netlifyToml = fs.readFileSync(path.join(REPO, 'deploy/netlify.toml'), 'utf8');
assert(/publish\s*=\s*"dist"/.test(netlifyToml), 'netlify.toml publishes the build output as static assets');
assert(/directory\s*=\s*"netlify\/functions"/.test(netlifyToml), 'netlify.toml names the functions directory');
assert(/included_files\s*=\s*\["dist\/\*\*"\]/.test(netlifyToml), 'the Netlify function bundle carries dist/ (the Lambda runtime has a filesystem)');
assert(/to = "\/\.netlify\/functions\/rosefn"/.test(netlifyToml) && /status = 200/.test(netlifyToml), 'every non-asset path is rewritten (not redirected) to the function');
const netlifyFn = fs.readFileSync(path.join(REPO, 'deploy/netlify/functions/rosefn.ts'), 'utf8');
assert(netlifyFn.includes("from '../../src/cli/edge.ts'"), 'the Netlify function imports the edge adapter that ships in this repo');
assert(netlifyFn.includes('export default async function rosefn'), 'the Netlify function uses the v2 Web-standard signature');
assert(netlifyFn.includes('createEdgeHandler'), 'the Netlify function reuses createEdgeHandler');
const cfToml = fs.readFileSync(path.join(REPO, 'deploy/cloudflare/wrangler.toml'), 'utf8');
assert(/pages_build_output_dir\s*=\s*"\.\/dist"/.test(cfToml), 'the Pages wrangler file builds into dist/');
assert(/nodejs_compat/.test(cfToml), 'the Pages config sets nodejs_compat (the adapter imports node:url / node:path)');
const cfFn = fs.readFileSync(path.join(REPO, 'deploy/cloudflare/functions/[[path]].ts'), 'utf8');
assert(cfFn.includes("import * as server from '../dist/server.js'"), 'the Pages function STATICALLY imports the server bundle (the deploy compiler bundles it in)');
assert(cfFn.includes("from '../src/cli/edge.ts'"), 'the Pages function imports the edge adapter that ships in this repo');
assert(cfFn.includes('export const onRequest'), 'the Pages function uses the onRequest signature');
assert(/fetch\(new URL\('\/client\.js', base\)\)/.test(cfFn), 'the Pages function fetches the client bundle from its own static assets (workerd has no filesystem)');
assert(cfFn.includes('createEdgeHandler'), 'the Pages function reuses createEdgeHandler with the preloaded modules');

const analysis = (await run(['build', 'example'], REPO)).out;
assert(/Rosefn build analysis \(measured from dist\//.test(analysis), 'the build prints its wire analysis');
assert(/\/bare\s+[\d.]+ KB raw\s+[\d.]+ KB gzip\s+[\d.]+ KB br\s+bundle inlined/.test(analysis), 'an interactive route reports raw/gzip/br from its own file');
assert(/\/garden\s+[\d.]+ KB raw\s+[\d.]+ KB gzip\s+[\d.]+ KB br\s+zero-JS/.test(analysis), 'a zero-JS route reports its three sizes too (the moat, measured)');
assert(/shared bundle\s+[\d.]+ KB raw\s+[\d.]+ KB gzip\s+[\d.]+ KB br/.test(analysis), 'the shared bundle reports its own size');
assert(/dynamic \(rendered per request, measured live by `npm run benchmark`\): .*\/feed/.test(analysis), 'the dynamic routes are listed, not measured (they are not baked)');
const homeGzip = zlib.gzipSync(fs.readFileSync(path.join(REPO, 'dist', 'index.html')), { level: 9 }).length;
assert(analysis.includes(`${(homeGzip / 1024).toFixed(1)} KB gzip`), 'the analysis column matches the file on disk');

const apiDir = path.join(REPO, 'api');
fs.rmSync(apiDir, { recursive: true, force: true });
fs.mkdirSync(apiDir, { recursive: true });
fs.copyFileSync(path.join(REPO, 'deploy/api/rosefn.ts'), path.join(apiDir, 'rosefn.ts'));
const scratch = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'rosefn-vercel-'));
fs.writeFileSync(path.join(scratch, 'runner.mjs'), `
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(${JSON.stringify(path.join(apiDir, 'rosefn.ts'))}).href);
const out = [];
const call = async (p, init) => {
  const r = await mod.default.fetch(new Request('http://localhost' + p, init));
  const text = await r.text();
  return { status: r.status, text, cookie: r.headers.get('set-cookie') ?? '' };
};
out.push(['/', await call('/')]);
out.push(['/sign', await call('/sign')]);
out.push(['/api/posts', await call('/api/posts')]);
out.push(['/api/login', await call('/api/login', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ user: 'ada', pass: 'lovelace' }).toString(),
})]);
console.log(JSON.stringify(out));
`);
const vercelRun = await new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(REPO, 'node_modules/tsx/dist/cli.mjs'), path.join(scratch, 'runner.mjs')], { cwd: scratch });
  let out = '';
  let err = '';
  p.stdout.on('data', (c) => { out += c; });
  p.stderr.on('data', (c) => { err += c; });
  p.on('close', (code) => resolve({ code, out, err }));
});
fs.rmSync(apiDir, { recursive: true, force: true });
fs.rmSync(scratch, { recursive: true, force: true });
assert(vercelRun.code === 0, `the function module loads and answers (stderr: ${vercelRun.err.slice(-300)})`);
const calls = JSON.parse(vercelRun.out.trim());
const byPath = new Map(calls.map(([p, r]) => [p, r]));
assert(byPath.get('/')?.status === 200 && byPath.get('/')?.text.includes('Guestbook'), 'the function serves the built home document');
assert(byPath.get('/sign')?.status === 200 && byPath.get('/sign')?.text.includes('Ada Lovelace'), 'the function renders a dynamic $store route (never a static file)');
assert(byPath.get('/api/posts')?.status === 200 && byPath.get('/api/posts')?.text.includes('"posts"'), 'the function runs an unbaked /api route');
const login = byPath.get('/api/login');
assert(login?.status === 200 && /session=/.test(login.cookie) && /HttpOnly/i.test(login.cookie), `the function logs in and sets the session cookie (${login?.status} ${login?.cookie})`);

const devDir = path.join(tmp, 'devapp');
fs.mkdirSync(path.join(devDir, 'src', 'pages'), { recursive: true });
const devPage = path.join(devDir, 'src', 'pages', 'index.rose');
const devBody = (label) => `<script>\n  let n = $state(0);\n  let name = $state('');\n</script>\n<h1>count {n} ${label}</h1>\n<input value={name()} aria-label="name">\n<button on:click={() => $setState('n', n() + 1)}>+1</button>\n`;
fs.writeFileSync(devPage, devBody(''));
const devPort = await takePort(0);
const devSrv = spawn(process.execPath, [...TSX, 'dev'], { cwd: devDir, env: { ...process.env, PORT: String(devPort) } });
let devOut = '';
devSrv.stdout.on('data', (c) => { devOut += c; });
devSrv.stderr.on('data', (c) => { devOut += c; });
const devBase = await new Promise((resolve) => {
  const t = setInterval(() => {
    const m = /http:\/\/localhost:(\d+)/.exec(devOut);
    if (m) { clearInterval(t); resolve(`http://localhost:${m[1]}`); }
  }, 100);
  setTimeout(() => { clearInterval(t); resolve(null); }, 30000);
});
try {
  assert(devBase !== null, `the dev server starts and prints its port (got: ${devOut.slice(-200)})`);
  const devDoc = await (await fetch(devBase + '/')).text();
  assert(devDoc.includes("EventSource('/__rosefn_reload')"), 'a dev document carries the reload bridge');
  assert(devDoc.includes('window.__rosefn='), 'the dev document carries the state seam the bridge reads');
  const devHeaders = await fetch(devBase + '/');
  assert(devHeaders.headers.get('content-security-policy') === null, 'dev drops the hash CSP (the injected bridge is not hashed)');
  assert(devHeaders.headers.get('content-encoding') === null, 'dev answers uncompressed (a compressed body has no <head> to inject into)');
  assert(devDoc.includes('data-on-click="__h0"'), 'an inline on: handler gets a synthetic name in the markup');
  const sse = await fetch(devBase + '/__rosefn_reload');
  assert(sse.headers.get('content-type')?.includes('text/event-stream'), 'the reload channel is an SSE stream');
  const reader = sse.body.getReader();
  await reader.read();
  let pushed = '';
  const pump = (async () => {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      pushed += new TextDecoder().decode(r.value);
      if (pushed.includes('rebuild')) break;
    }
  })();
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(devPage, devBody('(edited)'));
  await Promise.race([pump, new Promise((r) => setTimeout(r, 20000))]);
  assert(pushed.includes('data: rebuild'), 'editing a file pushes the rebuild signal to the open tab');
  const edited = await (await fetch(devBase + '/')).text();
  assert(text(edited).includes('count 0 (edited)'), 'the tab that reloads gets the new code');
  const snap = JSON.stringify({ n: 7, name: 'ada', __route: '/' });
  const posted = await fetch(devBase + '/__rosefn_state', { method: 'POST', body: snap, headers: { 'content-type': 'application/json' } });
  assert(posted.status === 204, 'the bridge can post its snapshot back');
  const resumed = await (await fetch(devBase + '/')).text();
  assert(resumed.includes(`<script>window.__rosefn_resume=${snap}</script>`), 'the next document carries the snapshot back (the edit lands on the live state)');
  const after = await (await fetch(devBase + '/')).text();
  assert(!after.includes(`window.__rosefn_resume=${snap}`), 'the snapshot is one-shot (it is not served twice)');
  fs.writeFileSync(path.join(devDir, 'src', 'pages', 'fresh.rose'), '<h1>fresh route</h1>\n');
  await new Promise((r) => setTimeout(r, 150));
  const fresh = await fetch(devBase + '/fresh');
  const freshHtml = await fresh.text();
  assert(fresh.status === 200 && freshHtml.includes('fresh route'), `a route added mid-session answers 200 on the first try (got ${fresh.status}: ${freshHtml.slice(0, 80)})`);
  const prodDoc = fs.readFileSync(path.join(REPO, 'dist', 'index.html'), 'utf8');
  assert(!prodDoc.includes('__rosefn_reload'), 'a built document carries no reload bridge');
  assert(!prodDoc.includes('<script>window.__rosefn_resume='), 'a built document carries no resume seed');
} finally {
  devSrv.kill('SIGKILL');
}

const vitalsDir = path.join(tmp, 'vitals');
fs.mkdirSync(path.join(vitalsDir, 'src', 'pages'), { recursive: true });
const vitalsPage = `<script>\n  export const vitals = true;\n  let n = $state(0);\n</script>\n<h1>vitals {n}</h1>\n<button on:click={() => $setState('n', n() + 1)}>+1</button>\n`;
fs.writeFileSync(path.join(vitalsDir, 'src', 'pages', 'index.rose'), vitalsPage);
const vitalsBuilt = await run(['build'], vitalsDir);
assert(vitalsBuilt.code === 0, `a project exporting vitals = true builds (stderr: ${vitalsBuilt.err.slice(0, 200)})`);
const vitalsBundle = fs.readFileSync(path.join(vitalsDir, 'dist', 'client.js'), 'utf8');
assert(vitalsBundle.includes('rosefn:vitals'), 'the opted-in bundle carries the vitals hook');
assert(/__rosefn_vitals/.test(vitalsBundle), 'the live values are exposed for a devtools read');
const plainDir = path.join(tmp, 'plainvitals');
fs.mkdirSync(path.join(plainDir, 'src', 'pages'), { recursive: true });
fs.writeFileSync(path.join(plainDir, 'src', 'pages', 'index.rose'), `<script>\n  let n = $state(0);\n</script>\n<h1>{n}</h1>\n<button on:click={() => $setState('n', n() + 1)}>+1</button>\n`);
await run(['build'], plainDir);
const plainBundle = fs.readFileSync(path.join(plainDir, 'dist', 'client.js'), 'utf8');
assert(!plainBundle.includes('rosefn:vitals'), 'a bundle without the export carries no vitals hook (esbuild drops it)');
const badVitals = path.join(tmp, 'badvitals');
fs.mkdirSync(path.join(badVitals, 'src', 'pages'), { recursive: true });
fs.writeFileSync(path.join(badVitals, 'src', 'pages', 'index.rose'), `<script>\n  export const vitals = 'yes';\n</script>\n<p>x</p>\n`);
const badRun = await run(['build'], badVitals);
assert(badRun.code !== 0 && badRun.err.includes('export const vitals must be true'), 'a non-boolean vitals value fails the build');
const { JSDOM } = await import('jsdom');
const vitalsHtml = fs.readFileSync(path.join(vitalsDir, 'dist', 'index.html'), 'utf8');
let classic = vitalsHtml.replace('<script type="module">', '<script>');
const exp = classic.match(/\bexport\{([^}]*)\};?/);
if (exp) {
  const decls = exp[1].split(',').map((s) => { const [o, a] = s.split(/\s+as\s+/); return `${a || o}=${o}`; }).join(',');
  classic = classic.replace(exp[0], `const ${decls};`);
}
const seen = [];
const dom = new JSDOM(classic, {
  runScripts: 'dangerously',
  url: 'http://localhost/vitals',
  pretendToBeVisual: true,
  beforeParse(w) {
    w.performance.getEntriesByType = (type) => type === 'navigation' ? [{ responseStart: 123 }] : type === 'paint' ? [{ name: 'first-contentful-paint', startTime: 200 }] : [];
    let cb = null;
    w.PerformanceObserver = class {
      constructor(fn) { cb = fn; }
      observe() { this.cb = cb; }
    };
    w.__fire = (entries) => cb({ getEntries: () => entries });
    w.addEventListener('rosefn:vitals', (e) => seen.push(e.detail));
  },
});
const w = dom.window;
await new Promise((r) => setTimeout(r, 50));
const val = (name) => { for (let i = seen.length - 1; i >= 0; i--) if (seen[i].name === name) return seen[i].value; return undefined; };
const first = (name) => seen.find((d) => d.name === name);
assert(val('ttfb') === 123, 'ttfb is reported from the navigation entry');
assert(val('fcp') === 200, 'fcp is reported from the paint entry');
assert(first('ttfb')?.route === '/vitals', 'each event names the route it was measured on');
w.__fire([{ entryType: 'largest-contentful-paint', startTime: 640 }]);
assert(val('lcp') === 640, 'lcp is reported from the observer');
w.__fire([{ entryType: 'layout-shift', value: 0.05, hadRecentInput: false }, { entryType: 'event', duration: 180, interactionId: 1 }]);
Object.defineProperty(w.document, 'visibilityState', { value: 'hidden', configurable: true });
w.document.dispatchEvent(new w.Event('visibilitychange'));
assert(val('cls') === 0.05, 'cls accumulates and is flushed when the page is hidden');
assert(val('inp') === 180, 'inp reports the worst interaction duration');
assert(w.__rosefn_vitals.lcp === 640, 'the live values stay readable for a devtools extension');

const tdzDir = path.join(tmp, 'tdz');
fs.mkdirSync(path.join(tdzDir, 'src', 'pages'), { recursive: true });
fs.writeFileSync(path.join(tdzDir, 'src', 'pages', 'index.rose'), `<script>
  let st = $data(() => ({ counts: { posts: 1 } }));
  const counts = st().counts;
</script>
<p>{counts.posts}</p>
`);
const tdzBuilt = await run(['build'], tdzDir);
assert(tdzBuilt.code === 0, `a page reading its $data state at the top level builds (stderr: ${tdzBuilt.err.slice(0, 200)})`);
assert(!/Cannot access|before initialization/.test(tdzBuilt.err), 'the build reports no TDZ crash');
const tdzHtml = fs.readFileSync(path.join(tdzDir, 'dist', 'index.html'), 'utf8');
assert(!/render failed/i.test(tdzHtml), 'the page is not the error page');
assert(/<p><!--⟦m:0⟧-->1<\/p>/.test(tdzHtml), 'the top-level read renders the state value (declaration first, read after)');
const tdzServer = fs.readFileSync(path.join(tdzDir, 'dist', 'server.js'), 'utf8');
const declAt = tdzServer.indexOf('const [st, setSt] = state("st"');
const readAt = tdzServer.indexOf('const counts = st().counts');
assert(declAt > 0 && readAt > declAt, 'the SSR module emits the declaration before the top-level read');
assert(!tdzServer.includes('__rvdecl') && !fs.readFileSync(path.join(tdzDir, 'dist', 'client.js'), 'utf8').includes('__rvdecl'), 'no splice placeholder survives into the bundles');
fs.writeFileSync(path.join(tdzDir, 'src', 'pages', 'corpus.rose'), `<script>
  const corpus = ['a', 'b'];
  let items = $state(corpus);
</script>
<p>{items().join(',')}</p>
`);
const corpusBuilt = await run(['build'], tdzDir);
assert(corpusBuilt.code === 0, `a $state initializer reading a script value above it builds (stderr: ${corpusBuilt.err.slice(0, 200)})`);
const corpusHtml = fs.readFileSync(path.join(tdzDir, 'dist', 'corpus', 'index.html'), 'utf8');
assert(/<p><!--⟦m:0⟧-->a,b<\/p>/.test(corpusHtml), 'the initializer sees the script value (both keep their source order)');
fs.writeFileSync(path.join(tdzDir, 'src', 'pages', 'nested.rose'), `<script>
  let n = $state(0);
  onMount(() => {
    let local = $state(7);
    console.log(local());
  });
</script>
<p>{n()}</p>
`);
const nestedBuilt = await run(['build'], tdzDir);
assert(nestedBuilt.code === 0, `a declaration inside onMount still builds (stderr: ${nestedBuilt.err.slice(0, 200)})`);
const nestedHtml = fs.readFileSync(path.join(tdzDir, 'dist', 'nested', 'index.html'), 'utf8');
assert(/<p><!--⟦m:0⟧-->0<\/p>/.test(nestedHtml), 'the page with the nested declaration renders');
assert(fs.readFileSync(path.join(tdzDir, 'dist', 'server.js'), 'utf8').includes('const [local, setLocal] = state("local", 7)'), 'the nested declaration is hoisted to render scope (not rewritten in place)');

const errDir = path.join(tmp, 'errcontract');
fs.mkdirSync(path.join(errDir, 'src', 'pages'), { recursive: true });
const badExport = (body) => fs.writeFileSync(path.join(errDir, 'src', 'pages', 'index.rose'), body);
badExport(`<script>\n  export const vitals = 'yes';\n</script>\n<p>x</p>\n`);
const errHuman = await run(['build'], errDir);
assert(errHuman.code === 1, 'a build error exits 1 (a silent success is the worst failure mode)');
assert(errHuman.err.includes('export const vitals must be true'), 'the human output still names the error');
assert(errHuman.err.includes('hint: omit the export entirely, or set it to exactly true'), 'the human output names the fix');
assert(/:1$/.test(errHuman.err.trim().split('\n').pop()), `the human output names the file and line (got: ${errHuman.err.trim().split('\n').pop()})`);
const errJson = await run(['build', '--json'], errDir);
assert(errJson.code === 1 && errJson.err === '', '--json keeps stderr empty (the envelope is the output)');
const envelope = JSON.parse(errJson.out.trim());
assert(envelope.ok === false && envelope.errors.length === 1, 'the envelope is { ok: false, errors: [...] }');
const e0 = envelope.errors[0];
assert(e0.code === 'E-EXPORT' && e0.line === 1 && e0.file.endsWith('index.rose') && e0.hint, 'the error object carries code, file, line, message and hint');
fs.mkdirSync(path.join(errDir, 'src', 'components'), { recursive: true });
fs.writeFileSync(path.join(errDir, 'src', 'components', 'Widget.rose'), `<script>\n  export let label = 'w';\n</script>\n<span>{label}</span>\n`);
badExport(`<script>\n  import Widget from '../components/Widget.rose';\n</script>\n<Widget label="x">\n`);
const tplJson = await run(['build', '--json'], errDir);
assert(JSON.parse(tplJson.out.trim()).errors[0].code === 'E-TEMPLATE', 'an unclosed tag reports E-TEMPLATE');
const bare2 = path.join(errDir, 'bare');
fs.mkdirSync(path.join(bare2, 'src', 'pages'), { recursive: true });
const bareJson = await run(['build', bare2, '--json'], REPO);
const bareErr = JSON.parse(bareJson.out.trim()).errors[0];
assert(bareErr.code === 'E-ROUTE' && bareErr.file.endsWith('pages'), 'a project with no pages reports E-ROUTE naming the directory');
const prompt = await run(['prompt'], REPO);
assert(prompt.code === 0 && prompt.out.includes('# Rosefn authoring contract'), 'rosefn prompt prints the contract');
for (const rule of ['There is NO {:else}', 'export const csr', '$data() is banned in components', 'E-NODE-ONLY', 'ONE request with ZERO hydration']) {
  assert(prompt.out.includes(rule), `the contract states the rule: ${rule}`);
}
const usageOut = await run([], REPO);
assert(usageOut.out.includes('prompt') && usageOut.out.includes('--json'), 'the usage line documents the new command and the flag');

const pubDir = path.join(tmp, 'publicdir');
fs.mkdirSync(path.join(pubDir, 'src', 'pages'), { recursive: true });
fs.mkdirSync(path.join(pubDir, 'public', 'icons'), { recursive: true });
fs.mkdirSync(path.join(pubDir, 'public', 'fonts', 'sub'), { recursive: true });
fs.writeFileSync(path.join(pubDir, 'src', 'pages', 'index.rose'), `<h1>assets</h1>\n`);
fs.writeFileSync(path.join(pubDir, 'public', 'logo.svg'), `<svg id="logo"></svg>\n`);
fs.writeFileSync(path.join(pubDir, 'public', 'icons', 'rose.svg'), `<svg id="rose"></svg>\n`);
fs.writeFileSync(path.join(pubDir, 'public', 'fonts', 'sub', 'deep.txt'), `nested twice\n`);
const pubBuilt = await run(['build'], pubDir);
assert(pubBuilt.code === 0, `a project with nested public/ directories builds (stderr: ${pubBuilt.err.slice(0, 200)})`);
assert(!/EPERM|EISDIR/.test(pubBuilt.err), 'the build reports no EPERM/EISDIR from the asset copy');
assert(fs.readFileSync(path.join(pubDir, 'dist', 'public', 'icons', 'rose.svg'), 'utf8').includes('id="rose"'), 'the nested icon lands in dist/public/icons/ with its bytes');
assert(fs.readFileSync(path.join(pubDir, 'dist', 'public', 'fonts', 'sub', 'deep.txt'), 'utf8').trim() === 'nested twice', 'a twice-nested asset keeps the whole relative path');
assert(fs.existsSync(path.join(pubDir, 'dist', 'public', 'logo.svg')), 'the flat asset still lands beside the nested ones');
assert(fs.existsSync(path.join(pubDir, 'dist', 'public', 'icons', 'rose.svg.br')), 'the nested asset gets its precompressed brotli sibling too');
const pubPort = await takePort(0);
const pubProc = spawn(process.execPath, [...TSX, 'serve'], {
  cwd: pubDir,
  env: { ...process.env, PORT: String(pubPort), ROSEFN_WORKERS: '1' },
});
try {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://localhost:${pubPort}/`); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  const icon = await fetch(`http://localhost:${pubPort}/public/icons/rose.svg`);
  assert(icon.status === 200, 'serve answers a nested public/ path');
  assert((await icon.text()).includes('id="rose"'), 'the nested asset is served with its bytes');
  const deep = await fetch(`http://localhost:${pubPort}/public/fonts/sub/deep.txt`);
  assert(deep.status === 200 && (await deep.text()).trim() === 'nested twice', 'a twice-nested asset is served by its full subpath');
  const flat = await fetch(`http://localhost:${pubPort}/public/logo.svg`);
  assert(flat.status === 200, 'a flat public/ asset still serves');
  const missing = await fetch(`http://localhost:${pubPort}/public/missing.txt`);
  assert(missing.status === 404, 'an unknown public/ subpath answers 404 (not the HTML shell)');
} finally {
  pubProc.kill();
}

{
const mntDir = path.join(tmp, 'mount');
fs.mkdirSync(path.join(mntDir, 'src', 'pages'), { recursive: true });
fs.writeFileSync(path.join(mntDir, 'src', 'pages', 'index.rose'), `<script>
  export const csr = true;
  export const store = $store('mount-hits', 0);
  let n = $state(0);
  // the store seeds state per render (the demo's guestbook pattern): the
  // value then rides the state script, so an adopted response carries it
  let hits = $state(store.get());
  export async function action() { store.update((v) => v + 1); }
</script>

<head>
  <title>Mounted home</title>
</head>

<h1>Mounted home</h1>
<button on:click={() => $setState('n', n() + 1)}>+1</button>
<p>count <strong>{n()}</strong></p>
<form method="POST"><button type="submit">hit</button></form>
<p>hits <strong>{hits()}</strong></p>
<a href="/about">about</a>
`);
fs.writeFileSync(path.join(mntDir, 'src', 'pages', 'about.rose'), `<h1>Mounted about</h1>\n<p>the second route</p>\n`);
fs.writeFileSync(path.join(mntDir, 'src', 'pages', 'plain.rose'), `<h1>Plain mount</h1>\n<p>a zero-JS route, mounted</p>\n`);
const mntBuilt = await run(['build'], mntDir);
assert(mntBuilt.code === 0, `the mount fixture project builds (stderr: ${mntBuilt.err.slice(0, 200)})`);
const mountSrc = fs.readFileSync(path.join(mntDir, 'dist', 'mount.js'), 'utf8');
assert(mountSrc.includes('[data-rosefn]') && /from '\/client\.js(\?v=[0-9a-z]+)?'/.test(mountSrc), 'the build emits dist/mount.js (the embeddable entry)');
const mntPort = await takePort(0);
const mntProc = spawn(process.execPath, [...TSX, 'serve'], {
  cwd: mntDir,
  env: { ...process.env, PORT: String(mntPort), ROSEFN_WORKERS: '1' },
});
const mntBase = `http://localhost:${mntPort}`;
try {
  for (let i = 0; i < 100; i++) {
    try { await fetch(mntBase + '/'); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  const homeDoc = await (await fetch(mntBase + '/')).text();
  const hostHtml = `<html><head><title>Legacy host page</title></head><body><h1>Legacy shell</h1><a id="hostlink" href="/legacy-route">host link</a><div data-rosefn="/" id="m1"></div><div data-rosefn="/plain" id="m2"></div></body></html>`;
  let client = fs.readFileSync(path.join(mntDir, 'dist', 'client.js'), 'utf8');
  const exp = client.match(/\bexport\{([^}]*)\};?/);
  if (exp) {
    const decls = exp[1].split(',').map((s) => { const [o, a] = s.split(/\s+as\s+/); return `${a || o}=${o}`; }).join(',');
    client = client.replace(exp[0], `const ${decls};`);
  }
  const mountBody = mountSrc.replace(/^import \{[^}]*\} from '\/client\.js(\?v=[0-9a-z]+)?';$/m, '');
  const classic = `${client}\n;(async () => {\n${mountBody}\n})();`;
  const requests = [];
  let hostPrevented = true;
  const dom = new JSDOM(hostHtml, {
    runScripts: 'dangerously',
    url: mntBase + '/legacy-shell',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (input, init) => {
        const url = new URL(String(input), mntBase).href;
        requests.push(`${init && init.method ? init.method : 'GET'} ${url}`);
        if (init && init.body && typeof init.body.getAll === 'function') {
          const params = new URLSearchParams();
          for (const [k, v] of init.body.entries()) params.append(k, String(v));
          init = { ...init, body: params.toString(), headers: { ...(init.headers || {}), 'content-type': 'application/x-www-form-urlencoded' } };
        }
        return fetch(url, init);
      };
    },
  });
  const w = dom.window;
  w.document.getElementById('hostlink').addEventListener('click', (e) => { hostPrevented = e.defaultPrevented; });
  const m1 = w.document.getElementById('m1');
  const m2 = w.document.getElementById('m2');
  w.eval(classic);
  for (let i = 0; i < 80 && !(m1.__rosefn_bound && m2.__rosefn_bound); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(!!m1.__rosefn_bound && !!m2.__rosefn_bound, 'both mounts finished wiring (events bound, state resumed)');
  const appInner = /<div id="app">([\s\S]*?)<\/div>\s*<script/.exec(homeDoc);
  assert(!!appInner && m1.innerHTML === appInner[1], 'the mount adopts the server document byte for byte (zero hydration, no re-render)');
  assert(m1.querySelector('#__rosefn_state') === null, 'the state script is dropped once the resume read it');
  assert(w.document.title === 'Legacy host page', 'the host page title survives a mounted route that declares its own');
  assert(w.document.querySelector('head').innerHTML.includes('Legacy host page'), 'the host head carries no rosefn-managed elements');
  assert(m2.textContent.includes('Plain mount'), 'a zero-JS route mounts through the body-children path (no #app wrapper)');
  assert(m2.querySelectorAll('script').length === 0, 'the mounted zero-JS route carries no script');
  (m1.querySelector('[data-on-click]')).click();
  await new Promise((r) => setTimeout(r, 60));
  assert(m1.querySelector('p strong').textContent === '1', 'a click inside the mount patches the count node (the bundle is wired)');
  const before = requests.length;
  const mountForm = m1.querySelector('form');
  mountForm.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 40 && !m1.textContent.includes('hits 1'); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(m1.textContent.includes('hits 1'), 'a form POST inside the mount runs the action and adopts in place');
  const posted = requests.slice(before);
  assert(posted.length === 1 && posted[0].startsWith('POST'), `the mounted action costs exactly one POST (got: ${posted.join(', ')})`);
  assert(/\/$/.test(posted[0]), 'the POST targets the MOUNTED route, not the host URL');
  (m1.querySelector('a[href="/about"]')).click();
  for (let i = 0; i < 40 && !m1.textContent.includes('Mounted about'); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(m1.textContent.includes('Mounted about'), 'an internal link navigates inside the mount');
  assert(w.location.pathname === '/legacy-shell', 'the host page URL is untouched by the mount navigation');
  (w.document.getElementById('hostlink')).click();
  assert(hostPrevented === false, 'a click on the host page link is not intercepted by the mount');
  const gets = requests.filter((r) => r.startsWith('GET'));
  assert(gets.length === 2, `two containers, two document fetches, no extra requests (got: ${gets.join(' | ')})`);
  dom.window.close();
 } finally {
   mntProc.kill();
 }
}

{
  const isoScratch = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'rosefn-isolate-'));
  fs.writeFileSync(path.join(isoScratch, 'runner.mjs'), `
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';
const RT = await import(pathToFileURL(${JSON.stringify(path.join(REPO, 'src/runtime/index.ts'))}).href);
const als = new AsyncLocalStorage();
RT.installContextStore({ getStore: () => als.getStore(), run: (s, fn) => als.run(s, fn) });
const render = (name, delay) => als.run({}, () => RT.isolateRender(async () => {
  RT.setState('route', name);
  await new Promise((r) => setTimeout(r, delay));
  RT.setState('afterAwait', name);
  return JSON.parse(RT.serializeState());
}));
const [a, b] = await Promise.all([render('A', 5), render('B', 30)]);
console.log(JSON.stringify({ a, b, leak: RT.hasState('route') }));
`);
  const isoRun = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(REPO, 'node_modules/tsx/dist/cli.mjs'), path.join(isoScratch, 'runner.mjs')], { cwd: isoScratch });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
  fs.rmSync(isoScratch, { recursive: true, force: true });
  assert(isoRun.code === 0, `the isolation runner loads the runtime (stderr: ${isoRun.err.slice(-300)})`);
  const iso = JSON.parse(isoRun.out.trim());
  assert(iso.a.route === 'A' && iso.a.afterAwait === 'A', `an overlapping render keeps its own state across awaits (got ${JSON.stringify(iso.a)})`);
  assert(iso.b.route === 'B' && iso.b.afterAwait === 'B', `the second overlapping render is not wiped by the first one's restore (got ${JSON.stringify(iso.b)})`);
  assert(iso.leak === false, 'no render state survives into the process-wide map');
}

{
  const staticOk = path.join(tmp, 'static-ok');
  fs.mkdirSync(path.join(staticOk, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(staticOk, 'src', 'pages', 'index.rose'), `<h1>pure static</h1>\n<p>no server anywhere</p>\n`);
  fs.writeFileSync(path.join(staticOk, 'src', 'pages', 'about.rose'), `<h1>about</h1>\n`);
  const okRun = await run(['build', '--static'], staticOk);
  assert(okRun.code === 0, `a fully static project passes the --static gate (stderr: ${okRun.err.slice(0, 300)})`);
  assert(okRun.out.includes('static export verified'), 'the gate says the dist needs no server');
  assert(fs.existsSync(path.join(staticOk, 'dist', 'about', 'index.html')), 'the verified export still carries every baked route');

  const staticDyn = path.join(tmp, 'static-dyn');
  fs.mkdirSync(path.join(staticDyn, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(staticDyn, 'src', 'pages', 'index.rose'), `<script>\n  export const store = $store('hits', 0);\n  let hits = $state(store.get());\n</script>\n<h1>dynamic</h1>\n<p>hits {hits}</p>\n`);
  fs.writeFileSync(path.join(staticDyn, 'src', 'pages', 'plain.rose'), `<h1>plain</h1>\n`);
  const dynRun = await run(['build', '--static'], staticDyn);
  assert(dynRun.code !== 0, 'a project with a $store route is refused by --static');
  assert(dynRun.err.includes('--static export refused'), 'the refusal says which mode was asked for');
  assert(dynRun.err.includes('$store'), 'the refusal names why the route needs a server');
  const dynPlain = await run(['build'], staticDyn);
  assert(dynPlain.code === 0, `the same dynamic project builds normally without --static (stderr: ${dynPlain.err.slice(0, 200)})`);
  assert(dynPlain.out.includes('dynamic route /'), 'the normal build reports the dynamic route as on-demand');

  const staticApi = path.join(tmp, 'static-api');
  fs.mkdirSync(path.join(staticApi, 'src', 'pages', 'api'), { recursive: true });
  fs.writeFileSync(path.join(staticApi, 'src', 'pages', 'index.rose'), `<h1>api host</h1>\n`);
  fs.writeFileSync(path.join(staticApi, 'src', 'pages', 'api', 'posts.rose'), `<script>\n  export function GET() { return { posts: [] }; }\n</script>\n`);
  const apiRun = await run(['build', '--static'], staticApi);
  assert(apiRun.code !== 0, 'a live /api route is refused by --static');
  assert(apiRun.err.includes('/api/posts'), 'the refusal names the unbaked api route');
  fs.writeFileSync(path.join(staticApi, 'src', 'pages', 'api', 'posts.rose'), `<script>\n  export const prerender = true;\n  export function GET() { return { posts: [] }; }\n</script>\n`);
  const apiBaked = await run(['build', '--static'], staticApi);
  assert(apiBaked.code === 0, `the baked api route passes the gate (stderr: ${apiBaked.err.slice(0, 200)})`);
  assert(fs.existsSync(path.join(staticApi, 'dist', 'api', 'posts.json')), 'the baked api body is in the export');

  const staticParam = path.join(tmp, 'static-param');
  fs.mkdirSync(path.join(staticParam, 'src', 'pages', 'post'), { recursive: true });
  fs.writeFileSync(path.join(staticParam, 'src', 'pages', 'index.rose'), `<h1>params host</h1>\n`);
  fs.writeFileSync(path.join(staticParam, 'src', 'pages', 'post', '[id].rose'), `<script>\n  let id = $state('1');\n</script>\n<h1>post {id}</h1>\n`);
  const paramRun = await run(['build', '--static'], staticParam);
  assert(paramRun.code !== 0, 'a param route with no params export is refused by --static');
  assert(paramRun.err.includes('/post/:id'), 'the refusal names the unenumerated param route');
  fs.writeFileSync(path.join(staticParam, 'src', 'pages', 'post', '[id].rose'), `<script>\n  let id = $state('1');\n  export const params = { id: ['1', '2'] };\n</script>\n<h1>post {id}</h1>\n`);
  const paramBaked = await run(['build', '--static'], staticParam);
  assert(paramBaked.code === 0, `the enumerated param route passes the gate (stderr: ${paramBaked.err.slice(0, 200)})`);
  assert(fs.existsSync(path.join(staticParam, 'dist', 'post', '2', 'index.html')), 'every enumerated param path is a baked file in the export');

  const staticUsage = await run([], REPO);
  assert(staticUsage.out.includes('[--static]'), 'the usage line documents --static');
}

{
  const { createServer } = await import('node:http');
  const assetPort = await takePort(0);
  const assetServer = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(REPO, 'dist', urlPath === '/' ? 'index.html' : urlPath);
      const body = await fs.promises.readFile(file);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not an asset');
    }
  });
  await new Promise((r) => assetServer.listen(assetPort, r));

  const cfDir = path.join(REPO, 'functions');
  const nlDir = path.join(REPO, 'netlify', 'functions');
  fs.rmSync(cfDir, { recursive: true, force: true });
  fs.rmSync(path.join(REPO, 'netlify'), { recursive: true, force: true });
  fs.mkdirSync(cfDir, { recursive: true });
  fs.mkdirSync(nlDir, { recursive: true });
  fs.copyFileSync(path.join(REPO, 'deploy/cloudflare/functions/[[path]].ts'), path.join(cfDir, '[[path]].ts'));
  fs.copyFileSync(path.join(REPO, 'deploy/netlify/functions/rosefn.ts'), path.join(nlDir, 'rosefn.ts'));

  const dualRunner = path.join(tmp, 'dual-runner.mjs');
  fs.writeFileSync(dualRunner, `
import { pathToFileURL } from 'node:url';
const base = process.argv[2];
const nl = await import(pathToFileURL(${JSON.stringify(path.join(nlDir, 'rosefn.ts'))}).href);
const cf = await import(pathToFileURL(${JSON.stringify(path.join(cfDir, '[[path]].ts'))}).href);
const call = async (fn, p, init) => {
  const r = await fn(new Request(base + p, init));
  const text = await r.text();
  return { status: r.status, text, cookie: r.headers.get('set-cookie') ?? '', csp: r.headers.get('content-security-policy') ?? '' };
};
const out = { netlify: {}, cloudflare: {} };
for (const [name, fn] of [['netlify', nl.default], ['cloudflare', (req) => cf.onRequest({ request: req })]]) {
  out[name]['/'] = await call(fn, '/');
  out[name]['/sign'] = await call(fn, '/sign');
  out[name]['/api/posts'] = await call(fn, '/api/posts');
  out[name]['/api/login'] = await call(fn, '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user: 'ada', pass: 'lovelace' }).toString(),
  });
}
console.log(JSON.stringify(out));
`);
  const dualRun = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(REPO, 'node_modules/tsx/dist/cli.mjs'), dualRunner, `http://localhost:${assetPort}`]);
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
  fs.rmSync(cfDir, { recursive: true, force: true });
  fs.rmSync(path.join(REPO, 'netlify'), { recursive: true, force: true });
  assetServer.close();
  assert(dualRun.code === 0, `both functions load and answer (stderr: ${dualRun.err.slice(-400)})`);
  const dual = JSON.parse(dualRun.out.trim());
  for (const target of ['netlify', 'cloudflare']) {
    const got = dual[target];
    assert(got['/']?.status === 200 && got['/'].text.includes('Guestbook'), `the ${target} function serves the built home document`);
    assert(got['/sign']?.status === 200 && got['/sign'].text.includes('Ada Lovelace'), `the ${target} function renders a dynamic $store route (never a static file)`);
    assert(got['/api/posts']?.status === 200 && got['/api/posts'].text.includes('"posts"'), `the ${target} function runs an unbaked /api route`);
    const login = got['/api/login'];
    assert(login?.status === 200 && /session=/.test(login.cookie) && /HttpOnly/i.test(login.cookie), `the ${target} function logs in and sets the session cookie (${login?.status} ${login?.cookie})`);
  }
  const stripNonce = (s) => s.replace(/nonce-[A-Za-z0-9+/=]+/g, 'nonce-X').replace(/nonce="[^"]*"/g, 'nonce="X"');
  for (const p of ['/', '/api/posts']) {
    assert(dual.netlify[p].text === dual.cloudflare[p].text, `the Pages function answers ${p} byte-for-byte like the filesystem path`);
    assert(dual.netlify[p].csp === dual.cloudflare[p].csp, `the Pages function sends the same strict CSP for ${p} (hashed over the same fetched bundle)`);
  }
  assert(stripNonce(dual.netlify['/sign'].text) === stripNonce(dual.cloudflare['/sign'].text), 'the nonce route differs between the two paths in its nonce and nothing else');
  assert(dual.netlify['/sign'].csp.includes('nonce-') && dual.cloudflare['/sign'].csp.includes('nonce-'), 'both paths mint the nonce policy for the route that asked for it');
  assert(dual.netlify['/sign'].csp !== dual.cloudflare['/sign'].csp, 'the two nonces are per-response values, as the policy requires');
}

{
  const bridgeDir = path.join(tmp, 'store-bridge');
  fs.mkdirSync(path.join(bridgeDir, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, 'src', 'pages', 'index.rose'), `<script>
  export const store = $store('hits', 0);
  export const echo = $store('echo', 0);
  let hits = $state(store.get());
  let echoed = $state(echo.get());
  export async function action() { store.update((v) => v + 1); }
</script>
<h1>bridge</h1>
<p>hits {hits()} echo {echoed()}</p>
<form method="POST"><button type="submit">bump</button></form>
`);
  const busLog = path.join(bridgeDir, 'bus.log');
  fs.writeFileSync(path.join(bridgeDir, 'rosefn.config.js'), `
import { appendFileSync } from 'node:fs';
export default [{
  name: 'bus',
  onServe({ store }) {
    
    store.install((name, value) => {
      appendFileSync(${JSON.stringify(busLog)}, name + '=' + value + '\\n');
      
      
      store.deliver('echo', value * 10);
    });
  },
}];
`);
  const bridgeBuilt = await run(['build'], bridgeDir);
  assert(bridgeBuilt.code === 0, `the bridge fixture builds (stderr: ${bridgeBuilt.err.slice(0, 200)})`);
  assert(fs.readFileSync(path.join(bridgeDir, 'dist', 'server.js'), 'utf8').includes('__installStoreTransport'), 'the server bundle exports the store bridge');
  const bridgePort = await takePort(0);
  const bridgeProc = spawn(process.execPath, [...TSX, 'serve'], {
    cwd: bridgeDir,
    env: { ...process.env, PORT: String(bridgePort), ROSEFN_WORKERS: '1' },
  });
  const bridgeBase = `http://localhost:${bridgePort}`;
  const textOf = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '');
  try {
    for (let i = 0; i < 100; i++) {
      try { await fetch(bridgeBase + '/'); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    const before = textOf(await (await fetch(bridgeBase + '/')).text());
    assert(before.includes('hits 0') && before.includes('echo 0'), 'the page renders both stores before anything happens');
    const posted = await fetch(bridgeBase + '/', {
      method: 'POST',
      body: new URLSearchParams({}),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const after = textOf(await posted.text());
    assert(posted.status === 200 && after.includes('hits 1'), 'the action wrote the store through the page');
    assert(after.includes('echo 10'), 'the delivered patch landed in the SAME store map the page reads (deliver works)');
    let log = '';
    for (let i = 0; i < 40 && !log.includes('hits=1'); i++) {
      try { log = fs.readFileSync(busLog, 'utf8'); } catch {  }
      if (!log.includes('hits=1')) await new Promise((r) => setTimeout(r, 100));
    }
    assert(log.includes('hits=1'), `the sender received the write with its name and value (got: ${JSON.stringify(log)})`);
  } finally {
    bridgeProc.kill();
  }
}

{
  const pgDir = path.join(REPO, 'examples', 'blog-pg');
  assert(fs.existsSync(path.join(pgDir, 'src', 'pages', 'api', 'posts.rose')), 'the Postgres example exists with the same file shape as the SQLite blog');
  const pgBuilt = await run(['build', 'examples/blog-pg'], REPO);
  assert(pgBuilt.code === 0, `the Postgres example builds (stderr: ${pgBuilt.err.slice(0, 300)})`);
  assert(pgBuilt.out.includes('/  zero-JS') && pgBuilt.out.includes('/post/:id  zero-JS'), 'the list and the post routes stay zero-JS on a database-backed app');
  assert(pgBuilt.out.includes('/admin  client JS'), 'the write page keeps the client bundle it needs');
  const pgServer = fs.readFileSync(path.join(REPO, 'dist', 'server.js'), 'utf8');
  assert(!/require\(|from ['"]node:|from ['"]fs['"]/.test(pgServer), 'the Postgres app\'s server bundle keeps the edge-loadable shape (zero Node built-ins)');
  assert(pgServer.length < 64 * 1024, `the pg driver is NOT bundled into the server bundle (${(pgServer.length / 1024).toFixed(1)} KB, a bundled pg would be ~200 KB)`);
  assert(pgServer.includes('__installStoreTransport'), 'the server bundle carries the store bridge the config driver installs');

  const pgPort = await takePort(0);
  const pgProc = spawn(process.execPath, [...TSX, 'serve', 'examples/blog-pg'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(pgPort), ROSEFN_WORKERS: '1' },
  });
  let pgErr = '';
  pgProc.stderr.on('data', (c) => { pgErr += c; });
  const pgBase = `http://localhost:${pgPort}`;
  try {
    for (let i = 0; i < 100; i++) {
      try { await fetch(pgBase + '/nope'); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    const missing = await fetch(pgBase + '/nope');
    assert(missing.status === 404 && (await missing.text()).includes('not in the garden'), 'a route that needs no data answers 404 with the custom page (the middleware ran, the pool never opened)');
    const bad = await fetch(pgBase + '/api/login', {
      method: 'POST', body: new URLSearchParams({}), headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert(bad.status === 400 && (await bad.json()).error === 'user and pass are required', 'a malformed login is a 400 answered without touching the database');
    const nodb = await fetch(pgBase + '/api/login', {
      method: 'POST', body: new URLSearchParams({ user: 'ada', pass: 'lovelace' }), headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert(nodb.status === 500, `a database query without DATABASE_URL answers 500 (got ${nodb.status})`);
    const alive = await fetch(pgBase + '/nope');
    assert(alive.status === 404, 'the worker is still alive after the failed query (one bad request costs one response, not the process)');
    const pgHome = await fetch(pgBase + '/');
    assert(pgHome.status === 500, 'the list page needs its rows, so it answers 500 without a database');
    assert(/DATABASE_URL/.test(pgErr), `the failure names the missing variable on stderr (got: ${pgErr.slice(0, 200)})`);
    assert(/pg-store/.test(pgErr), 'the store driver\'s connection failure is logged by name, and the worker kept serving');
  } finally {
    pgProc.kill();
  }
}

{
  const oauthBuilt = await run(['build', 'examples/oauth'], REPO);
  assert(oauthBuilt.code === 0, `the OAuth example builds (stderr: ${oauthBuilt.err.slice(0, 300)})`);
  assert(/\/\s+zero-JS/.test(oauthBuilt.out) && /\/dashboard\s+zero-JS/.test(oauthBuilt.out), 'the public and the gated pages both ship zero JS');
  assert(!fs.existsSync(path.join(REPO, 'dist', 'dashboard', 'index.html')), 'the gated page is dynamic by construction - never baked into the static deploy');

  const { createServer } = await import('node:http');
  const b64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const seen = { authorize: null, tokenHits: 0, tokenBody: null, profileHits: 0 };
  const fakePort = await takePort(0);
  const fake = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/authorize') {
      seen.authorize = Object.fromEntries(url.searchParams);
      const back = new URL(seen.authorize.redirect_uri);
      back.searchParams.set('code', 'fake-code');
      back.searchParams.set('state', seen.authorize.state);
      res.writeHead(302, { location: back.href });
      res.end();
      return;
    }
    if (url.pathname === '/token') {
      seen.tokenHits++;
      let body = '';
      for await (const c of req) body += c;
      seen.tokenBody = Object.fromEntries(new URLSearchParams(body));
      const { createHash } = await import('node:crypto');
      const challenge = b64url(createHash('sha256').update(seen.tokenBody.code_verifier ?? '').digest());
      if (challenge !== seen.authorize.code_challenge) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"pkce mismatch"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'fake-token' }));
      return;
    }
    if (url.pathname === '/profile') {
      seen.profileHits++;
      if (req.headers.authorization !== 'Bearer fake-token') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: '42', login: 'ada', name: 'Ada Lovelace' }));
      return;
    }
    res.writeHead(404);
    res.end('no such endpoint');
  });
  await new Promise((r) => fake.listen(fakePort, r));

  const oauthPort = await takePort(0);
  const oauthProc = spawn(process.execPath, [...TSX, 'serve', 'examples/oauth'], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(oauthPort),
      ROSEFN_WORKERS: '1',
      OAUTH_AUTHORIZE_URL: `http://localhost:${fakePort}/authorize`,
      OAUTH_TOKEN_URL: `http://localhost:${fakePort}/token`,
      OAUTH_USER_URL: `http://localhost:${fakePort}/profile`,
      OAUTH_CLIENT_ID: 'test-client',
      OAUTH_CLIENT_SECRET: 'test-secret',
      OAUTH_SCOPE: 'read:user',
      OAUTH_NAME_FIELD: 'login',
    },
  });
  const oauthBase = `http://localhost:${oauthPort}`;
  const cookieOf = (res, name) => {
    const raw = res.headers.getSetCookie?.().find((c) => c.startsWith(name + '=')) ?? '';
    return /;[^;]*/.test(raw) ? raw.split(';')[0].split('=').slice(1).join('=') : '';
  };
  try {
    for (let i = 0; i < 100; i++) {
      try { await fetch(oauthBase + '/'); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    const login = await fetch(oauthBase + '/api/auth/login', { redirect: 'manual' });
    assert(login.status === 302, 'the login route answers a redirect');
    const authorizeUrl = new URL(login.headers.get('location'));
    assert(authorizeUrl.origin === `http://localhost:${fakePort}`, 'the authorize URL points at the fake provider');
    const q = authorizeUrl.searchParams;
    assert(q.get('response_type') === 'code' && q.get('client_id') === 'test-client', 'the authorize URL carries response_type and client_id');
    assert(q.get('scope') === 'read:user' && q.get('redirect_uri') === oauthBase + '/api/auth/callback', 'the scope and the callback address ride along');
    assert((q.get('state') ?? '').length >= 40 && /^[A-Za-z0-9_-]+$/.test(q.get('state') ?? ''), 'the state is a long url-safe random value');
    assert(q.get('code_challenge_method') === 'S256' && (q.get('code_challenge') ?? '').length === 43, 'the PKCE challenge is S256 and 43 chars of base64url');
    const stateCookie = cookieOf(login, 'oauth_state');
    const verifierCookie = cookieOf(login, 'oauth_verifier');
    assert(stateCookie === q.get('state'), 'the state cookie carries exactly the value in the URL');
    assert((verifierCookie ?? '').length >= 40, 'the PKCE verifier rides its own cookie');
    assert(/HttpOnly/i.test(login.headers.getSetCookie?.().find((c) => c.startsWith('oauth_state=')) ?? ''), 'the state cookie is HttpOnly');
    const flowCookie = `oauth_state=${stateCookie}; oauth_verifier=${verifierCookie}`;

    const bounced = await fetch(authorizeUrl.href, { redirect: 'manual' });
    assert(bounced.status === 302, 'the fake provider answers the authorize request with a redirect');
    const callbackUrl = new URL(bounced.headers.get('location'));
    assert(callbackUrl.origin === oauthBase && callbackUrl.pathname === '/api/auth/callback', 'the bounce targets this app\'s callback');
    assert(callbackUrl.searchParams.get('code') === 'fake-code' && callbackUrl.searchParams.get('state') === stateCookie, 'the bounce carries the code and echoes the state');

    const cb = await fetch(oauthBase + callbackUrl.pathname + callbackUrl.search, { redirect: 'manual', headers: { cookie: flowCookie } });
    assert(cb.status === 302 && cb.headers.get('location') === '/dashboard', 'the callback redirects into the app');
    assert(seen.tokenHits === 1, 'the token exchange ran exactly once');
    assert(seen.tokenBody.grant_type === 'authorization_code' && seen.tokenBody.code === 'fake-code', 'the token body is an authorization-code grant for the bounced code');
    assert(seen.tokenBody.client_id === 'test-client' && seen.tokenBody.client_secret === 'test-secret', 'the confidential client authenticates in the body');
    assert(seen.tokenBody.code_verifier === verifierCookie, 'the PKCE verifier is the one from the cookie (the fake verified it hashes to the challenge)');
    assert(seen.profileHits === 1, 'the profile fetch ran with the Bearer token');
    const sessionCookie = cookieOf(cb, 'session');
    assert(sessionCookie.includes('%7B') && /HttpOnly/i.test(cb.headers.getSetCookie?.().find((c) => c.startsWith('session=')) ?? ''), 'the session cookie is HttpOnly and carries the profile');
    assert(/Max-Age=0/.test(cb.headers.getSetCookie?.().find((c) => c.startsWith('oauth_state=')) ?? ''), 'the one-time cookies die with the flow');

    const walled = await fetch(oauthBase + '/dashboard', { headers: { cookie: `session=${sessionCookie}` } });
    const walledHtml = await walled.text();
    assert(walled.status === 200 && walledHtml.includes('ada'), 'the dashboard renders the profile name for the signed-in visitor');
    const anon = await fetch(oauthBase + '/dashboard');
    const anonHtml = await anon.text();
    assert(anon.status === 200 && anonHtml.includes('Sign in') && !anonHtml.includes('Ada Lovelace'), 'without the session the gated content never exists in the response');

    const hitsBefore = seen.tokenHits;
    const forged = await fetch(`${oauthBase}/api/auth/callback?code=fake-code&state=forged`, { headers: { cookie: flowCookie } });
    assert(forged.status === 403 && (await forged.json()).error.includes('state mismatch'), 'a mismatched state is a 403');
    assert(seen.tokenHits === hitsBefore, 'the provider was never contacted for the forged callback');
    const noCode = await fetch(`${oauthBase}/api/auth/callback?state=${stateCookie}`, { headers: { cookie: flowCookie } });
    assert(noCode.status === 400, 'a callback without a code is a 400');
    const denied = await fetch(`${oauthBase}/api/auth/callback?error=access_denied&state=${stateCookie}`, { headers: { cookie: flowCookie } });
    assert(denied.status === 403 && (await denied.json()).error.includes('access_denied'), 'the provider\'s own refusal is passed through');

    const out = await fetch(oauthBase + '/api/auth/logout', { redirect: 'manual' });
    assert(out.status === 302 && out.headers.get('location') === '/' && /Max-Age=0/.test(out.headers.getSetCookie?.().find((c) => c.startsWith('session=')) ?? ''), 'logout redirects home and expires the session cookie');
  } finally {
    oauthProc.kill();
    fake.close();
  }

  const barePort = await takePort(0);
  const bareEnv = { ...process.env, PORT: String(barePort), ROSEFN_WORKERS: '1' };
  for (const k of Object.keys(bareEnv)) if (k.startsWith('OAUTH_')) delete bareEnv[k];
  const bareProc = spawn(process.execPath, [...TSX, 'serve', 'examples/oauth'], { cwd: REPO, env: bareEnv });
  try {
    for (let i = 0; i < 100; i++) {
      try { await fetch(`http://localhost:${barePort}/`); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    const unset = await fetch(`http://localhost:${barePort}/api/auth/login`);
    assert(unset.status === 500, `an unconfigured provider answers 500 (got ${unset.status})`);
    const body = await unset.json();
    assert(body.error.includes('OAUTH_AUTHORIZE_URL') && body.error.includes('OAUTH_CLIENT_ID'), 'the 500 names the missing variables');
  } finally {
    bareProc.kill();
  }
}

{
  const apiDir = path.join(tmp, 'api-surface');
  fs.mkdirSync(path.join(apiDir, 'src', 'pages', 'api'), { recursive: true });
  fs.writeFileSync(path.join(apiDir, 'src', 'pages', 'index.rose'), `<h1>surface</h1>\n`);
  fs.writeFileSync(path.join(apiDir, 'src', 'pages', 'api', 'whoami.rose'), `<script>
  export function GET(req: Request) {
    return { session: $cookies(req).session ?? null, hasContext: typeof getContext() === 'object' };
  }
</script>
`);
  fs.writeFileSync(path.join(apiDir, 'src', 'pages', 'api', 'whoami2.rose'), `<script>
  import { $cookies } from './runtime.js';
  export function GET(req: Request) {
    return { session: $cookies(req).session ?? null };
  }
</script>
`);
  fs.writeFileSync(path.join(apiDir, 'src', 'pages', 'api', 'boom.rose'), `<script>
  export function GET() {
    throw new Error('the handler knows why it failed');
  }
</script>
`);
  const apiBuilt = await run(['build'], apiDir);
  assert(apiBuilt.code === 0, `the api-surface fixture builds (stderr: ${apiBuilt.err.slice(0, 300)})`);
  const surfacePort = await takePort(0);
  const surfaceProc = spawn(process.execPath, [...TSX, 'serve'], {
    cwd: apiDir,
    env: { ...process.env, PORT: String(surfacePort), ROSEFN_WORKERS: '1' },
  });
  let surfaceErr = '';
  surfaceProc.stderr.on('data', (c) => { surfaceErr += c; });
  const surfaceBase = `http://localhost:${surfacePort}`;
  try {
    for (let i = 0; i < 100; i++) {
      try { await fetch(surfaceBase + '/'); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    const who = await fetch(surfaceBase + '/api/whoami', { headers: { cookie: 'session=abc' } });
    assert(who.status === 200, `the api route answers 200 without importing anything (got ${who.status})`);
    const whoJson = await who.json();
    assert(whoJson.session === 'abc', '$cookies works in an api route exactly like in a middleware');
    assert(whoJson.hasContext === true, 'getContext works in an api route');
    const who2 = await fetch(surfaceBase + '/api/whoami2', { headers: { cookie: 'session=xyz' } });
    assert(who2.status === 200 && (await who2.json()).session === 'xyz', 'a file that imports the helper itself still builds (no duplicate binding)');
    const boom = await fetch(surfaceBase + '/api/boom');
    assert(boom.status === 500, 'a throwing handler answers 500');
    assert(surfaceErr.includes('the handler knows why it failed'), `the reason reaches stderr (got: ${surfaceErr.slice(0, 160)})`);
  } finally {
    surfaceProc.kill();
  }
}

{
  const tplRoot = path.join(tmp, 'tpl');
  fs.mkdirSync(tplRoot, { recursive: true });
  const scaffoldTpl = async (tpl, dirName) => {
    const dir = path.join(tplRoot, dirName);
    const r = await run(['new', dir, '--template', tpl], REPO);
    assert(r.code === 0, `rosefn new --template ${tpl} exits 0 (stderr: ${r.err.slice(0, 200)})`);
    return dir;
  };

  const siteDir = await scaffoldTpl('site', 'my-site');
  const sitePkg = JSON.parse(fs.readFileSync(path.join(siteDir, 'package.json'), 'utf8'));
  const repoVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  assert(sitePkg.dependencies.rosefn === `^${repoVersion}`, 'the scaffolded project depends on the PUBLISHED package, not this checkout');
  const stamp = fs.readFileSync(path.join(REPO, 'src', 'FRAMEWORK_VERSION'), 'utf8').trim();
  assert(stamp === repoVersion, `src/FRAMEWORK_VERSION matches package.json (${stamp} vs ${repoVersion})`);
  assert(sitePkg.devDependencies?.typescript === '^5.6.0', 'the scaffolded project is TypeScript-ready (npm run check works)');
  assert(fs.existsSync(path.join(siteDir, 'rosefn-env.d.ts')) && fs.existsSync(path.join(siteDir, 'tsconfig.json')), 'the scaffolded project carries the env reference and the strict tsconfig');
  const siteBuilt = await run(['build', '--static'], siteDir);
  assert(siteBuilt.code === 0, `the site template builds and PASSES --static (stderr: ${siteBuilt.err.slice(0, 300)})`);
  assert(siteBuilt.out.includes('static export verified'), 'the site is deployable to any static host with no server');
  assert((siteBuilt.out.match(/zero-JS/g) ?? []).length >= 3, 'every site route ships zero JavaScript');
  assert(!fs.existsSync(path.join(siteDir, 'dist', 'node_modules')), 'a template\'s own build output never rides along');

  const apiDir = await scaffoldTpl('api', 'my-api');
  const apiBuilt = await run(['build'], apiDir);
  assert(apiBuilt.code === 0 && !/render failed/.test(apiBuilt.err), `the api template builds cleanly (stderr: ${apiBuilt.err.slice(0, 200)})`);
  const apiPort = await takePort(0);
  const apiProc = spawn(process.execPath, [...TSX, 'serve'], { cwd: apiDir, env: { ...process.env, PORT: String(apiPort), ROSEFN_WORKERS: '1' } });
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${apiPort}/`); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    const health = await fetch(`http://localhost:${apiPort}/api/health`);
    assert(health.status === 200 && (await health.json()).ok === true, 'the api template serves its health endpoint');
    const list = await fetch(`http://localhost:${apiPort}/api/items`);
    assert(list.status === 200 && (await list.json()).items.length === 2, 'the public read answers the seeded rows');
    const anonWrite = await fetch(`http://localhost:${apiPort}/api/items`, { method: 'POST', body: new URLSearchParams({ label: 'x' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert(anonWrite.status === 401, 'a write without a session is a 401');
    const badLogin = await fetch(`http://localhost:${apiPort}/api/login`, { method: 'POST', body: new URLSearchParams({ user: 'admin', pass: 'nope' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert(badLogin.status === 401, 'a wrong password is a 401');
    const login = await fetch(`http://localhost:${apiPort}/api/login`, { method: 'POST', body: new URLSearchParams({ user: 'admin', pass: 'admin' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const session = (login.headers.getSetCookie?.().find((c) => c.startsWith('session=')) ?? '').split(';')[0];
    assert(login.status === 200 && /HttpOnly/i.test(login.headers.getSetCookie?.().find((c) => c.startsWith('session=')) ?? ''), 'the demo login sets the HttpOnly session cookie');
    const write = await fetch(`http://localhost:${apiPort}/api/items`, { method: 'POST', body: new URLSearchParams({ label: 'third' }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session } });
    assert(write.status === 201 && (await write.json()).id === 3, 'the session-walled write answers 201 with the new row');
    const after = await fetch(`http://localhost:${apiPort}/api/items`);
    assert((await after.json()).items.length === 3, 'the store carried the write (one box per name, shared by every request)');
    const del = await fetch(`http://localhost:${apiPort}/api/items?id=3`, { method: 'DELETE', headers: { cookie: session } });
    assert(del.status === 200 && (await del.json()).deleted === 3, 'the delete answers with the deleted id');
  } finally {
    apiProc.kill();
  }

  const adminDir = await scaffoldTpl('admin', 'my-admin');
  const adminBuilt = await run(['build'], adminDir);
  assert(adminBuilt.code === 0 && !/render failed/.test(adminBuilt.err), `the admin template builds cleanly (stderr: ${adminBuilt.err.slice(0, 200)})`);
  const bodyOf = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '');
  const adminPort = await takePort(0);
  const adminProc = spawn(process.execPath, [...TSX, 'serve'], { cwd: adminDir, env: { ...process.env, PORT: String(adminPort), ROSEFN_WORKERS: '1' } });
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${adminPort}/`); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    const anon = bodyOf(await (await fetch(`http://localhost:${adminPort}/`)).text());
    assert(anon.includes('Sign in to manage'), 'the anonymous dashboard renders the login form');
    assert(!anon.includes('Signed in as') && !anon.includes('first'), 'the gated half never exists in the anonymous response');
    const login = await fetch(`http://localhost:${adminPort}/api/login`, { method: 'POST', body: new URLSearchParams({ user: 'admin', pass: 'admin' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const session = (login.headers.getSetCookie?.().find((c) => c.startsWith('session=')) ?? '').split(';')[0];
    const walled = bodyOf(await (await fetch(`http://localhost:${adminPort}/`, { headers: { cookie: session } })).text());
    assert(walled.includes('Signed in as') && walled.includes('first') && walled.includes('second'), 'with the session the dashboard renders the manager and the seeded rows');
  } finally {
    adminProc.kill();
  }

  const blogDir = await scaffoldTpl('blog', 'my-blog');
  const blogBuilt = await run(['build'], blogDir);
  assert(blogBuilt.code === 0, `the blog template builds (stderr: ${blogBuilt.err.slice(0, 200)})`);
  assert(/\/\s+zero-JS/.test(blogBuilt.out), 'the blog template keeps its zero-JS list page');
  const blogPort = await takePort(0);
  const blogProc = spawn(process.execPath, [...TSX, 'serve'], { cwd: blogDir, env: { ...process.env, PORT: String(blogPort), ROSEFN_WORKERS: '1' } });
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${blogPort}/`); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    const home = await (await fetch(`http://localhost:${blogPort}/`)).text();
    assert(home.includes('One request, zero hydration'), 'the blog template serves its seeded database rows');
  } finally {
    blogProc.kill();
  }

  const unknown = await run(['new', path.join(tplRoot, 'nope'), '--template', 'nope'], REPO);
  assert(unknown.code !== 0 && unknown.err.includes('no template'), 'an unknown template fails the scaffold');
  assert(unknown.err.includes('blog') && unknown.err.includes('api') && unknown.err.includes('admin') && unknown.err.includes('site'), 'the failure lists the available templates');
  const fromPath = await run(['new', path.join(tplRoot, 'from-path'), '--template', 'templates/site'], REPO);
  assert(fromPath.code === 0 && fs.existsSync(path.join(tplRoot, 'from-path', 'src', 'pages', 'pricing.rose')), 'a path to any project directory works as a template');
  const flipped = await run(['new', '--template', 'api', path.join(tplRoot, 'flipped')], REPO);
  assert(flipped.code === 0 && fs.existsSync(path.join(tplRoot, 'flipped', 'src', 'pages', 'api', 'items.rose')), 'the flag may come before the name');
  const plain = await run(['new', path.join(tplRoot, 'plain')], REPO);
  assert(plain.code === 0 && fs.existsSync(path.join(tplRoot, 'plain', 'src', 'pages', 'index.rose')), 'rosefn new without --template still writes the one-page starter');
  const tplUsage = await run(['new'], REPO);
  assert(tplUsage.out.includes('rosefn new <name> [--template <name>]'), 'the usage line documents the template flag');
}

{
  const dt = path.join(REPO, 'devtools');
  assert(fs.existsSync(path.join(dt, 'manifest.json')), 'devtools/manifest.json ships');
  const manifest = JSON.parse(fs.readFileSync(path.join(dt, 'manifest.json'), 'utf8'));
  assert(manifest.manifest_version === 3 && manifest.devtools_page === 'devtools.html', 'the manifest is a valid MV3 devtools entry');
  const devtoolsJs = fs.readFileSync(path.join(dt, 'devtools.js'), 'utf8');
  assert(devtoolsJs.includes("chrome.devtools.panels.create('Rosefn'") && devtoolsJs.includes('panel.html'), 'the devtools page registers the Rosefn panel');
  const panel = fs.readFileSync(path.join(dt, 'panel.js'), 'utf8');
  assert(panel.includes('window.__rosefn') && panel.includes('r.state()') && panel.includes('r.prefetch()'), 'the panel reads the two seams the bootstrap installs');
  assert(panel.includes('rosefn: false'), 'the panel answers honestly when the page carries no runtime (a zero-JS document)');
  assert(panel.includes('setInterval(read, 1000)'), 'the panel refreshes once a second');
  const panelHtml = fs.readFileSync(path.join(dt, 'panel.html'), 'utf8');
  assert(panelHtml.includes('panel.js') && /Signal graph/.test(panelHtml) && /Prefetch/.test(panelHtml), 'the panel page mounts the script and names both sections');
  assert(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8').includes('"devtools"'), 'the npm package ships the extension (files)');
}

{
  const mentionDir = path.join(tmp, 'mentions');
  fs.mkdirSync(path.join(mentionDir, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(mentionDir, 'src', 'pages', '_layout.rose'), `<script>
  // This comment mentions the <head> block, a <style> rule and a <slot />
  // on purpose: none of them is a real block, and the scanners must not
  // treat this text as one.
  let label = $state('mention');
</script>

<style>
  .m { color: teal; }
</style>

<head>
  <title>The real head</title>
</head>

<div class="m">
  <h1>{label()}</h1>
  <slot />
</div>
`);
  fs.writeFileSync(path.join(mentionDir, 'src', 'pages', 'index.rose'), `<p>the page</p>\n`);
  const mentionBuilt = await run(['build'], mentionDir);
  assert(mentionBuilt.code === 0, `a script that mentions <head>/<style>/<slot> in a comment builds (stderr: ${mentionBuilt.err.slice(0, 300)})`);
  const home = fs.readFileSync(path.join(mentionDir, 'dist', 'index.html'), 'utf8');
  assert(home.includes('<title>The real head</title>'), 'the real head block lands in the document');
  assert(!home.includes('mentions the'), 'the script text did NOT leak into the head');
  assert(home.includes('teal') && home.includes('data-rosefn-c'), 'the scoped style still lands in the document (rewritten with its scope attribute)');
  assert(home.includes('<p>the page</p>'), 'the page body still renders through the layout');
}

{
  const jwtBuilt = await run(['build', 'examples/jwt'], REPO);
  assert(jwtBuilt.code === 0 && !/render failed/.test(jwtBuilt.err), `the JWT example builds cleanly (stderr: ${jwtBuilt.err.slice(0, 200)})`);
  const jwtServer = fs.readFileSync(path.join(REPO, 'dist', 'server.js'), 'utf8');
  assert(!/require\(|from ['"]node:|from ['"]fs['"]/.test(jwtServer), 'the JWT app\'s server bundle keeps the edge-loadable shape (Web Crypto, no node: import)');

  const { createHmac } = await import('node:crypto');
  const b64url = (s) => Buffer.from(s).toString('base64url');
  const signWith = (secret, payload) => {
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify(payload));
    const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${sig}`;
  };

  const jwtPort = await takePort(0);
  const jwtProc = spawn(process.execPath, [...TSX, 'serve', 'examples/jwt'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(jwtPort), ROSEFN_WORKERS: '1', JWT_SECRET: 'test-secret' },
  });
  const jwtBase = `http://localhost:${jwtPort}`;
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(jwtBase + '/'); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }

    const badShape = await fetch(jwtBase + '/api/token', { method: 'POST', body: new URLSearchParams({}), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert(badShape.status === 400, 'a malformed login is a 400 before any credential check');
    const badCreds = await fetch(jwtBase + '/api/token', { method: 'POST', body: new URLSearchParams({ user: 'ada', pass: 'nope' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert(badCreds.status === 401, 'wrong credentials are a 401');
    const mint = await fetch(jwtBase + '/api/token', { method: 'POST', body: new URLSearchParams({ user: 'ada', pass: 'lovelace' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert(mint.status === 200, 'the demo account mints a token');
    const body = await mint.json();
    assert(body.token_type === 'Bearer' && body.expires_in === 3600, 'the mint answers the OAuth2 token shape');
    const parts = String(body.access_token).split('.');
    assert(parts.length === 3, 'the token has three segments');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    assert(header.alg === 'HS256' && header.typ === 'JWT', 'the header names HS256');
    assert(claims.sub === '1' && claims.name === 'ada' && typeof claims.exp === 'number' && claims.exp > Date.now() / 1000, 'the claims carry the user and an expiry in the future');

    const anon = await fetch(jwtBase + '/api/me');
    assert(anon.status === 401 && (await anon.json()).error === 'no token presented', 'no token is a 401 naming why');
    const me = await fetch(jwtBase + '/api/me', { headers: { authorization: `Bearer ${body.access_token}` } });
    assert(me.status === 200 && (await me.json()).name === 'ada', 'the signed token answers its claims');

    const tampered = `${parts[0]}.${b64url(JSON.stringify({ ...claims, name: 'attacker' }))}.${parts[2]}`;
    const tamperedRes = await fetch(jwtBase + '/api/me', { headers: { authorization: `Bearer ${tampered}` } });
    assert(tamperedRes.status === 401, 'a tampered payload fails the signature');
    const foreign = await fetch(jwtBase + '/api/me', { headers: { authorization: `Bearer ${signWith('another-secret', claims)}` } });
    assert(foreign.status === 401, 'a token signed with another secret is refused');
    const expired = await fetch(jwtBase + '/api/me', { headers: { authorization: `Bearer ${signWith('test-secret', { ...claims, exp: Math.floor(Date.now() / 1000) - 10 })}` } });
    assert(expired.status === 401, 'an expired token is refused even though its signature is valid');
    const malformed = await fetch(jwtBase + '/api/me', { headers: { authorization: 'Bearer not.a.jwt' } });
    assert(malformed.status === 401, 'a malformed token is a 401, not a crash');
  } finally {
    jwtProc.kill();
  }

  const barePort = await takePort(0);
  const bareEnv = { ...process.env, PORT: String(barePort), ROSEFN_WORKERS: '1' };
  delete bareEnv.JWT_SECRET;
  const bareProc = spawn(process.execPath, [...TSX, 'serve', 'examples/jwt'], { cwd: REPO, env: bareEnv });
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${barePort}/`); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    const mint = await fetch(`http://localhost:${barePort}/api/token`, { method: 'POST', body: new URLSearchParams({ user: 'ada', pass: 'lovelace' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert(mint.status === 500 && (await mint.json()).error.includes('JWT_SECRET'), 'an unconfigured mint answers 500 naming the variable');
    const me = await fetch(`http://localhost:${barePort}/api/me`);
    assert(me.status === 500 && (await me.json()).error.includes('JWT_SECRET'), 'the walled route refuses to guess a secret either');
  } finally {
    bareProc.kill();
  }
}

{
  const tpBuilt = await run(['build', 'examples/third-party'], REPO);
  assert(tpBuilt.code === 0 && !/render failed/.test(tpBuilt.err), `the third-party example builds cleanly (stderr: ${tpBuilt.err.slice(0, 200)})`);
  const tpPort = await takePort(0);
  const tpProc = spawn(process.execPath, [...TSX, 'serve', 'examples/third-party'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(tpPort), ROSEFN_WORKERS: '1' },
  });
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${tpPort}/`); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    const res = await fetch(`http://localhost:${tpPort}/`);
    const html = await res.text();
    const csp = res.headers.get('content-security-policy') ?? '';
    const headerNonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    assert(!!headerNonce && csp.includes("'strict-dynamic'"), 'the route answers a nonce + strict-dynamic policy');
    const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] ?? '';
    assert(!scriptSrc.includes('unsafe-inline'), 'the script policy still has no unsafe-inline');
    const bundleTag = /<script type="module"([^>]*)>/.exec(html)?.[1] ?? '';
    assert(bundleTag.includes(`nonce="${headerNonce}"`), 'the bundle tag carries the header nonce');
    assert(html.includes('window.partytown') && html.includes('text/partytown'), 'the route\'s head markup rides the document (the bootstrap applies it at boot)');
    assert(html.includes('Third-party scripts, the rosefn shape') && html.includes('data-on-click'), 'the page renders with its own interaction wired');
    const nonces = [...html.matchAll(/nonce="([^"]+)"/g)].map((m) => m[1]);
    assert(nonces.length >= 1 && nonces.every((n) => n === headerNonce), `every stamped tag carries the one nonce (got ${nonces.length} tags)`);
    const res2 = await fetch(`http://localhost:${tpPort}/`);
    const nonce2 = /'nonce-([^']+)'/.exec(res2.headers.get('content-security-policy') ?? '')?.[1];
    assert(nonce2 && nonce2 !== headerNonce, 'every response mints a fresh nonce');
  } finally {
    tpProc.kill();
  }

  const tpBuf = path.join(tmp, 'tp-buffered');
  fs.mkdirSync(path.join(tpBuf, 'src', 'pages'), { recursive: true });
  const bufHead = `<head>
  <title>buffered nonce</title>
  <script>window.__loader = { lib: '/vendor/x.js' };</script>
  <script src="/vendor/x.js"></script>
  <script type="application/ld+json">{"@type":"Thing"}</script>
</head>`;
  fs.writeFileSync(path.join(tpBuf, 'src', 'pages', 'index.rose'), `<script>
  export const csp = { nonce: true };
</script>

${bufHead}

<h1>buffered nonce route</h1>
<p>no events, no forms: the compiler ships this document complete.</p>
`);
  fs.writeFileSync(path.join(tpBuf, 'src', 'pages', 'plain.rose'), `<script>
  let n = $state(0);
</script>

${bufHead.replace('buffered nonce', 'plain head')}

<h1>plain route</h1>
<button data-on-click="n++">clicked ${'${n}'} times</button>
<p>the default policy, no stamping.</p>
`);
  const tpBufBuilt = await run(['build'], tpBuf);
  assert(tpBufBuilt.code === 0 && !/render failed/.test(tpBufBuilt.err), `the buffered nonce fixture builds cleanly (stderr: ${tpBufBuilt.err.slice(0, 200)})`);
  const bufPort = await takePort(0);
  const bufProc = spawn(process.execPath, [...TSX, 'serve'], { cwd: tpBuf, env: { ...process.env, PORT: String(bufPort), ROSEFN_WORKERS: '1' } });
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${bufPort}/`); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    const bres = await fetch(`http://localhost:${bufPort}/`);
    const bhtml = await bres.text();
    const bnonce = /'nonce-([^']+)'/.exec(bres.headers.get('content-security-policy') ?? '')?.[1];
    assert(!!bnonce, 'the buffered route answers a nonce policy');
    assert(bhtml.includes('window.__loader'), 'the buffered document carries the inline script literally');
    const inline = /<script[^>]*>window\.__loader[^<]*<\/script>/.exec(bhtml)?.[0] ?? '';
    assert(inline.includes(`nonce="${bnonce}"`), 'the inline head script carries the header nonce');
    const external = /<script[^>]*src="\/vendor\/x\.js"[^>]*>/.exec(bhtml)?.[0] ?? '';
    assert(external.includes(`nonce="${bnonce}"`), 'the external head script carries the nonce too');
    const jsonld = /<script[^>]*type="application\/ld\+json"[^>]*>/.exec(bhtml)?.[0] ?? '';
    assert(jsonld.includes(`nonce="${bnonce}"`), 'a non-executed script type is stamped too (harmless, and uniform)');
    const bnonces = [...bhtml.matchAll(/nonce="([^"]+)"/g)].map((m) => m[1]);
    assert(bnonces.every((n) => n === bnonce), 'every stamped tag carries the one nonce, nothing else');
    const pres = await fetch(`http://localhost:${bufPort}/plain`);
    const phtml = await pres.text();
    const pcsp = pres.headers.get('content-security-policy') ?? '';
    assert(/script-src 'sha256-/.test(pcsp), 'the hashed route answers a sha256 policy');
    assert(!/<script[^>]*\snonce=/.test(phtml), "the hashed route's document carries no nonce-stamped tag");
  } finally {
    bufProc.kill();
  }
}

{
  const waDir = path.join(tmp, 'warn-agg');
  fs.mkdirSync(path.join(waDir, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(waDir, 'src', 'pages', '_layout.rose'), `<script>
  // the admin chrome wires itself from public/admin.js; this block only
  // mirrors the current section for the server-rendered nav
  const here = () => location.pathname;
  function syncNav() { document.title = 'admin'; }
</script>

<nav><a href="/a">a</a> <a href="/b">b</a></nav>
<slot />
`);
  for (const name of ['a', 'b', 'c', 'd']) {
    fs.writeFileSync(path.join(waDir, 'src', 'pages', `${name}.rose`), `<h1>${name}</h1>\n<p>zero-JS by the compiler's verdict.</p>\n`);
  }
  fs.writeFileSync(path.join(waDir, 'src', 'pages', 'e.rose'), `<script>
  function boot() { window.__e = 1; }
</script>

<h1>e</h1>
`);
  const waBuilt = await run(['build'], waDir);
  assert(waBuilt.code === 0 && !/render failed/.test(waBuilt.err), `the aggregation fixture builds cleanly (stderr: ${waBuilt.err.slice(0, 200)})`);
  const warnLines = waBuilt.err.split('\n').filter((l) => l.includes('Rosefn warning:'));
  assert(warnLines.length === 1, `one line per reason, not one per route per file (got ${warnLines.length}: ${warnLines.join(' | ').slice(0, 300)})`);
  assert(/5 routes ship zero JavaScript while their chain contains browser-only code/.test(waBuilt.err), 'the line names how many routes the cause reaches');
  assert(waBuilt.err.includes('src/pages/_layout.rose (5 routes)'), 'the widest-reaching file is named with its route count');
  assert(waBuilt.err.includes('src/pages/e.rose (/e)'), 'a single-route file is named with its route');
  for (const r of ['/a', '/b', '/c', '/d', '/e']) {
    assert(new RegExp(`${r}\\s+zero-JS`).test(waBuilt.out), `${r} still reports zero-JS`);
  }
}

{
  const udDir = path.join(tmp, 'unknown-directives');
  fs.mkdirSync(path.join(udDir, 'src', 'pages'), { recursive: true });
  const fail = async (name, body, expect) => {
    fs.writeFileSync(path.join(udDir, 'src', 'pages', 'index.rose'), body);
    const r = await run(['build'], udDir);
    assert(r.code !== 0, `${name}: the build fails instead of shipping broken code`);
    assert(r.err.includes(expect), `${name}: the failure names the construct (got: ${r.err.split('\n').find((l) => l.includes(name === 'a closer that closes nothing' ? 'does not close' : 'rosefn'))?.slice(0, 160) ?? r.err.slice(0, 160)})`);
    assert(/\.rose:\d+/.test(r.err), `${name}: the failure carries the file and the line`);
  };
  {
    fs.writeFileSync(path.join(udDir, 'src', 'pages', 'index.rose'), `<script>\n  let ok = $state(false);\n</script>\n<h1>x</h1>\n{#if ok}<span>yes</span>\n{:else}\n<span>no</span>\n{/if}\n`);
    const elseBuilt = await run(['build'], udDir);
    assert(elseBuilt.code === 0 && !/render failed/.test(elseBuilt.err), `an {:else} chain builds as F2 complementary ifs (stderr: ${elseBuilt.err.slice(0, 200)})`);
    const elsePort = await takePort(0);
    const elseProc = spawn(process.execPath, [...TSX, 'serve'], { cwd: udDir, env: { ...process.env, PORT: String(elsePort), ROSEFN_WORKERS: '1' } });
    try {
      for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${elsePort}/`); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
      const elseHtml = await (await fetch(`http://localhost:${elsePort}/`)).text();
      assert(elseHtml.includes('<span>no</span>') && !elseHtml.includes('<span>yes</span>'), 'the {:else} branch renders the complement of the condition');
    } finally {
      elseProc.kill();
    }
  }
  {
    fs.writeFileSync(path.join(udDir, 'src', 'pages', 'index.rose'), `<script>\n  let rows = $state([]);\n</script>\n<ul>{#each rows as r}<li>{r}</li>{:else}<li class="none">nothing yet</li>{/each}</ul>\n`);
    const eeBuilt = await run(['build'], udDir);
    assert(eeBuilt.code === 0 && !/render failed/.test(eeBuilt.err), `an each-else builds cleanly (stderr: ${eeBuilt.err.slice(0, 200)})`);
    const eePort = await takePort(0);
    const eeProc = spawn(process.execPath, [...TSX, 'serve'], { cwd: udDir, env: { ...process.env, PORT: String(eePort), ROSEFN_WORKERS: '1' } });
    try {
      for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${eePort}/`); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
      const eeHtml = await (await fetch(`http://localhost:${eePort}/`)).text();
      assert(eeHtml.includes('nothing yet') && !eeHtml.includes('<li>{r}</li>'), 'the empty-list {:else} branch renders');
    } finally {
      eeProc.kill();
    }
  }
  await fail('a template with {:then}', `<h1>x</h1>\n{#if ok}<span>yes</span>{:then}<span>no</span>{/if}\n`, 'with no {#await} above it');
  await fail('a template with {/else}', `<h1>x</h1>\n{#if ok}<span>yes</span>{/else}\n`, 'does not close anything');
  await fail('an {#each} with no item name', `<p>{#each rows}</p>\n`, 'missing its item name');
  await fail('an unclosed {#if}', `<p>{#if ok}<span>yes</span></p>\n`, 'unclosed {#if}');
  await fail('an unclosed {#each}', `<p>{#each rows as r}<span>{r}</span></p>\n`, 'unclosed {#each}');
  {
    fs.writeFileSync(path.join(udDir, 'src', 'pages', 'index.rose'), `<script>\n  let ok = $state(true);\n</script>\n\n<!-- a note: {#if never} this is prose {/if} -->\n{#if ok}<p>shown</p>{/if}\n`);
    const noteBuilt = await run(['build'], udDir);
    assert(noteBuilt.code === 0 && !/render failed/.test(noteBuilt.err), `a comment mentioning a block builds cleanly (stderr: ${noteBuilt.err.slice(0, 200)})`);
    const notePort = await takePort(0);
    const noteProc = spawn(process.execPath, [...TSX, 'serve'], { cwd: udDir, env: { ...process.env, PORT: String(notePort), ROSEFN_WORKERS: '1' } });
    try {
      for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${notePort}/`); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
      const noteRes = await fetch(`http://localhost:${notePort}/`);
      const noteHtml = await noteRes.text();
      assert(noteRes.status === 200 && noteHtml.includes('<p>shown</p>'), 'the page renders with its comment intact');
      assert(noteHtml.includes('<!-- a note: {#if never} this is prose {/if} -->'), 'the comment rides the document verbatim');
    } finally {
      noteProc.kill();
    }
  }
  fs.writeFileSync(path.join(udDir, 'src', 'pages', 'index.rose'), `<script>
  let on = $state(true);
  const cfg = { ':else': 1, other: 2 };
</script>

<h1>{on ? 'on' : 'off'}</h1>
<div style="background:{on ? 'rgba(79,70,229,.15)' : 'var(--panel)'};">styled</div>
<a href="/x?a=1&amp;b=2">link</a>
<script type="application/ld+json">{"@type":"Thing","x":{"a":1}}</script>
<p>{cfg[':else']}</p>
`);
  const okBuilt = await run(['build'], udDir);
  assert(okBuilt.code === 0 && !/render failed/.test(okBuilt.err), `the legal shapes still build (stderr: ${okBuilt.err.slice(0, 200)})`);
  const okPort = await takePort(0);
  const okProc = spawn(process.execPath, [...TSX, 'serve'], { cwd: udDir, env: { ...process.env, PORT: String(okPort), ROSEFN_WORKERS: '1' } });
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${okPort}/`); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    const okHtml = await (await fetch(`http://localhost:${okPort}/`)).text();
    assert(okHtml.includes('<script type="application/ld+json">{"@type":"Thing","x":{"a":1}}</script>'), 'the body\'s JSON-LD block rides the document verbatim');
    assert(okHtml.includes('rgba(79,70,229,.15)') && !okHtml.includes('var(--panel)'), 'the ternary attribute still resolves (its value rides the patch markers)');
    assert(!/class="<!--/.test(okHtml) && !/href="[^"]*<!--/.test(okHtml), 'no reactive marker ever lands inside an attribute value');
  } finally {
    okProc.kill();
  }
}

{
  const caDir = path.join(tmp, 'catch-all');
  fs.mkdirSync(path.join(caDir, 'src', 'pages', 'blog'), { recursive: true });
  fs.mkdirSync(path.join(caDir, 'src', 'pages', 'api', 'plugin', '[slug]'), { recursive: true });
  fs.writeFileSync(path.join(caDir, 'src', 'pages', '[[...slug]].rose'), `<script>\n  let slug = $state([]);\n</script>\n\n<h1>root</h1>\n<p>segments: {slug().join('/') || '(none)'}</p>\n`);
  fs.writeFileSync(path.join(caDir, 'src', 'pages', 'blog', '[id].rose'), `<script>\n  let id = $state('');\n</script>\n\n<h1>post</h1>\n<p>id: {id()}</p>\n`);
  fs.writeFileSync(path.join(caDir, 'src', 'pages', 'blog', '[...rest].rose'), `<script>\n  let rest = $state([]);\n</script>\n\n<h1>rest</h1>\n<p>rest: {rest().join('/')}</p>\n`);
  fs.writeFileSync(path.join(caDir, 'src', 'pages', 'api', 'plugin', '[slug]', '[...path].rose'), `<script>\n  export async function GET(request) {\n    const parts = new URL(request.url).pathname.split('/').filter(Boolean);\n    return { plugin: parts[2], path: parts.slice(3).join('/') };\n  }\n</script>\n`);
  const caBuilt = await run(['build'], caDir);
  assert(caBuilt.code === 0 && !/render failed/.test(caBuilt.err), `the catch-all fixture builds cleanly (stderr: ${caBuilt.err.slice(0, 200)})`);
  const caPort = await takePort(0);
  const caProc = spawn(process.execPath, [...TSX, 'serve'], { cwd: caDir, env: { ...process.env, PORT: String(caPort), ROSEFN_WORKERS: '1' } });
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${caPort}/`); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    const text = async (u) => (await (await fetch(`http://localhost:${caPort}${u}`)).text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    assert((await text('/')).includes('segments: (none)'), 'the optional catch-all matches the parent path (/) with an empty array');
    assert((await text('/hello')).includes('segments: hello'), 'the optional catch-all matches one segment');
    assert((await text('/a/b/c')).includes('segments: a/b/c'), 'the optional catch-all absorbs many segments into the array');
    assert((await text('/blog/7')).includes('id: 7'), 'a specific param route wins over the root catch-all (specificity order)');
    assert((await text('/blog/x/y')).includes('rest: x/y'), 'a prefixed catch-all absorbs the tail');
    const api = await fetch(`http://localhost:${caPort}/api/plugin/seo-schema/sitemap.xml`);
    assert(api.status === 200, 'the api catch-all gateway answers 200');
    assert(JSON.stringify(await api.json()) === '{"plugin":"seo-schema","path":"sitemap.xml"}', 'the api gateway route splits its param and its tail');
    const noTail = await fetch(`http://localhost:${caPort}/api/plugin/x`);
    assert(noTail.status === 404, 'a catch-all with no tail to absorb does not match (404, not a crash)');
  } finally {
    caProc.kill();
  }
  fs.writeFileSync(path.join(caDir, 'src', 'pages', 'blog', '[...rest].rose'), `<script>\n  let rest = $state([]);\n  export const params = { rest: ['docs/start', 'docs/advanced/config'] };\n</script>\n\n<h1>rest</h1>\n<p>rest: {rest().join('/')}</p>\n`);
  const caBaked = await run(['build'], caDir);
  assert(caBaked.code === 0, `the catch-all with params builds (stderr: ${caBaked.err.slice(0, 200)})`);
  assert(fs.existsSync(path.join(caDir, 'dist', 'blog', 'docs', 'start', 'index.html')), 'a multi-segment catch-all value bakes to its nested path');
  assert(fs.existsSync(path.join(caDir, 'dist', 'blog', 'docs', 'advanced', 'config', 'index.html')), 'a deeper catch-all value bakes too');
}

{
  const sigDir = path.join(tmp, 'signals');
  fs.mkdirSync(path.join(sigDir, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(sigDir, 'src', 'pages', 'index.rose'), `<h1>home</h1>\n<a href="/gone">gone</a>\n<a href="/moved">moved</a>\n`);
  fs.writeFileSync(path.join(sigDir, 'src', 'pages', 'gone.rose'), `<script>\n  $data(() => { notFound(); });\n</script>\n\n<p>never rendered</p>\n`);
  fs.writeFileSync(path.join(sigDir, 'src', 'pages', 'moved.rose'), `<script>\n  $data(() => { redirect('/'); });\n</script>\n\n<p>never rendered</p>\n`);
  fs.writeFileSync(path.join(sigDir, 'src', 'pages', 'login.rose'), `<script>\n  export async function action() { redirect('/', 303); }\n</script>\n\n<form method="POST"><button>go</button></form>\n`);
  fs.writeFileSync(path.join(sigDir, 'src', 'pages', '404.rose'), `<h1>app 404</h1>\n<p>this url has no content</p>\n`);
  const sigBuilt = await run(['build'], sigDir);
  assert(sigBuilt.code === 0 && !/render failed/.test(sigBuilt.err), `the signal fixture builds cleanly (stderr: ${sigBuilt.err.slice(0, 200)})`);
  assert(/dynamic route \/gone/.test(sigBuilt.out) && /dynamic route \/moved/.test(sigBuilt.out) && /dynamic route \/login/.test(sigBuilt.out), 'a route calling redirect()/notFound() is dynamic by construction (never baked)');
  const sigPort = await takePort(0);
  const sigProc = spawn(process.execPath, [...TSX, 'serve'], { cwd: sigDir, env: { ...process.env, PORT: String(sigPort), ROSEFN_WORKERS: '1' } });
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${sigPort}/`); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    const gone = await fetch(`http://localhost:${sigPort}/gone`);
    const goneHtml = await gone.text();
    assert(gone.status === 404, `notFound() answers a real 404 (got ${gone.status})`);
    assert(goneHtml.includes('app 404') && goneHtml.includes('this url has no content'), "notFound() renders the app's own 404 route");
    const moved = await fetch(`http://localhost:${sigPort}/moved`, { redirect: 'manual' });
    assert(moved.status === 307 && moved.headers.get('location') === '/', `redirect() answers a 30x with the Location (got ${moved.status} ${moved.headers.get('location')})`);
    assert((await moved.text()).includes('Redirecting'), 'the redirect carries a small HTML body for a no-JS visitor');
    const posted = await fetch(`http://localhost:${sigPort}/login`, { method: 'POST', redirect: 'manual' });
    assert(posted.status === 303 && posted.headers.get('location') === '/', `an action's redirect answers 303 (got ${posted.status} ${posted.headers.get('location')})`);
  } finally {
    sigProc.kill();
  }
}

{
  const tsDir = path.join(tmp, 'trailing-slash');
  fs.mkdirSync(path.join(tsDir, 'src', 'pages', 'admin'), { recursive: true });
  fs.writeFileSync(path.join(tsDir, 'src', 'pages', 'index.rose'), '<h1>home</h1>\n');
  fs.writeFileSync(path.join(tsDir, 'src', 'pages', 'admin', 'index.rose'), '<h1>dash</h1>\n');
  const tsBuilt = await run(['build'], tsDir);
  assert(tsBuilt.code === 0 && !/render failed/.test(tsBuilt.err), `the fixture builds cleanly (stderr: ${tsBuilt.err.slice(0, 200)})`);
  const tsMod = await import(pathToFileURL(path.join(tsDir, 'dist', 'server.js')).href);
  assert(tsMod.matchRoute('/admin', '/admin/') === true, 'matchRoute: /admin/ matches /admin');
  assert(tsMod.matchRoute('/admin', '/admin//') === true, 'matchRoute: repeated slashes collapse');
  assert(tsMod.matchRoute('/', '/') === true && tsMod.matchRoute('/', '//') === true, 'matchRoute: the root stays the root');
  assert(tsMod.matchRoute('/:id', '/x/') === true, 'matchRoute: a param segment tolerates the slash');
  assert(tsMod.matchRoute('/**slug', '/a/b/') === true, 'matchRoute: a catch-all absorbs the slashed tail');
  assert(tsMod.matchRoute('/a', '/b/') === false, 'matchRoute: the slash never makes a wrong route match');
  const tsClient = fs.readFileSync(path.join(tsDir, 'dist', 'client.js'), 'utf8');
  assert(/\.replace\(\/\\\/\+\$/.test(tsClient), 'the client bundle normalizes the trailing slash too');
  const tsPort = await takePort(0);
  const tsProc = spawn(process.execPath, [...TSX, 'serve'], { cwd: tsDir, env: { ...process.env, PORT: String(tsPort), ROSEFN_WORKERS: '1' } });
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${tsPort}/`); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    const bare = await fetch(`http://localhost:${tsPort}/admin`);
    assert(bare.status === 200, `the bare path still answers 200 (got ${bare.status})`);
    const slash = await fetch(`http://localhost:${tsPort}/admin/`, { redirect: 'manual' });
    assert(slash.status === 308, `the slashed path answers 308 (got ${slash.status})`);
    assert(slash.headers.get('location') === '/admin', `the Location is the bare path (got ${slash.headers.get('location')})`);
    const q = await fetch(`http://localhost:${tsPort}/admin/?tab=posts&x=1`, { redirect: 'manual' });
    assert(q.headers.get('location') === '/admin?tab=posts&x=1', `the query rides along (got ${q.headers.get('location')})`);
    const root = await fetch(`http://localhost:${tsPort}/`);
    assert(root.status === 200, `the root is exempt (got ${root.status})`);
    const followed = await fetch(`http://localhost:${tsPort}/admin/`);
    assert(followed.status === 200 && (await followed.text()).includes('dash'), 'following the redirect lands on the route');
  } finally {
    tsProc.kill();
  }
}

{
  const gDir = path.join(tmp, 'guard-scan');
  fs.mkdirSync(path.join(gDir, 'src', 'pages'), { recursive: true });
  const warnOn = async (name, script, expect) => {
    fs.writeFileSync(path.join(gDir, 'src', 'pages', '_layout.rose'), `<script>\n${script}</script>\n\n<slot />\n`);
    fs.writeFileSync(path.join(gDir, 'src', 'pages', 'index.rose'), '<p>home</p>\n');
    const r = await run(['build'], gDir);
    assert(r.code === 0, `${name}: the build succeeds (stderr: ${r.err.slice(0, 160)})`);
    const warns = /browser-only code/.test(r.err);
    assert(warns === expect, `${name}: ${expect ? 'warns' : 'stays silent'} (got ${warns ? 'a warning' : 'silence'})`);
  };
  await warnOn('the isomorphic ternary', 'function p() {\n  return typeof window !== "undefined" ? window.location.pathname : String(getContext().pathname || "");\n}\n', false);
  await warnOn('the && guard', 'function t() { return typeof document !== "undefined" && document.title; }\n', false);
  await warnOn('the if-block guard', 'if (typeof window !== "undefined") {\n  window.scrollTo(0, 0);\n}\n', false);
  await warnOn('the === alternate', 'const p = typeof window === "undefined" ? "s" : window.location.href;\n', false);
  await warnOn('browser code in a !== else', 'if (typeof window !== "undefined") {\n  var b = 1;\n} else {\n  var w = window.x;\n}\n', true);
  await warnOn('browser code in a === consequent', 'if (typeof window === "undefined") {\n  var t = document.title;\n}\n', true);
  await warnOn('unguarded browser code', 'const p = window.location.pathname;\n', true);
  await warnOn('a guard inside a string literal', 'const doc = "typeof window !== \\"undefined\\" ? a : b";\nconst p = window.location.pathname;\n', true);
  await warnOn('a quote-carrying regex before the guards', 'function esc(v) {\n  return String(v).replace(/[&<>"\']/g, (c) => ({ "&": "&amp;" }[c]));\n}\nfunction q() {\n  return typeof window !== "undefined" ? new URLSearchParams(window.location.search) : getContext().query;\n}\n', false);
  await warnOn('the same regex, then UNGUARDED code', 'function esc(v) {\n  return String(v).replace(/[&<>"\']/g, (c) => ({ "&": "&amp;" }[c]));\n}\nconst p = window.location.pathname;\n', true);
  fs.writeFileSync(path.join(gDir, 'src', 'pages', '_layout.rose'), `<script>\n  function here() {\n    return typeof window !== "undefined" ? window.location.pathname : "srv:" + String(getContext().pathname || "");\n  }\n</script>\n\n<p>at {here()}</p>\n<slot />\n`);
  const gBuilt = await run(['build'], gDir);
  assert(gBuilt.code === 0 && !/browser-only code/.test(gBuilt.err), `the guarded layout builds silently (stderr: ${gBuilt.err.slice(0, 200)})`);
  const gMod = await import(pathToFileURL(path.join(gDir, 'dist', 'server.js')).href);
  const gPage = await gMod.renderPage('/');
  assert(gPage.status === 200 && gPage.html.includes('at <!--\u27e6m:0\u27e7-->srv:'), `the guarded layout renders through the server branch (status ${gPage.status}, html: ${gPage.html.slice(0, 120)})`);
}

{
  const nfDir = path.join(tmp, 'segment-notfound');
  fs.mkdirSync(path.join(nfDir, 'src', 'pages', 'admin', 'posts'), { recursive: true });
  fs.writeFileSync(path.join(nfDir, 'src', 'pages', '_layout.rose'), '<header>PUBLIC-CHROME</header>\n<slot />\n');
  fs.writeFileSync(path.join(nfDir, 'src', 'pages', '404.rose'), '<h1>ROOT-404</h1>\n');
  fs.writeFileSync(path.join(nfDir, 'src', 'pages', 'index.rose'), '<h1>home</h1>\n');
  fs.writeFileSync(path.join(nfDir, 'src', 'pages', 'admin', '_layout.rose'), '<header>ADMIN-CHROME</header>\n<slot />\n');
  fs.writeFileSync(path.join(nfDir, 'src', 'pages', 'admin', '_notfound.rose'), '<h1>ADMIN-404</h1>\n');
  fs.writeFileSync(path.join(nfDir, 'src', 'pages', 'admin', 'index.rose'), '<h1>admin home</h1>\n');
  fs.writeFileSync(path.join(nfDir, 'src', 'pages', 'admin', 'posts', '_notfound.rose'), '<h1>POSTS-404</h1>\n');
  fs.writeFileSync(path.join(nfDir, 'src', 'pages', 'admin', 'posts', '[id].rose'), `<script>\n  let id = $state('1');\n  $data(() => { if (id() === '9') notFound(); });\n</script>\n{#if id() === '1'}<h1>post 1</h1>{/if}\n`);
  const nfBuilt = await run(['build'], nfDir);
  assert(nfBuilt.code === 0 && !/render failed/.test(nfBuilt.err), `the fixture builds cleanly (stderr: ${nfBuilt.err.slice(0, 200)})`);
  const nfMod = await import(pathToFileURL(path.join(nfDir, 'dist', 'server.js')).href);
  const miss = await nfMod.renderPage('/nope');
  assert(miss.status === 404 && miss.html.includes('ROOT-404') && miss.html.includes('PUBLIC-CHROME'), `a public miss answers the root 404 in the public chrome (got ${miss.status})`);
  const adminMiss = await nfMod.renderPage('/admin/nope');
  assert(adminMiss.status === 404 && adminMiss.html.includes('ADMIN-404') && adminMiss.html.includes('ADMIN-CHROME') && !adminMiss.html.includes('ROOT-404'), 'an admin miss answers the segment 404 in the ADMIN chrome');
  const deepMiss = await nfMod.renderPage('/admin/posts/a/b');
  assert(deepMiss.status === 404 && deepMiss.html.includes('POSTS-404') && deepMiss.html.includes('ADMIN-CHROME'), 'the deepest segment wins (a nested _notfound.rose beats its parent)');
  const home = await nfMod.renderPage('/');
  assert(home.status === 200 && home.html.includes('home'), 'the home route still renders');
  const nfClient = fs.readFileSync(path.join(nfDir, 'dist', 'client.js'), 'utf8');
  assert(nfClient.includes('/admin/posts') && nfClient.includes('ROOT-404'), 'the client bundle carries the segment table');
  const nfPort = await takePort(0);
  const nfProc = spawn(process.execPath, [...TSX, 'serve'], { cwd: nfDir, env: { ...process.env, PORT: String(nfPort), ROSEFN_WORKERS: '1' } });
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${nfPort}/`); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    const thrown = await fetch(`http://localhost:${nfPort}/admin/posts/9`);
    const thrownHtml = await thrown.text();
    assert(thrown.status === 404 && thrownHtml.includes('POSTS-404'), `a notFound() thrown under a segment answers that segment's 404 (got ${thrown.status})`);
    const httpMiss = await fetch(`http://localhost:${nfPort}/admin/nope`);
    assert(httpMiss.status === 404 && (await httpMiss.text()).includes('ADMIN-404'), 'the server answers the segment 404 over HTTP too');
    const publicMiss = await fetch(`http://localhost:${nfPort}/nope`);
    assert(publicMiss.status === 404 && (await publicMiss.text()).includes('ROOT-404'), 'the public miss still answers the root 404');
  } finally {
    nfProc.kill();
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nAll CLI checks passed - the framework builds any project, not just its own demo - ${checks} assertions.`);
