import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PwaOptions {
  name: string;
  shortName?: string;
  description?: string;
  themeColor?: string;
  backgroundColor?: string;
  startUrl?: string;
  display?: string;
  icon?: string;
  precache?: string[];
  offlineFallback?: string;
}

export function buildManifest(opts: PwaOptions): string {
  const manifest = {
    name: opts.name,
    short_name: opts.shortName ?? opts.name,
    description: opts.description ?? '',
    start_url: opts.startUrl ?? '/',
    display: opts.display ?? 'standalone',
    background_color: opts.backgroundColor ?? '#ffffff',
    theme_color: opts.themeColor ?? '#000000',
    icons: opts.icon
      ? [{ src: opts.icon, sizes: 'any', type: 'image/png', purpose: 'any' }]
      : [],
  };
  return JSON.stringify(manifest, null, 2);
}

export function buildServiceWorker(opts: PwaOptions, precache: string[]): string {
  const cache = 'rosefn-sw-v1';
  const list = JSON.stringify(
    [...new Set(['/', ...precache, opts.offlineFallback].filter(Boolean) as string[])],
  );
  return `const CACHE='${cache}';const PRECACHE=${list};
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(PRECACHE)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);if(u.origin!==location.origin)return;
if(PRECACHE.includes(u.pathname)){e.respondWith(caches.match(r).then(c=>c||fetch(r).then(resp=>{const cp=resp.clone();caches.open(CACHE).then(c=>c.put(r,cp));return resp;})););return;}
e.respondWith(fetch(r).then(resp=>{const cp=resp.clone();caches.open(CACHE).then(c=>c.put(r,cp));return resp;}).catch(()=>caches.match(r).then(c=>c||caches.match('${opts.offlineFallback ?? '/'}'))));});`;
}

function collectAssets(outDir: string, extra?: string[]): string[] {
  const out = new Set<string>(extra ?? []);
  const walk = (d: string, rel: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'sw.js' || e.name.endsWith('.br')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, rel + e.name + '/');
      else if (/\.(js|css|html)$/.test(e.name)) out.add('/' + (rel + e.name).split(path.sep).join('/'));
    }
  };
  try { walk(outDir, ''); } catch { /* no assets */ }
  return [...out];
}

export async function generatePWA(outDir: string, opts: PwaOptions): Promise<string[]> {
  const manifestPath = path.join(outDir, 'manifest.webmanifest');
  const swPath = path.join(outDir, 'sw.js');
  await fs.promises.writeFile(manifestPath, buildManifest(opts));
  const precache = collectAssets(outDir, opts.precache);
  await fs.promises.writeFile(swPath, buildServiceWorker(opts, precache));
  return [manifestPath, swPath];
}

export function injectPwaHead(html: string, opts: PwaOptions): string {
  if (!html.includes('</head>')) return html;
  const link = `<link rel="manifest" href="/manifest.webmanifest">`;
  const reg = `<script>if('serviceWorker' in navigator){addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));}</script>`;
  void opts;
  return html.replace('</head>', `  ${link}\n  ${reg}\n</head>`);
}
