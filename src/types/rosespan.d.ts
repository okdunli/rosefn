
/// <reference lib="dom" />
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
 * Computed state: compiles to a plain getter over the signals the expression
 * reads, so every read recomputes - no subscription machinery, never
 * serialized. Top-level declarations only. The expression is rosespan syntax
 * (bare state reads are callified at compile time), so it checks as `any`.
 */
declare function $derived(expr: any): Getter<any>;

/** Like $state, but every write mirrors to localStorage (JSON, `rosespan:` prefix) and boot re-seeds from it. */
declare function $persist<T>(initial: T): Getter<T>;

/**
 * Declaration form: `let x = $kv(() => expensive(), 60)`. The compiler turns
 * it into seeded $state backed by the server-side memo - the value arrives
 * with the first render and every request inside the TTL shares one compute.
 */
declare function $kv<T>(compute: () => T | Promise<T>, ttlSeconds?: number): Getter<T>;


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

declare function $effect(fn: () => void | (() => void)): () => void;

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

// === Globals the compiler injects when a route uses them ===
// These live on globalThis in the built bundle; declaring them here keeps
// `rosespan check` honest about code that reaches for them directly.

declare var __rosespanAuth: {
  hashPassword(pw: string): string;
  verifyPassword(pw: string, hash: string): boolean;
  signSession(data: Record<string, unknown>, secret: string, ttlSeconds?: number): string;
  verifySession<T = Record<string, unknown>>(token: string, secret: string): T | null;
  csrfToken(secret: string, sessionId: string): string;
  verifyCsrf(token: string, secret: string, sessionId: string): boolean;
};

declare var __rosespanKvApi: {
  kv: {
    get(key: string): unknown;
    set(key: string, value: unknown, ttlSeconds?: number): void;
    del(key: string): void;
    has(key: string): boolean;
  };
  kvMemo: typeof $kv;
};

interface RoseSpanContentEntry {
  slug: string;
  title?: string;
  date?: string;
  tags?: string[];
  excerpt?: string;
  body: string;
  html?: string;
  toc?: unknown[];
  readingTime?: number;
  wordCount?: number;
  [key: string]: unknown;
}

declare var __rosespanContent: {
  list(coll: string, filter?: { tag: string }): Array<Record<string, unknown>>;
  rss(coll: string, opts: { title: string; origin: string; description: string }): string;
  get(coll: string, slug: string, vars?: Record<string, string>): RoseSpanContentEntry | null;
};

declare var __rosespanExtras: {
  v: {
    validate(body: Record<string, unknown>, rules: Record<string, string[]>): {
      ok: boolean;
      errors: Record<string, string>;
      values: Record<string, unknown>;
    };
  };
};

/** Named view transitions: `globalThis.__rosespanTransitions.pulse = (el, ms) => () => {}` - used by `transition:pulse` in templates. */
declare var __rosespanTransitions: Record<string, (el: HTMLElement, duration: number) => () => void>;


declare function redirect(path: string, status?: 301 | 302 | 303 | 307 | 308): never;


declare function notFound(): never;

// === Network listeners (isomorphic) ===
// On the server these open real sockets when the serve worker boots
// (`__startNetwork`); on the client every handle is an inert no-op, so a page
// that opens a listener hydrates without a ReferenceError.

/** The sender of a UDP datagram (what `rinfo` carries in `onMessage`). */
interface RemoteInfo {
  address: string;
  family: string;
  port: number;
  size: number;
}

interface UDPSocket {
  send(msg: Buffer, port: number, host?: string): void;
  close(): void;
  address(): { port: number; host: string; family: string };
  joinMulticast(multicastAddress: string): void;
  leaveMulticast(multicastAddress: string): void;
}

/**
 * Listen for UDP datagrams (LoRa gateways, sensor feeds) from inside a rosespan
 * app. Only registers the spec; the framework binds it at serve-worker boot, so
 * a build/prerender never opens a socket.
 */
