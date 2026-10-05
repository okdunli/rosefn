// Rosefn plugins: the default export is an array of
// { name, transform }, and every transform sees a component's RAW source
// (template + script + style, before any parsing) and returns what the
// compiler will parse. trade-off: one hook covers macros, custom syntax,
// includes and auto-imports - a transform can rewrite anything, including
// the script block, so the demo replaces a token with the brand mark.
export default [
  {
    name: 'thorn',
    transform(code) {
      return code.replaceAll('@thorn', '\u{1F339}');
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
