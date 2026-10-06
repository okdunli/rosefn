// Rosefn plugins: the default export is an array of
// { name, transform }, and every transform sees a component's RAW source
// (template + script + style, before any parsing) and returns what the
// compiler will parse. trade-off: one hook covers macros, custom syntax,
// includes and auto-imports - a transform can rewrite anything, including
// the script block, so the demo replaces a token with the brand mark.
//
// The same plugin object may also carry RUNTIME hooks , which run
// inside the deployed server: onRequest before routing, onResponse once the
// response exists. The one below is the P0-2 story in nine lines - it can
// only rewrite a document it can READ, which is exactly what
// `export const buffer = true` buys a route.
export default [
  {
    name: 'thorn',
    transform(code) {
      return code.replaceAll('@thorn', '\u{1F339}');
    },
  },
  {
    name: 'document-marker',
    async onResponse(ctx, res) {
      // P0-3: the document's content-type travels WITH the Response, so a
      // hook never has to guess what it is looking at.
      const type = res.headers.get('content-type') || '';
      if (!type.includes('text/html')) return;
      // P0-2: a STREAMED response hands the hook a bodyless Response - the
      // body is produced after this point and cannot be replaced, which is
      // the honest limit of a stream (and the reason TTFB wins). A route
      // exporting `buffer = true` - and every csr = false route - renders
      // whole first, so the body is here to read, rewrite and return.
      if (!res.body) return;
      const html = await res.text();
      return new Response(html.replace('<html', '<html data-hooked="1"'), {
        status: res.status,
        headers: res.headers,
      });
    },
  },
];

// i18n (+ ): which dictionaries bake into the CLIENT
// bundle. The default is "all of them"; this demo leaves ar out on purpose.
// en and zh are inline, so switching between them is a zero-request
// navigation - the one-request bet taken to its conclusion. ar is a runtime
// pack: the build writes dist/locales/ar.json, the client fetches it the
// first time it renders /ar/about (one request per session, then it renders
// from memory), and the server - which carries every locale - renders
// /ar/about on demand either way. Both halves stay correct; only the size
// of the bundle moves.
export const i18n = { preload: ['en', 'zh'] };