declare function $udp(
  port: number,
  opts?: {
    host?: string;
    onMessage?: (msg: Buffer, rinfo: RemoteInfo) => void;
    onError?: (err: Error) => void;
  }
): UDPSocket;

interface TCPsocket {
  write(data: string | Buffer): void;
  end(data?: string | Buffer): void;
  destroy(): void;
  on(event: 'data', fn: (data: Buffer) => void): void;
  on(event: 'close', fn: () => void): void;
  on(event: 'error', fn: (err: Error) => void): void;
  readonly remoteAddress?: string;
}

interface TCPServer {
  close(): void;
  address(): { port: number; host: string };
}

/**
 * A TCP server (a number, or opts with onConnection) or a TCP client (a host
 * string, or opts with onConnect). Same register-at-boot discipline as $udp.
 */
declare function $tcp(
  portOrHost: number | string,
  opts?: {
    port?: number;
    host?: string;
    idleTimeout?: number;
    onConnection?: (socket: TCPsocket) => void;
    onData?: (socket: TCPsocket, data: Buffer) => void;
    onIdle?: (socket: TCPsocket) => void;
    onConnect?: () => void;
    onClose?: () => void;
    onError?: (err: Error) => void;
  }
): TCPServer | TCPsocket;

interface Listener {
  close(): void;
  address(): { port: number; host: string };
}

/** General-port listener: protocol 'http' | 'websocket' | 'udp' | 'tcp' (default 'http'). */
declare function $listen(
  port: number,
  opts?: {
    protocol?: 'http' | 'websocket' | 'udp' | 'tcp';
    host?: string;
    onConnection?: (socket: unknown) => void;
    onData?: (data: Buffer, remote: unknown) => void;
  }
): Listener;

/** One connection served by a `$websocket` server. */
interface WebSocket {
  send(data: string | Buffer): void;
  close(): void;
  on(event: 'message', fn: (data: string | Buffer) => void): void;
  on(event: 'close', fn: () => void): void;
  on(event: 'error', fn: (err: Error) => void): void;
  readonly remoteAddress?: string;
}

interface WebSocketServer {
  close(): void;
  clients(): WebSocket[];
  broadcast(data: string | Buffer): void;
}

/**
 * A zero-dependency RFC 6455 WebSocket server on its own port. The returned
 * facade stays live: broadcast()/close() reach the bound server whenever the
 * app calls them (on the client the facade is an inert no-op).
 */
declare function $websocket(
  port: number,
  opts?: {
    host?: string;
    path?: string;
    pingInterval?: number;
    onConnection?: (ws: WebSocket) => void;
    onMessage?: (ws: WebSocket, data: string | Buffer) => void;
    onClose?: (ws: WebSocket) => void;
    onError?: (err: Error) => void;
  }
): WebSocketServer;

interface MQTTClient {
  connect(): Promise<void>;
  disconnect(): void;
  subscribe(topic: string, opts?: { qos?: 0 | 1 | 2 }): void;
  unsubscribe(topic: string): void;
  publish(topic: string, message: string | Buffer, opts?: { qos?: 0 | 1 | 2; retain?: boolean }): void;
  readonly connected: boolean;
}

/**
 * A zero-dependency MQTT 3.1.1 client (QoS 0/1). `broker` is a URL like
 * `mqtt://localhost:1883`. Packets sent before CONNACK queue and flush on
 * connect. On the client the facade is an inert no-op.
 */
declare function $mqtt(
  broker: string,
  opts?: {
    clientId?: string;
    username?: string;
    password?: string;
    keepalive?: number;
    clean?: boolean;
    reconnect?: boolean;
    reconnectDelay?: number;
    reconnectMax?: number;
    onConnect?: () => void;
    onMessage?: (topic: string, message: Buffer) => void;
    onError?: (err: Error) => void;
  }
): MQTTClient;
