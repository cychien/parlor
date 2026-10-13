import type { DataProvider } from "@parlor/core";

import { pruneSyncEvents, type SyncDatabase } from "./store.js";

export const DEFAULT_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

export interface Pruner {
  touch(): void;
}

export function createPruner(
  data: DataProvider,
  options: {
    intervalMs?: number | undefined;
    now?: () => number;
    onError?: (error: unknown) => void;
  } = {},
): Pruner {
  const intervalMs = options.intervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const onError =
    options.onError ?? ((error) => console.error("[parlor] sync prune failed:", error));
  let last = now();
  let running = false;
  return {
    touch() {
      if (running || now() - last < intervalMs) return;
      running = true;
      last = now();
      void pruneSyncEvents(data.read() as SyncDatabase)
        .catch(onError)
        .finally(() => {
          running = false;
        });
    },
  };
}
