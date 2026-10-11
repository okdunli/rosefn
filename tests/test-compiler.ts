/**
 * Compiler regression tests - pure compileComponent checks that need no
 * server. Run: tsx tests/test-compiler.ts (after the example build, like
 * test-client).
 *
 * F1 regression: braceDepthAt must skip regex literals. A build-plugin
 * preamble carrying /[&<>"']/g before a $data declaration used to desync the
 * brace counter (the " inside the regex opened a phantom string), the decl
 * was misjudged as nested and hoisted past its readers - TDZ at runtime.
 */
import { compileComponent, scopeCss } from '../src/compiler/index.ts';
import path from 'node:path';
import fs from 'node:fs';

let failures = 0;
(globalThis as any).__rvLoad = (key: string) => ({ counts: { n: 1 }, key });
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log('ok -', name);
  else { failures++; console.log('FAIL -', name, detail); }
}

function safeRm(p: string, opts: { recursive?: boolean } = {}): void {
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(p, { force: true, ...opts }); return; }
    catch (e) {
      if (i === 9) throw e;
      const wait = 50 * (i + 1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}

const tmp = path.join(process.cwd(), '.test-compiler-tmp.rose');
const PREAMBLE_WITH_REGEX = `<script>
function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function __rvLoad(k){return {counts:{n:1}};}
</script>`;

const page = (body: string) => `<script>
${PREAMBLE_WITH_REGEX.match(/<script>([\s\S]*?)<\/script>/)![1]}
${body}
</script>
<head><title>t</title></head>
<div>ok</div>`;

const cases: Array<[string, string]> = [
  ['decl read after regex preamble', page(`
  let st = $data(() => __rvLoad("k", {}));
  const direct = st().counts;
  function counts() { return direct ? direct : st().counts; }`)],
  ['decl read after regex preamble ($state)', page(`
  let items = $state(['a', 'b']);
  const first = items()[0];`)],
  ['defer hold=N compiles to setTimeout flip', `<script>
  let st = $data(() => __rvLoad("k", {}));
  function counts() { return st().counts; }
</script>
<head><title>t</title></head>
<div>{#defer hold=800}<p>HELD</p>{/defer}</div>`],
  ['defer block compiles to skeleton + client flip', `<script>
  let st = $data(() => __rvLoad("k", {}));
  function counts() { return st().counts; }
</script>
<head><title>t</title></head>
<div>{#defer}<p>DEFERRED</p>{/defer}</div>`],
  ['await block compiles to pending SSR + client flip', `<script>
  function loadUsers() { return Promise.resolve(['a', 'b']); }
</script>
<head><title>t</title></head>
<div>{#await loadUsers()}<p>loading</p>{:then list}<ul>{#each list as u}<li>{u}</li>{/each}</ul>{:catch err}<p class="err">error</p>{/await}</div>`],
  ['await block without catch compiles', `<script>
  function go() { return Promise.resolve(42); }
</script>
<head><title>t</title></head>
<div>{#await go()}<p>wait</p>{:then n}<p>got {n}</p>{/await}</div>`],
  ['division after call stays division', page(`
  let n = $state(4);
  const half = n() / 2;`)],
];

fs.mkdirSync('.test-compiler-out', { recursive: true });
for (const [name, src] of cases) {
  fs.writeFileSync(tmp, src, 'utf-8');
  try {
    const out: any = await compileComponent(tmp, path.join(process.cwd(), 'public'), 'tc', false, [], new Map());
    const ssr: string = out.ssr || '';
    const iDecl = Math.min(...['const [st, setSt]', 'const [items, setItems]', 'const [n, setN]'].map((m) => { const i = ssr.indexOf(m); return i < 0 ? Number.MAX_SAFE_INTEGER : i; }));
    const readNeedles = ['st().counts', "items()[0]", 'n() / 2'];
    const iRead = Math.min(...readNeedles.map((m) => { const i = ssr.indexOf(m); return i < 0 ? Number.MAX_SAFE_INTEGER : i; }));
    if (name.startsWith('defer block')) {
      const dormant = !/DEFER_ENABLED = true/.test(
        fs.readFileSync('./src/compiler/index.ts', 'utf-8'),
      );
      const client: string = out.client || '';
      if (dormant) {
        check(`${name} (dormant: content static)`, ssr.includes('DEFERRED'), 'content missing');
        check(`${name} (dormant: no skeleton)`, !ssr.includes('rv-defer-loading'), 'skeleton leaked while dormant');
        check(`${name} (dormant: no boot)`, !client.includes('__rvDefer1'), 'boot code leaked while dormant');
      } else {
        check(`${name} (ssr skeleton)`, ssr.includes('rv-defer-loading'), 'no skeleton in ssr');
        check(`${name} (client flip)`, /__rvDefer1/.test(client) && /set__rvDefer1\(true\)/.test(client) && client.includes('DEFERRED'), 'client missing defer boot/content');
        fs.mkdirSync('.test-compiler-tmp', { recursive: true });
        fs.writeFileSync('.test-compiler-tmp/runtime.ts', 'export * from "../src/runtime/index.ts";', 'utf-8');
        const modPath = '.test-compiler-tmp/page.ssr.ts';
        fs.writeFileSync(modPath, out.ssr, 'utf-8');
        const mod = await import('./' + modPath.replace(/\\/g, '/'));
        const html = String(await mod.render([], [], {}, {}));
        check(`${name} (rendered ssr hides content)`, !html.includes('DEFERRED'), 'deferred content rendered server-side');
        check(`${name} (rendered ssr has skeleton)`, html.includes('rv-defer-loading'), 'skeleton missing from render');
        fs.rmSync(modPath, { force: true });
        fs.rmSync('.test-compiler-tmp/runtime.ts', { force: true });
      }
        } else if (name.startsWith('await block')) {
        const clientA: string = out.client || '';
        check(`${name} (ssr pending marker)`, ssr.includes('loading') || ssr.includes('wait'), 'no pending branch in ssr');
        check(`${name} (client flip code)`, /__rvAwait1/.test(clientA) && clientA.includes('Promise.resolve') && clientA.includes('set__rvAwait1('), 'client missing await boot code');
        check(`${name} (client carries then/catch)`, clientA.includes('error') || clientA.includes('got'), 'then/catch body missing from client');
        const tmpAwait = '.test-compiler-await';
        fs.mkdirSync(tmpAwait, { recursive: true });
        fs.writeFileSync(path.join(tmpAwait, 'runtime.ts'), 'export * from "../src/runtime/index.ts";', 'utf-8');
        const modPathA = path.join(tmpAwait, 'await-page.ssr.ts');
        fs.writeFileSync(modPathA, out.ssr, 'utf-8');
        const modA = await import('./' + modPathA.replace(/\\/g, '/'));
        const htmlA = String(await modA.render([], [], {}, {}));
        check(`${name} (rendered ssr shows pending)`, htmlA.includes('loading') || htmlA.includes('wait'), 'pending not in rendered html');
        check(`${name} (rendered ssr hides then/catch)`, !htmlA.includes('error') && !htmlA.includes('got'), 'then/catch leaked into server render');
        safeRm(modPathA);
        safeRm(path.join(tmpAwait, 'runtime.ts'));
        safeRm(tmpAwait, { recursive: true });
        } else {
      check(`${name} (ssr order)`, iDecl < Number.MAX_SAFE_INTEGER && iRead > iDecl, `decl@${iDecl} read@${iRead}`);
    }
    check(`${name} (compiles clean)`, ssr.length > 100);
    if (name === 'defer hold=N compiles to setTimeout flip') {
      const client: string = (out as any).client || '';
      check('defer hold: setTimeout 800 in client', client.includes('setTimeout') && client.includes('800'));
    }
  } catch (e) {
    check(name, false, String(e).slice(0, 120));
  }
}
safeRm(tmp);
safeRm('.test-compiler-out', { recursive: true });

if (failures) {
  console.log(`${failures} compiler test(s) failed`);
  process.exit(1);
}
{
  const fsImg = await import('fs');
  const pathImg = await import('path');
  const tmpImg = pathImg.join('.test-compiler-out', 'img-defaults.rose');
  fsImg.mkdirSync('.test-compiler-out', { recursive: true });
  fsImg.writeFileSync(tmpImg, `<div>
  <img src="/a.png" alt="a">
  <img src="/b.png" alt="b" loading="eager">
</div>`, 'utf-8');
  const out: any = await compileComponent(tmpImg, pathImg.join(process.cwd(), 'public'), 'tc-img', false, [], new Map());
  const ssr: string = out.ssr || '';
  const lazyCount = (ssr.match(/loading=/g) || []).length;
  check('img defaults: lazy + async added to bare img', lazyCount >= 2 && ssr.includes('decoding='));
  check('img defaults: explicit eager preserved', ssr.includes('eager') && ssr.split('loading=').length - 1 === 2);
}

{
  const fsImg = await import('fs');
  const pathImg = await import('path');
  const osImg = await import('os');
  const tmpPub = fsImg.mkdtempSync(pathImg.join((await import('os')).tmpdir(), 'rv-pub-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  fsImg.writeFileSync(pathImg.join(tmpPub, 'c.png'), png);
  const tmpImg2 = pathImg.join('.test-compiler-out', 'img-dims.rose');
  fsImg.writeFileSync(tmpImg2, `<div>
  <img src="/c.png" alt="c">
  <img src="/c.png" alt="c2" width="10" height="20">
</div>`, 'utf-8');
  const out2: any = await compileComponent(tmpImg2, tmpPub, 'tc-imgd', false, [], new Map());
  const ssr2: string = out2.ssr || '';
  const W = (n: string) => new RegExp(`width=\\\\?"?${n}"?`).test(ssr2);
  const H = (n: string) => new RegExp(`height=\\\\?"?${n}"?`).test(ssr2);
  check('img dims: width/height injected from header', W('1') && H('1'));
  check('img dims: author width/height win', W('10') && H('20'));
  fsImg.rmSync(tmpPub, { recursive: true, force: true });
}

{
  const fsS = await import('fs');
  const pathS = await import('path');
  const tmpPub = fsS.mkdtempSync(pathS.join((await import('os')).tmpdir(), 'rv-ss-'));
  const png1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const big = Buffer.concat([png1, Buffer.alloc(8192)]);
  fsS.writeFileSync(pathS.join(tmpPub, 'd.png'), big);
  fsS.writeFileSync(pathS.join(tmpPub, 'd.w800.png'), png1);
  fsS.writeFileSync(pathS.join(tmpPub, 'd.w400.png'), png1);
  fsS.writeFileSync(pathS.join(tmpPub, 'e.png'), big);
  const tmpSS = pathS.join('.test-compiler-out', 'img-srcset.rose');
  fsS.mkdirSync('.test-compiler-out', { recursive: true });
  fsS.writeFileSync(tmpSS, `<div>
  <img src="/d.png" alt="d">
  <img src="/d.png" alt="da" srcset="/d.w1600.png 1600w">
  <img src="/e.png" alt="e">
</div>`, 'utf-8');
  const outS: any = await compileComponent(tmpSS, tmpPub, 'tc-srcset', false, [], new Map());
  const ssrS: string = outS.ssr || '';
  check('A4 srcset: sorted variants emitted', ssrS.includes('srcset=\\"/d.w400.png 400w, /d.w800.png 800w\\"'));
  check('A4 srcset: author srcset untouched', ssrS.includes('srcset=\\"/d.w1600.png 1600w\\"') && (ssrS.match(/srcset=/g) || []).length === 2);
  const at = ssrS.indexOf('/e.png');
  const eTag = at >= 0 ? ssrS.slice(ssrS.lastIndexOf('<img', at), ssrS.indexOf('>', at) + 1) : '';
  check('A4 srcset: no variants = no attribute', eTag.length > 0 && !eTag.includes('srcset'));
  safeRm(tmpSS);
  fsS.rmSync(tmpPub, { recursive: true, force: true });
}

{
  const fsT = await import('fs');
  const pathT = await import('path');
  const tmpT = pathT.join('.test-compiler-out', 'each-bridge.rose');
  fsT.mkdirSync('.test-compiler-out', { recursive: true });
  fsT.writeFileSync(tmpT, `<div>
  {#each globalThis.__rosefnContent.list("docs") as d}<li>{d.title}</li>{/each}
</div>`, 'utf-8');
  (globalThis as any).__rosefnContent = { get: () => null, list: () => ([{ title: 'A' }, { title: 'B' }]), mk: () => '' };
  const outT: any = await compileComponent(tmpT, pathT.join(process.cwd(), 'public'), 't22', false, [], new Map());
  fsT.mkdirSync('.test-compiler-tmp', { recursive: true });
  fsT.writeFileSync('.test-compiler-tmp/runtime.ts', 'export * from "../src/runtime/index.ts";', 'utf-8');
  fsT.writeFileSync('.test-compiler-tmp/t22-page.ssr.ts', outT.ssr, 'utf-8');
  const modT = await import('./.test-compiler-tmp/t22-page.ssr.ts');
  const htmlT = String(await modT.render([], [], {}, {}));
  check('T22: {#each} over globalThis bridge renders items', htmlT.includes('A') && htmlT.includes('B'));
  safeRm(tmpT);
  safeRm('.test-compiler-tmp', { recursive: true });
  delete (globalThis as any).__rosefnContent;
}

{
  const fsI = await import('fs');
  const pathI = await import('path');
  const tmpI = pathI.join('.test-compiler-out', 'island.rose');
  fsI.mkdirSync('.test-compiler-out', { recursive: true });
  fsI.writeFileSync(tmpI, `<script>
  let who = $state('World');
  let count = $state(0);
  function inc() { count(count() + 1); }
</script>
<head><title>Islands</title></head>
<div>
  <p>STATIC OUTSIDE</p>
  {#island name="counter"}
    <p>Hello {who()}!</p>
    <p>Count: {count()}</p>
    <button on:click={inc}>Inc</button>
  {/island}
  <p>ALSO STATIC OUTSIDE</p>
</div>`, 'utf-8');
  const outI: any = await compileComponent(tmpI, pathI.join(process.cwd(), 'public'), 'isl', false, [], new Map());
  const ssrI: string = outI.ssr || '';
  fsI.mkdirSync('.test-compiler-tmp', { recursive: true });
  fsI.writeFileSync('.test-compiler-tmp/runtime.ts', 'export * from "../src/runtime/index.ts";', 'utf-8');
  fsI.writeFileSync('.test-compiler-tmp/island-page.ssr.ts', ssrI, 'utf-8');
  const modI = await import('./.test-compiler-tmp/island-page.ssr.ts');
  const htmlI = String(await modI.render([], [], {}, {}));
  check('T3 islands: wrapper div emitted', htmlI.includes('data-rv-island="counter"'));
  const before = htmlI.split('data-rv-island')[0];
  check('T3 islands: outside content static (no markers)', before.includes('STATIC OUTSIDE') && !before.includes('⟦'));
  check('T3 islands: inside content reactive (markers + handler)', htmlI.includes('⟦') && htmlI.includes('data-on-click'));
  safeRm(tmpI);
  safeRm('.test-compiler-tmp', { recursive: true });
}

{
  const pathI = await import('path');
  const fsI = await import('fs');
  fsI.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpH = pathI.join('.test-compiler-out', 'island-h.rose');
  fsI.writeFileSync(tmpH, `<script>
  let n = $state(0);
  function bump() { $setState('n', n() + 1); }
</script>
<p>STATIC</p>
{#island name="a" hydrate="visible"}
  <p>{n()}</p><button on:click={bump}>+</button>
{/island}
{#island name="b" hydrate="idle"}
  <p>{n()}</p>
{/island}
{#island name="c" hydrate="bogus"}
  <p>{n()}</p>
{/island}`, 'utf-8');
  const outH: any = await compileComponent(tmpH, pathI.join(process.cwd(), 'public'), 'islh', false, [], new Map());
  fsI.mkdirSync('.test-compiler-tmp', { recursive: true });
  fsI.writeFileSync('.test-compiler-tmp/runtime.ts', 'export * from "../src/runtime/index.ts";', 'utf-8');
  fsI.writeFileSync('.test-compiler-tmp/island-h.ssr.ts', outH.ssr, 'utf-8');
  const modH = await import('./.test-compiler-tmp/island-h.ssr.ts');
  const htmlH = String(await modH.render([], [], {}, {}));
  check('T3b islands: hydrate=visible carried on wrapper', htmlH.includes('data-rv-island="a" data-rv-island-hydrate="visible"'));
  check('T3b islands: hydrate=idle carried on wrapper', htmlH.includes('data-rv-island="b" data-rv-island-hydrate="idle"'));
  check('T3b islands: unknown hydrate dropped (immediate)', htmlH.includes('data-rv-island="c">') && !htmlH.includes('data-rv-island-hydrate="bogus"'));
  safeRm(tmpH);
  safeRm('.test-compiler-tmp', { recursive: true });
}

{
  const fsB = await import('fs');
  const pathB = await import('path');
  fsB.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpB = pathB.join('.test-compiler-out', 'bind.rose');
  fsB.writeFileSync(tmpB, `<script>
  let q = $state('');
  let on = $state(false);
  function flip() { $setState('on', !on()); }
</script>
<div>
  <input bind:value={q}>
  <p>{q()}</p>
  <input type="checkbox" bind:checked={on}>
  <p>{on() ? 'on' : 'off'}</p>
  <button on:click={flip}>flip</button>
</div>`, 'utf-8');
  const outB: any = await compileComponent(tmpB, pathB.join(process.cwd(), 'public'), 'bindpage', false, [], new Map());
  const srcB: string = String(outB.client ?? outB.ssr ?? '');
  check('F1 bind: reactive value attr + data-b emitted', /value=\\"?"?\(\) => \(q\(\)\)/.test(srcB) || srcB.includes('attrMark') && srcB.includes("() => (q())") && srcB.includes("'value'"));
  check('F1 bind: synthetic input handler writes state', srcB.includes('(e) => { const t = e.target; const raw = t.type === \'number\' || t.type === \'range\' ? t.valueAsNumber : t.value; setQ(typeof raw === \'number\' && Number.isNaN(raw) ? null : raw); }'));
  check('F1 bind: checked rides boolAttrMark', /boolAttrMark\(__c, \(\) => \(on\(\)\), 'checked'\)/.test(srcB));
  check('F1 bind: change handler for checked', srcB.includes('(e) => setOn(e.target.checked)'));
  safeRm(tmpB);

  const tmpBad = pathB.join('.test-compiler-out', 'bind-bad.rose');
  fsB.writeFileSync(tmpBad, `<div><input bind:value={nope}></div>`, 'utf-8');
  let threw = '';
  try { await compileComponent(tmpBad, pathB.join(process.cwd(), 'public'), 'bindbad', false, [], new Map()); }
  catch (e) { threw = (e as Error).message; }
  check('F1 bind: non-state target fails at the .rose file', threw.includes('must name a $state declaration'));
  safeRm(tmpBad);

  const tmpBool = pathB.join('.test-compiler-out', 'bool-attr.rose');
  fsB.writeFileSync(tmpBool, `<script>let off = $state(false);</script>
<div><input type="checkbox" checked={off}></div>`, 'utf-8');
  const outBool: any = await compileComponent(tmpBool, pathB.join(process.cwd(), 'public'), 'boolattr', false, [], new Map());
  const ssrBool = String(outBool.ssr ?? '');
  check('F1 boolean attr: no checked="false" in SSR', !ssrBool.includes('checked=\\\\"false\\\\"') && !ssrBool.includes('checked="false"'));
  safeRm(tmpBool);
}

{
  const fsE = await import('fs');
  const pathE = await import('path');
  fsE.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpE = pathE.join('.test-compiler-out', 'else.rose');
  fsE.writeFileSync(tmpE, `<script>
  let eon = $state(true);
  let en = $state(2);
</script>
<div>
  <p>{#if eon}ON{:else}OFF{/if}</p>
  <p>{#if en === 1}one{:else if en === 2}two{:else}many{/if}</p>
</div>`, 'utf-8');
  const outE: any = await compileComponent(tmpE, pathE.join(process.cwd(), 'public'), 'elsepage', false, [], new Map());
  fsE.mkdirSync('.test-compiler-tmp', { recursive: true });
  fsE.writeFileSync('.test-compiler-tmp/runtime.ts', 'export * from "../src/runtime/index.ts";', 'utf-8');
  fsE.writeFileSync('.test-compiler-tmp/else-page.ssr.ts', outE.ssr, 'utf-8');
  const modE = await import('./.test-compiler-tmp/else-page.ssr.ts');
  const html1 = String(await modE.render([], [], {}, {}));
  check('F2 else: true branch renders, else hidden', html1.includes('ON') && !html1.includes('>OFF') && html1.includes('two'));
  const rt = await import('./.test-compiler-tmp/runtime.ts');
  rt.setState('eon', false);
  rt.setState('en', 5);
  const html2 = String(await modE.render([], [], {}, {}));
  check('F2 else: flipped state renders the else branch', html2.includes('OFF') && html2.includes('many'));
  check('F2 else: source shows complementary negation', String(outE.ssr).includes('!('));
  safeRm(tmpE);
  safeRm('.test-compiler-tmp', { recursive: true });
}

{
  const fsI2 = await import('fs');
  const pathI2 = await import('path');
  fsI2.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpEI = pathI2.join('.test-compiler-out', 'each-index.rose');
  fsI2.writeFileSync(tmpEI, `<script>
  let idxRows = $state(['a', 'b']);
  let on = $state(true);
  let big = $state(false);
</script>
<ul>{#each idxRows as r, i}<li>{i}: {r}</li>{/each}</ul>
<p class="btn" class:active={on} class:big={big}>x</p>`, 'utf-8');
  const outEI: any = await compileComponent(tmpEI, pathI2.join(process.cwd(), 'public'), 'eachidx', false, [], new Map());
  fsI2.mkdirSync('.test-compiler-tmp', { recursive: true });
  fsI2.writeFileSync('.test-compiler-tmp/runtime.ts', 'export * from "../src/runtime/index.ts";', 'utf-8');
  fsI2.writeFileSync('.test-compiler-tmp/each-index.ssr.ts', outEI.ssr, 'utf-8');
  const modEI = await import('./.test-compiler-tmp/each-index.ssr.ts');
  const htmlEI = String(await modEI.render([], [], {}, {})).replace(/<!--\u27e6[^>]*\u27e7-->/g, '');
  check('F2d each-index: positions rendered', htmlEI.includes('0: a') && htmlEI.includes('1: b'));
  check('F2d class:: static + true segment, false segment absent', /class="[^"]*btn[^"]*active[^"]*"/.test(htmlEI) && !htmlEI.includes('big'));
  const rtI = await import('./.test-compiler-tmp/runtime.ts');
  rtI.setState('on', false);
  const htmlEI2 = String(await modEI.render([], [], {}, {})).replace(/<!--\u27e6[^>]*\u27e7-->/g, '');
  check('F2d class:: flipped state drops the segment', !/\bactive\b/.test(htmlEI2) && htmlEI2.includes('btn'));
  safeRm(tmpEI);
  safeRm('.test-compiler-tmp', { recursive: true });
}

{
  const fsS2 = await import('fs');
  const pathS2 = await import('path');
  fsS2.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpS2 = pathS2.join('.test-compiler-out', 'style-each.rose');
  fsS2.writeFileSync(tmpS2, `<script>
  let scolor = $state('blue');
  let srows = $state([]);
  let sfull = $state(['x']);
</script>
<div>
  <p style="color: red" style:color={scolor}>t</p>
  {#each srows as r}<li>{r}</li>{:else}<li class="empty">none</li>{/each}
  {#each sfull as f}<li>{f}</li>{:else}<li>none</li>{/each}
</div>`, 'utf-8');
  const outS2: any = await compileComponent(tmpS2, pathS2.join(process.cwd(), 'public'), 'styleeach', false, [], new Map());
  fsS2.mkdirSync('.test-compiler-tmp', { recursive: true });
  fsS2.writeFileSync('.test-compiler-tmp/runtime.ts', 'export * from "../src/runtime/index.ts";', 'utf-8');
  fsS2.writeFileSync('.test-compiler-tmp/style-each.ssr.ts', outS2.ssr, 'utf-8');
  const modS2 = await import('./.test-compiler-tmp/style-each.ssr.ts');
  const strip = (h: string) => h.replace(/<!--\u27e6[^>]*\u27e7-->/g, '');
  const htmlS1 = strip(String(await modS2.render([], [], {}, {})));
  check('F2f style:: override appended after static', /style="[^"]*color:\s*red;?\s*color:\s*blue[^"]*"/.test(htmlS1));
  check('F2f each-else: empty list renders the else branch', htmlS1.includes('none') && !htmlS1.includes('<li></li>'));
  const rtS2 = await import('./.test-compiler-tmp/runtime.ts');
  rtS2.setState('srows', ['r1']);
  const htmlS2 = strip(String(await modS2.render([], [], {}, {})));
  check('F2f each-else: non-empty list drops the else branch', htmlS2.includes('r1') && !htmlS2.includes('none'));
  safeRm(tmpS2);
  safeRm('.test-compiler-tmp', { recursive: true });
}

{
  const fsM = await import('fs');
  const pathM = await import('path');
  fsM.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpM = pathM.join('.test-compiler-out', 'mods.rose');
  fsM.writeFileSync(tmpM, `<script>
  let n = $state(0);
  let q = $state('');
  async function save() {}
</script>
<div>
  <form on:submit|preventDefault={save}><input bind:value={n} type="number"></form>
  <form on:submit|preventDefault|stopPropagation={() => {}}></form>
</div>`, 'utf-8');
  const outM: any = await compileComponent(tmpM, pathM.join(process.cwd(), 'public'), 'modspage', false, [], new Map());
  const srcM: string = String(outM.client ?? outM.ssr ?? '');
  check('F3 mods: preventDefault wraps the named handler', srcM.includes('(e) => { e.preventDefault(); (save)(e); }'));
  check('F3 mods: both modifiers compose', srcM.includes('e.preventDefault(); e.stopPropagation(); (() => {})(') || srcM.includes('e.stopPropagation(); (() => {})('));
  check('F3 numeric bind: valueAsNumber coercion', srcM.includes("t.type === 'number' || t.type === 'range' ? t.valueAsNumber : t.value"));
  safeRm(tmpM);
  const tmpBad = pathM.join('.test-compiler-out', 'mods-bad.rose');
  fsM.writeFileSync(tmpBad, `<div on:click|explode={() => {}}>x</div>`, 'utf-8');
  let threwM = '';
  try { await compileComponent(tmpBad, pathM.join(process.cwd(), 'public'), 'modsbad', false, [], new Map()); }
  catch (e) { threwM = (e as Error).message; }
  check('F3 mods: unknown modifier fails at the .rose file', threwM.includes('unknown event modifier |explode'));
  safeRm(tmpBad);
}

{
  const fsK = await import('fs');
  const pathK = await import('path');
  fsK.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpK = pathK.join('.test-compiler-out', 'keyed.rose');
  fsK.writeFileSync(tmpK, `<script>
  let subject = $state('a');
</script>
<div>
  {#key subject}<p class="kv">subject: {subject}</p>{/key}
</div>`, 'utf-8');
  const outK: any = await compileComponent(tmpK, pathK.join(process.cwd(), 'public'), 'keypage', false, [], new Map());
  fsK.mkdirSync('.test-compiler-tmp', { recursive: true });
  fsK.writeFileSync('.test-compiler-tmp/runtime.ts', 'export * from "../src/runtime/index.ts";', 'utf-8');
  fsK.writeFileSync('.test-compiler-tmp/keyed.ssr.ts', outK.ssr, 'utf-8');
  const modK = await import('./.test-compiler-tmp/keyed.ssr.ts');
  const htmlK1 = String(await modK.render([], [], {}, {})).replace(/<!--\u27e6[^>]*\u27e7-->/g, '');
  check('F4 key: body renders from the expression', htmlK1.includes('subject: a'));
  const rtK = await import('./.test-compiler-tmp/runtime.ts');
  rtK.setState('subject', 'b');
  const htmlK2 = String(await modK.render([], [], {}, {})).replace(/<!--\u27e6[^>]*\u27e7-->/g, '');
  check('F4 key: rebuilds when the expression changes', htmlK2.includes('subject: b'));
  check('F4 key: desugars through eachMark', String(outK.ssr).includes('eachMark') && String(outK.ssr).includes('['));
  safeRm(tmpK);
  const tmpK2 = pathK.join('.test-compiler-out', 'keyed-bad.rose');
  fsK.writeFileSync(tmpK2, `<div>{#key on}<p>x</p></div>`, 'utf-8');
  let threwK = '';
  try { await compileComponent(tmpK2, pathK.join(process.cwd(), 'public'), 'keybad', false, [], new Map()); }
  catch (e) { threwK = (e as Error).message; }
  check('F4 key: unclosed key fails loud', threwK.includes('is never closed'));
  safeRm(tmpK2);
}

{
  const fsU = await import('fs');
  const pathU = await import('path');
  fsU.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpU = pathU.join('.test-compiler-out', 'use.rose');
  fsU.writeFileSync(tmpU, `<script>
  directives.tooltip = (el) => { el.title = 'tip'; };
</script>
<div><span use:tooltip>hover</span></div>`, 'utf-8');
  const outU: any = await compileComponent(tmpU, pathU.join(process.cwd(), 'public'), 'usepage', false, [], new Map());
  const srcU = String(outU.ssr ?? '');
  check('F5 use: data-use attribute emitted', srcU.includes('data-use=\\"tooltip\\"') || srcU.includes('data-use="tooltip"'));
  check('F5 use: script can register via directives', String(outU.client ?? outU.ssr ?? '').includes('directives.tooltip'));
  safeRm(tmpU);
  const tmpU2 = pathU.join('.test-compiler-out', 'use-param.rose');
  fsU.writeFileSync(tmpU2, `<script>
  directives.tip = (el, p) => { el.title = String(p); return { update: (np) => { el.title = String(np); } }; };
  let who = $state('a');
</script>
<div><span use:tip={who}>x</span></div>`, 'utf-8');
  const outU2: any = await compileComponent(tmpU2, pathU.join(process.cwd(), 'public'), 'useparam', false, [], new Map());
  const srcU2 = String(outU2.ssr ?? '');
  check('F5b use: reactive param compiled', srcU2.includes('data-use-param={JSON.stringify(who())}') || srcU2.includes('data-use-param=\\\"') || srcU2.includes('data-use-param'));
  check('F5b use: param reaches the action as JSON', srcU2.includes('JSON.stringify(who())'));
  safeRm(tmpU2);
}

{
  const fsSp = await import('fs');
  const pathSp = await import('path');
  fsSp.mkdirSync('.test-compiler-out', { recursive: true });
  const cardP = pathSp.resolve('.test-compiler-out', 'card.rose');
  fsSp.writeFileSync(cardP, `<p class="card">{title}</p>`, 'utf-8');
  const registrySp = new Map([[cardP, { index: 0, scopeKey: 'components/card', slots: [] }]]);
  await compileComponent(cardP, pathSp.join(process.cwd(), 'public'), 'components/card', false, [], registrySp);
  const pageP = pathSp.resolve('.test-compiler-out', 'spread-page.rose');
  fsSp.writeFileSync(pageP, `<script>
  import Card from './card.rose';
  let rest = $state({ tone: 'dark' });
</script>
<Card {...rest} title="Hi"></Card>`, 'utf-8');
  const outSp: any = await compileComponent(pageP, pathSp.join(process.cwd(), 'public'), 'spreadpage', false, [], registrySp);
  const srcSp = String(outSp.ssr ?? '');
  check('F6 spread: object spread emitted into the props literal', /\.\.\.\(rest\)/.test(srcSp) && srcSp.includes('"title"'));
  safeRm(cardP);
  safeRm(pageP);
}

{
  const fsF = await import('fs');
  const pathF = await import('path');
  fsF.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpF = pathF.resolve('.test-compiler-out', 'fallback.rose');
  fsF.writeFileSync(tmpF, `<div>
  <slot name="rows">No rows yet</slot>
  <slot>default body</slot>
</div>`, 'utf-8');
  const outF: any = await compileComponent(tmpF, pathF.join(process.cwd(), 'public'), 'fbpage', false, [], new Map());
  const srcF = String(outF.ssr ?? '');
  check('F7 slot: named fallback rides __slotBlock', srcF.includes('"No rows yet"') && srcF.includes('__slotBlock'));
  check('F7 slot: unnamed fallback rides __slotDefault', srcF.includes('__slotDefault(children, "default body")'));
  safeRm(tmpF);
  const tmpF2 = pathF.resolve('.test-compiler-out', 'fallback-bad.rose');
  fsF.writeFileSync(tmpF2, `<div><slot name="x">count: {n}</slot></div>`, 'utf-8');
  let threwF = '';
  try { await compileComponent(tmpF2, pathF.join(process.cwd(), 'public'), 'fbpagebad', false, [], new Map()); }
  catch (e) { threwF = (e as Error).message; }
  check('F7 slot: reactive fallback rejected with the hint', threwF.includes('fallback content must be static'));
  safeRm(tmpF2);
}

{
  const fsS = await import('fs');
  const pathS = await import('path');
  fsS.mkdirSync('.test-compiler-out', { recursive: true });
  const cardS = pathS.resolve('.test-compiler-out', 'slots-card.rose');
  fsS.writeFileSync(cardS, `<div class="card"><slot name="a">fallback</slot></div>`, 'utf-8');
  const regS = new Map([[cardS, { index: 0, scopeKey: 'components/slots-card', slots: [{ name: 'a', props: [] }] }]]);
  await compileComponent(cardS, pathS.join(process.cwd(), 'public'), 'components/slots-card', false, [], regS);

  const pageS = pathS.resolve('.test-compiler-out', 'slots-nested.rose');
  fsS.writeFileSync(pageS, `<script>
  import Card from './slots-card.rose';
  let show = $state(true);
  let slotted = $state('SLOTTED_UNIQUE');
</script>
<Card>
  {#if show}
    <p slot="a">{slotted}</p>
  {/if}
</Card>`, 'utf-8');
  const outS: any = await compileComponent(pageS, pathS.join(process.cwd(), 'public'), 'slotsnested', false, [], regS);
  const srcS = String(outS.ssr ?? '');
  check('F21 slot: nested-in-if lifted into named slot closure', srcS.includes('"a": (__s, __c)') && srcS.includes('slotted()') && !srcS.includes('slot="a"'));
  check('F21 slot: block gate preserved on the lifted wrapper', srcS.includes('show()'));
  safeRm(cardS);
  safeRm(pageS);

  const cardE = pathS.resolve('.test-compiler-out', 'slots-card-e.rose');
  fsS.writeFileSync(cardE, `<div class="card"><slot name="a">fallback</slot></div>`, 'utf-8');
  const regE = new Map([[cardE, { index: 0, scopeKey: 'components/slots-card-e', slots: [{ name: 'a', props: [] }] }]]);
  await compileComponent(cardE, pathS.join(process.cwd(), 'public'), 'components/slots-card-e', false, [], regE);
  const pageE = pathS.resolve('.test-compiler-out', 'slots-wrap.rose');
  fsS.writeFileSync(pageE, `<script>
  import Card from './slots-card-e.rose';
</script>
<Card><div><p slot="a">x</p></div></Card>`, 'utf-8');
  let threwE = '';
  try { await compileComponent(pageE, pathS.join(process.cwd(), 'public'), 'slotse', false, [], regE); }
  catch (e) { threwE = (e as Error).message; }
  check('F21 slot: wrapper-element nesting still rejected', threwE.includes('must be a direct child'));
  safeRm(cardE);
  safeRm(pageE);
}

{
  const fsG = await import('fs');
  const pathG = await import('path');
  fsG.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpG = pathG.join('.test-compiler-out', 'group.rose');
  fsG.writeFileSync(tmpG, `<script>
  let plan = $state('free');
</script>
<div>
  <input type="radio" name="plan" value="free" bind:group={plan}>
  <input type="radio" name="plan" value="pro" bind:group={plan}>
</div>`, 'utf-8');
  const outG: any = await compileComponent(tmpG, pathG.join(process.cwd(), 'public'), 'grouppage', false, [], new Map());
  const srcG = String(outG.client ?? outG.ssr ?? '');
  check('F6b group: checked comparison + change handler emitted', srcG.includes('plan() === "free"') && srcG.includes('(e) => { setPlan(e.target.value); }'));
  safeRm(tmpG);
  const tmpG2 = pathG.resolve('.test-compiler-out', 'group-bad.rose');
  fsG.writeFileSync(tmpG2, `<script>let plan = $state('free');</script>
<div><input type="text" bind:group={plan}></div>`, 'utf-8');
  let threwG = '';
  try { await compileComponent(tmpG2, pathG.join(process.cwd(), 'public'), 'groupbad', false, [], new Map()); }
  catch (e) { threwG = (e as Error).message; }
  check('F6b group: non-radio fails with the radio hint', threwG.includes('bind:group is for radio and checkbox inputs'));
  safeRm(tmpG2);
}

{
  const fsM2 = await import('fs');
  const pathM2 = await import('path');
  fsM2.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpM2 = pathM2.join('.test-compiler-out', 'multi-attr.rose');
  fsM2.writeFileSync(tmpM2, `<script>
  let hv = $state('/a');
  let tv = $state('T1');
</script>
<div><a href={hv} title={tv}>link</a></div>`, 'utf-8');
  const outM2: any = await compileComponent(tmpM2, pathM2.join(process.cwd(), 'public'), 'multiattr', false, [], new Map());
  fsM2.mkdirSync('.test-compiler-tmp', { recursive: true });
  fsM2.writeFileSync('.test-compiler-tmp/runtime.ts', 'export * from "../src/runtime/index.ts";', 'utf-8');
  fsM2.writeFileSync('.test-compiler-tmp/multi-attr.ssr.ts', outM2.ssr, 'utf-8');
  const modM2 = await import('./.test-compiler-tmp/multi-attr.ssr.ts');
  const htmlM2 = String(await modM2.render([], [], {}, {}));
  check('F8b multi-attr: both markers emitted with distinct names', /data-b0="href"/.test(htmlM2) && /data-b1="title"/.test(htmlM2));
  const domM2 = new (await import('jsdom')).JSDOM(htmlM2);
  const aM2 = domM2.window.document.querySelector('a');
  const namesM2 = aM2 ? aM2.getAttributeNames().filter((n) => n.startsWith('data-b')) : [];
  check('F8b multi-attr: both markers survive the HTML parse', namesM2.length === 2);
  safeRm(tmpM2);
  safeRm('.test-compiler-tmp', { recursive: true });
}

{
  const fsP = await import('fs');
  const pathP = await import('path');
  fsP.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpP = pathP.resolve('.test-compiler-out', 'persist.rose');
  fsP.writeFileSync(tmpP, `<script>
  let theme = $persist('light');
</script>
<div><p class="pv">{theme}</p></div>`, 'utf-8');
  const outP: any = await compileComponent(tmpP, pathP.join(process.cwd(), 'public'), 'persistpage', false, [], new Map());
  const srcP = String(outP.ssr ?? '');
  check('F9 persist: decl compiles through persistState', srcP.includes('persistState("theme"'));
  safeRm(tmpP);
}

{
  const fsBF = await import('fs');
  const pathBF = await import('path');
  fsBF.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpBF = pathBF.resolve('.test-compiler-out', 'bfb.rose');
  fsBF.writeFileSync(tmpBF, `<script>
  function boom() { throw new Error('widget broke'); }
</script>
{#boundary}
  <p class="ok">widget ok {boom()}</p>
{:fallback}
  <p class="fb">widget failed gracefully: {$boundaryError()?.message}</p>
{/boundary}`, 'utf-8');
  const outBF: any = await compileComponent(tmpBF, pathBF.join(process.cwd(), 'public'), 'bfbpage', false, [], new Map());
  fsBF.mkdirSync('.test-compiler-tmp', { recursive: true });
  fsBF.writeFileSync('.test-compiler-tmp/runtime.ts', 'export * from "../src/runtime/index.ts";', 'utf-8');
  fsBF.writeFileSync('.test-compiler-tmp/bfb.ssr.ts', outBF.ssr, 'utf-8');
  const modBF = await import('./.test-compiler-tmp/bfb.ssr.ts');
  const htmlBF = String(await modBF.render([], [], {}, {}));
  check('F11 boundary: custom fallback renders on throw', htmlBF.includes('widget failed gracefully') && !htmlBF.includes('widget ok'));
  check('F12 boundary: the caught error is readable via $boundaryError', htmlBF.includes('widget broke'));
  check('F11 boundary: fallback compiled as its own block', String(outBF.ssr).includes('__bf'));
  safeRm(tmpBF);
  safeRm('.test-compiler-tmp', { recursive: true });
  const tmpBF2 = pathBF.resolve('.test-compiler-out', 'bfb-bad.rose');
  fsBF.writeFileSync(tmpBF2, `<div>{#boundary}{#if on}<p>x</p>{:fallback}<p>y</p>{/if}{/boundary}</div>`, 'utf-8');
  let threwBF = '';
  try { await compileComponent(tmpBF2, pathBF.join(process.cwd(), 'public'), 'bfpagebad', false, [], new Map()); }
  catch (e) { threwBF = (e as Error).message; }
  check('F11 boundary: nested {:fallback} fails with the move-it hint', threwBF.includes('must sit directly inside a {#boundary}'));
  safeRm(tmpBF2);
}

{
  const fsC = await import('fs');
  const pathC = await import('path');
  fsC.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpC = pathC.resolve('.test-compiler-out', 'const.rose');
  fsC.writeFileSync(tmpC, `<script>
  let items = $state([{ name: 'a', price: 10 }, { name: 'b', price: 20 }]);
  let rate = $state(1.1);
</script>
{@const top = rate() * 2}
<p>top: {top}</p>
<ul>
{#each items as item}
  {@const total = item.price * rate()}
  <li>{item.name}: {total}</li>
{/each}
</ul>`, 'utf-8');
  const outC: any = await compileComponent(tmpC, pathC.join(process.cwd(), 'public'), 'constpage', false, [], new Map());
  fsC.mkdirSync('.test-compiler-tmp', { recursive: true });
  fsC.writeFileSync('.test-compiler-tmp/runtime.ts', 'export * from "../src/runtime/index.ts";', 'utf-8');
  fsC.writeFileSync('.test-compiler-tmp/const.ssr.ts', outC.ssr, 'utf-8');
  const modC = await import('./.test-compiler-tmp/const.ssr.ts');
  const htmlC = String(await modC.render([], [], {}, {}));
  check('F13 @const: top-level binding resolves', htmlC.includes('2.2'));
  check('F13 @const: per-item binding inside {#each} resolves', htmlC.includes('>11<') && htmlC.includes('>22<'));
  check('F13 @const: emitted as a const in the render fn', String(outC.ssr).includes('const top = (rate() * 2)'));
  safeRm(tmpC);
  safeRm('.test-compiler-tmp', { recursive: true });
}

{
  const fsD = await import('fs');
  const pathD = await import('path');
  fsD.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpD = pathD.resolve('.test-compiler-out', 'destr.rose');
  fsD.writeFileSync(tmpD, `<script>
  let items = $state([{ name: 'a', price: 10 }, { name: 'b', price: 20 }]);
  let pairs = $state([['x', 1], ['y', 2]]);
</script>
<ul>
{#each items as {name, price}}
  <li>{name}: {price}</li>
{/each}
</ul>
<dl>
{#each pairs as [k, v]}
  <dt>{k}</dt><dd>{v}</dd>
{/each}
</dl>`, 'utf-8');
  const outD: any = await compileComponent(tmpD, pathD.join(process.cwd(), 'public'), 'destrpage', false, [], new Map());
  fsD.mkdirSync('.test-compiler-tmp', { recursive: true });
  fsD.writeFileSync('.test-compiler-tmp/runtime.ts', 'export * from "../src/runtime/index.ts";', 'utf-8');
  fsD.writeFileSync('.test-compiler-tmp/destr.ssr.ts', outD.ssr, 'utf-8');
  const modD = await import('./.test-compiler-tmp/destr.ssr.ts');
  const htmlD = String(await modD.render([], [], {}, {}));
  check('F14 each destructuring: object pattern renders both rows', htmlD.includes('>a<') && htmlD.includes('>10<') && htmlD.includes('>b<') && htmlD.includes('>20<'));
  check('F14 each destructuring: array pattern renders both pairs', htmlD.includes('>x<') && htmlD.includes('>1<') && htmlD.includes('>y<') && htmlD.includes('>2<'));
  check('F14 each destructuring: pattern declared in the block fn', String(outD.ssr).includes('const {name, price} = __s;') && String(outD.ssr).includes('const [k, v] = __s;'));
  safeRm(tmpD);
  safeRm('.test-compiler-tmp', { recursive: true });
}

{
  const fsE = await import('fs');
  const pathE = await import('path');
  fsE.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpE = pathE.resolve('.test-compiler-out', 'ref.rose');
  fsE.writeFileSync(tmpE, `<script>
  let box = $state(null);
</script>
<div bind:this={box}>panel</div>`, 'utf-8');
  const outE: any = await compileComponent(tmpE, pathE.join(process.cwd(), 'public'), 'refpage', false, [], new Map());
  check('F15 bind:this: emits the data-bind-this marker', /data-bind-this[=]["\\]*box/.test(String(outE.ssr)));
  check('F15 bind:this: no event handler is attached', !/data-on-(input|change)=/.test(String(outE.ssr)));
  safeRm(tmpE);
  const tmpE2 = pathE.resolve('.test-compiler-out', 'ref-bad.rose');
  fsE.writeFileSync(tmpE2, `<script>
  let box = $state(null);
</script>
<div bind:this={notDeclared}>panel</div>`, 'utf-8');
  let threwE = '';
  try { await compileComponent(tmpE2, pathE.join(process.cwd(), 'public'), 'refpagebad', false, [], new Map()); }
  catch (e) { threwE = (e as Error).message; }
  check('F15 bind:this: a non-$state name is refused', threwE.includes('must name a $state declaration'));
  safeRm(tmpE2);
}

{
  const fsF = await import('fs');
  const pathF = await import('path');
  fsF.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpF = pathF.resolve('.test-compiler-out', 'mods2.rose');
  fsF.writeFileSync(tmpF, `<script>
  function hit() {}
</script>
<div on:click|self={hit}>a</div>
<span on:click|once={hit}>b</span>`, 'utf-8');
  const outF: any = await compileComponent(tmpF, pathF.join(process.cwd(), 'public'), 'mods2page', false, [], new Map());
  const srcF: string = String(outF.client ?? outF.ssr ?? '');
  check('F16 mods: |self guards on the bound element', srcF.includes('if (__self && e.target !== __self) return;'));
  check('F16 mods: |once unbinds after the first run', srcF.includes("removeAttribute('data-on-' + e.type)"));
  safeRm(tmpF);
  const tmpF2 = pathF.resolve('.test-compiler-out', 'mods2-bad.rose');
  fsF.writeFileSync(tmpF2, `<script>
  function hit() {}
</script>
<div on:click|passive={hit}>a</div>`, 'utf-8');
  let threwF = '';
  try { await compileComponent(tmpF2, pathF.join(process.cwd(), 'public'), 'mods2bad', false, [], new Map()); }
  catch (e) { threwF = (e as Error).message; }
  check('F16 mods: a listener-option modifier is refused with the reason', threwF.includes('unknown event modifier |passive'));
  safeRm(tmpF2);
}

{
  const fsG = await import('fs');
  const pathG = await import('path');
  fsG.mkdirSync('.test-compiler-out', { recursive: true });
  const tmpG = pathG.resolve('.test-compiler-out', 'dbg.rose');
  fsG.writeFileSync(tmpG, `<script>
  let n = $state(5);
</script>
<p>x</p>
{@debug n}
{@debug}`, 'utf-8');
  const outG: any = await compileComponent(tmpG, pathG.join(process.cwd(), 'public'), 'dbgpage', false, [], new Map());
  const srcG = String(outG.ssr);
  check('F19 @debug: logs the named values at that point', /console\.log\('\[rosefn:debug\]', \{ n\(\) \}\);/.test(srcG));
  check('F19 @debug: bare form also breaks into the debugger', srcG.includes("console.log('[rosefn:debug]'); debugger;"));
  check('F19 @debug: emits nothing into the output', !srcG.includes('rosefn:debug]') || !/<p>x<\/p>\\s*rosefn/.test(srcG));
  safeRm(tmpG);
}

{
  const out = scopeCss(
    '.card :global(.md) { color: red }\n:global(body) { margin: 0 }\n.plain { color: blue }',
    'demo',
  );
  check('F27: mixed :global keeps the owning half scoped, the rest unscoped', out.includes('[data-rosefn-c="demo"] .card .md{color:red}'), out);
  check('F27: an all-:global selector emits without the scope prefix', /(^|[}])body\{margin:0\}/.test(out), out);
  check('F27: plain selectors still scope', out.includes('[data-rosefn-c="demo"] .plain{color:blue}'), out);
}

if (failures > 0) {
  console.error(`\n${failures} compiler check(s) FAILED`);
  process.exit(1);
}
console.log('All compiler pipeline checks passed');