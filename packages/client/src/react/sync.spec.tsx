import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { actionQueryKey } from "../query-keys.js";
import { invalidateForEvents, ReadTagRegistry } from "./sync.js";

describe("ReadTagRegistry + invalidateForEvents", () => {
  it("invalidates only queries whose read tags overlap the event tags", async () => {
    const queryClient = new QueryClient();
    const registry = new ReadTagRegistry();
    registry.attach(queryClient);

    const list = actionQueryKey("listTasks", {});
    const detail42 = actionQueryKey("getTask", { id: "42" });
    const detail43 = actionQueryKey("getTask", { id: "43" });
    const greeting = actionQueryKey("hello", {});
    for (const key of [list, detail42, detail43, greeting]) {
      queryClient.setQueryData(key, "cached");
    }
    const hashOf = (key: readonly unknown[]) =>
      queryClient.getQueryCache().find({ queryKey: key })!.queryHash;
    registry.record(hashOf(list), [["tasks"]]);
    registry.record(hashOf(detail42), [["tasks", "42"]]);
    registry.record(hashOf(detail43), [["tasks", "43"]]);
    registry.record(hashOf(greeting), []);

    await invalidateForEvents(queryClient, registry, [
      { version: 1, id: "e", tags: [["tasks", "42"]] },
    ]);

    const stale = (key: readonly unknown[]) =>
      queryClient.getQueryState(key)?.isInvalidated ?? false;
    expect(stale(list)).toBe(true);
    expect(stale(detail42)).toBe(true);
    expect(stale(detail43)).toBe(false);
    expect(stale(greeting)).toBe(false);
  });

  it("forgets tags when a query is removed from the cache", () => {
    const queryClient = new QueryClient();
    const registry = new ReadTagRegistry();
    registry.attach(queryClient);
    const key = actionQueryKey("listTasks", {});
    queryClient.setQueryData(key, "x");
    const hash = queryClient.getQueryCache().find({ queryKey: key })!.queryHash;
    registry.record(hash, [["tasks"]]);
    queryClient.removeQueries({ queryKey: key });
    expect(registry.tagsFor(hash)).toBeUndefined();
  });
});
