// Rosefn plugins (innovation #30): the default export is an array of
// { name, transform }, and every transform sees a component's RAW source
// (template + script + style, before any parsing) and returns what the
// compiler will parse. ponytail: one hook covers macros, custom syntax,
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
