

type ShutdownHook = {
  name: string;
  fn: () => void | Promise<void>;
};

type HookResult = { name: string; ok: boolean; error?: string };

const shutdownHooks: ShutdownHook[] = [];


let draining: Promise<HookResult[]> | null = null;

(globalThis as unknown as { __rosefnOnShutdown?: typeof onShutdown }).__rosefnOnShutdown =
  onShutdown;
(globalThis as unknown as { __rosefnRunShutdownHooks?: typeof runShutdownHooks }).__rosefnRunShutdownHooks =
  runShutdownHooks;

/** Returns an unregister function - a hot-swapped client must drop its old hook. */
export function onShutdown(name: string, fn: () => void | Promise<void>): () => void {
  const hook: ShutdownHook = { name, fn };
  shutdownHooks.push(hook);
  return () => {
    const at = shutdownHooks.indexOf(hook);
    if (at !== -1) shutdownHooks.splice(at, 1);
  };
}

/** Never rejects; a throwing hook is reported and the rest still run. */
export function runShutdownHooks(reason: string): Promise<HookResult[]> {
  if (draining) return draining;
  draining = (async () => {
    const results: HookResult[] = [];
    for (const hook of shutdownHooks.slice()) {
      try {
        await hook.fn();
        results.push({ name: hook.name, ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ name: hook.name, ok: false, error: message });
        console.error(`[rosefn] shutdown hook ${hook.name} failed (${reason}):`, message);
      }
    }
    return results;
  })().finally(() => {
    draining = null;
  });
  return draining;
}

export function shutdownHookCount(): number {
  return shutdownHooks.length;
}
