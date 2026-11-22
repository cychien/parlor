/** Keeps the request it is called in alive until `work` settles, such as Cloudflare's `waitUntil`. */
export type RequestHold = (work: Promise<unknown>) => void;

// On globalThis, so every copy of this package in a bundle reaches the one the host installed.
const HOLD = Symbol.for("parlor.requestHold");
const holder = globalThis as { [HOLD]?: RequestHold | undefined };

/**
 * For a host whose runtime ties I/O to the request that began it, as workerd does: work one
 * request starts and later ones share, such as a cache filling, never settles once that request
 * ends, and every later request waiting on it fails.
 */
export function installRequestHold(hold: RequestHold | undefined): void {
  holder[HOLD] = hold;
}

/** `work`, which the request that started it now outlives until it settles. */
export function holdUntilSettled<T>(work: Promise<T>): Promise<T> {
  holder[HOLD]?.(work.then(ignore, ignore));
  return work;
}

function ignore(): void {}
