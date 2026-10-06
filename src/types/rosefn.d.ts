/**
 * rosefn - the globals a `.rose` <script> block can call.
 *
 * This file is the framework's public script surface, declared once so an
 * editor and `rosefn check` (which runs the project's own TypeScript over
 * every extracted script block) both see the same truth the runtime
 * implements. The signatures mirror src/runtime/index.ts exactly - when one
 * changes, this file changes with it.
 *
 * It ships with the package. A project picks it up with a `rosefn-env.d.ts`
 * holding `/// <reference types="rosefn" />` (what `rosefn new` writes for
 * you); `rosefn check` references it by path, so it works in a source
 * checkout too. No imports, no exports: every declaration here is global,
 * because that is exactly how a `.rose` script sees them.
 */
/// <reference lib="dom" />

/**
 * A reactive getter. The compiler turns `let count = $state(0)` into a
 * getter/setter pair named after your declaration, so in a `.rose` script
 * the name you wrote IS this function - `count()` reads it, and
 * `$setState('count', v)` (or the generated setter) writes it.
 */
type Getter<T> = () => T;

/** A store shared by every request in this process (and, with a transport, every worker). */
interface Store<T> {
  get(): T;
  set(v: T): void;
  update(fn: (v: T) => T): void;
}

/** Declare reactive state. Server-rendered into the document, resumed by the client with zero hydration. */
declare function $state<T>(initial: T): Getter<T>;

/** Write reactive state by key - the same write the generated setter performs. */
declare function $setState<T>(key: string, value: T): void;

/**
 * Server data. The body runs on the server per request (and ships to the
 * client, where it re-runs on a client-side navigation), the result lands in
 * the same state map as `$state` - so `post()` is a getter like any other.
 * The await is the compiler's, not yours.
 */
declare function $data<T>(fn: () => T | Promise<T>): Getter<T>;

/** The per-request bag filled by `pages/_middleware.rose` (auth, db, cache). */
declare function getContext<T = Record<string, unknown>>(): T;

/**
 * The parsed query string of the request being rendered (`?page=2&q=x` ->
 * `{ page: '2', q: 'x' }`). Read it in a `$data` body or in the render:
 * routing matches the pathname, so `/search?q=cats` renders the `/search`
 * route with `$query().q === 'cats'`. On a client-side navigation it is the
 * URL the browser is on. A repeated key keeps its first value.
 */
declare function $query(): Record<string, string>;

/**
 * Translate a key from src/locales/<lang>.json.
 *
 * Values are either plain strings with `{name}` holes or ICU MessageFormat:
 * `{count, plural, one {# item} other {# items}}`, `{n, selectordinal, ...}`,
 * `{who, select, ...}` - so `vars` carries numbers for counts and strings for
 * names and select arms. A missing key renders the key itself.
 */
declare function $t(key: string, vars?: Record<string, string | number>): string;

/** 'rtl' for a right-to-left locale (ar, he, fa, ur, ...), 'ltr' otherwise. */
declare function localeDir(lang: string): string;

/**
 * Resolve once a locale's dictionary is present: immediately for a baked one,
 * after one fetch of /locales/<lang>.json for a runtime pack (a locale the
 * build left out of the bundle via i18n.preload). The client router awaits
 * this on every navigation, so a page rarely needs to call it directly.
 */
declare function ensureLocale(lang: string): Promise<void>;

/** Merge a dictionary that arrived at runtime (a fetched pack, or your own import()). */
declare function loadLocale(lang: string, dict: Record<string, string>): void;

/** A named, process-wide store. Values must be JSON-serializable. */
declare function $store<T>(name: string, initial: T): Store<T>;

/** Parse the request's cookies (server) or this document's (client). */
declare function $cookies(request?: Request): Record<string, string>;

/** Build a Set-Cookie value with the safe defaults: HttpOnly, SameSite=Lax, Path=/, 7 days. */
declare function $sessionCookie(
  name: string,
  value: string,
  opts?: { path?: string; maxAge?: number; sameSite?: 'Strict' | 'Lax' | 'None'; secure?: boolean; httpOnly?: boolean }
): string;

/** Run once after the client has adopted the server's DOM. */
declare function onMount(fn: () => void): void;

/** Register a teardown for the next navigation. */
declare function onCleanup(fn: () => void): void;

/** Re-render the current route in place - `$data` re-runs, zero requests. */
declare function refresh(): Promise<void>;

/** HTML-escape a value into a string (the same escape the template markers use). */
declare function esc(v: unknown): string;

/** Call a server action by name; the response is adopted in place. */
declare function $action(name: string, e?: Event): Promise<void>;

/**
 * The standardized failure a server action throws for a BUSINESS error (bad
 * input, not signed in, a duplicate) - as opposed to a bug, which still goes
 * to the 500 page. `code` becomes the response status; `field` names the
 * offending form input.
 */
declare class ActionError extends Error {
  code: number;
  field?: string;
  constructor(message: string, code?: number, field?: string);
}

/** What the dispatch seeds into state when an action fails (what `$actionError()` returns). */
interface ActionErrorInfo {
  action: string;
  message: string;
  code: number;
  field?: string;
}

/**
 * The failure of the action that produced the response being rendered, or
 * null. Render it (`{#if $actionError()}<p>{$actionError().message}</p>{/if}`)
 * or contain it with a `{#boundary}` around the action's widget.
 */
declare function $actionError(): ActionErrorInfo | null;

/**
 * An incremental patch: an action's return value may map a state key to an
 * OPERATION instead of a whole replacement, so growing a large list costs one
 * row rather than a second copy of the list.
 */
declare function $append(value: unknown): unknown;
declare function $prepend(value: unknown): unknown;
declare function $merge(value: Record<string, unknown>): unknown;

/** Whether a state key already holds a value (what `$data` checks before fetching). */
declare function hasState(key: string): boolean;

/** The best dictionary for an Accept-Language header (null when none matches). */
declare function bestLocale(header: string | null | undefined): string | null;
