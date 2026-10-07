/**
 * A compiler error shaped for its reader - who is as often an AI agent as a
 * human. Every failure the compiler throws on purpose carries:
 *
 *   code    a stable identifier (E-EXPORT, E-TEMPLATE, ...) an agent can
 *           branch on and a human can grep across a build log
 *   file    the .rose file (or directory) at fault
 *   line    the line inside it, when the compiler knows the position
 *   hint    the fix, in one sentence
 *
 * `rosefn build --json` prints these as a JSON envelope on stdout, so an
 * agent can parse the failure and patch the file without scraping prose.
 * The human output prints the message and the hint. Errors that are NOT
 * RoseErrors (a crash inside a plugin's own code, a framework bug) keep
 * their stack: those are not the developer's to fix from a code alone.
 */

export interface RoseErrorInfo {
  code: string;
  file?: string;
  line?: number;
  message: string;
  hint?: string;
}

export class RoseError extends Error {
  readonly code: string;
  readonly file?: string;
  readonly line?: number;
  readonly hint?: string;

  constructor(code: string, message: string, opts: { file?: string; line?: number; hint?: string } = {}) {
    super(message);
    this.name = 'RoseError';
    this.code = code;
    this.file = opts.file;
    this.line = opts.line;
    this.hint = opts.hint;
  }

  info(): RoseErrorInfo {
    // code -> file -> line -> message -> hint: the order the prompt doc
    // documents, so a reader parsing the envelope finds the location first
    const info = { code: this.code } as RoseErrorInfo;
    if (this.file !== undefined) info.file = this.file;
    if (this.line !== undefined) info.line = this.line;
    info.message = this.message;
    if (this.hint !== undefined) info.hint = this.hint;
    return info;
  }
}

/** The 1-based line of `index` inside `src`. */
export function lineOf(src: string, index: number): number {
  let line = 1;
  const end = Math.min(index, src.length);
  for (let i = 0; i < end; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}

/** The line of a regex match inside `src` - undefined when there is no match
 *  (the position is optional on a match array, and the call sites that have
 *  one always matched). */
export function lineAt(src: string, match?: RegExpMatchArray | null): number | undefined {
  return match && match.index !== undefined ? lineOf(src, match.index) : undefined;
}

/** Shape any thrown value into the info object the --json envelope prints. */
export function errorInfo(err: unknown): RoseErrorInfo {
  if (err instanceof RoseError) return err.info();
  return { code: 'E-UNKNOWN', message: err instanceof Error ? err.message : String(err) };
}
