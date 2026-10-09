// Rosefn - the globals a `.rose` <script> block can call.

// A reactive getter.
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


declare function $data<T>(fn: () => T | Promise<T>): Getter<T>;

/** The per-request bag filled by `pages/_middleware.rose` (auth, db, cache). */
declare function getContext<T = Record<string, unknown>>(): T;

// The parsed query string of the request being rendered (`?page=2&q=x` -> `{ page: '2', q: 'x' }`).
declare function $query(): Record<string, string>;


declare function $t(key: string, vars?: Record<string, string | number>): string;

/** 'rtl' for a right-to-left locale (ar, he, fa, ur, ...), 'ltr' otherwise. */
declare function localeDir(lang: string): string;


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

// The failure of the action that produced the response being rendered, or null.
declare function $actionError(): ActionErrorInfo | null;

// An incremental patch: an action's return value may map a state key to an OPERATION instead of a whole replacement.
declare function $append(value: unknown): unknown;
declare function $prepend(value: unknown): unknown;
declare function $merge(value: Record<string, unknown>): unknown;

/** Whether a state key already holds a value (what `$data` checks before fetching). */
declare function hasState(key: string): boolean;

/** The best dictionary for an Accept-Language header (null when none matches). */
declare function bestLocale(header: string | null | undefined): string | null;


declare function redirect(path: string, status?: 301 | 302 | 303 | 307 | 308): never;


declare function notFound(): never;
