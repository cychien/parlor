import { hashKey, QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

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

const tasksEvent = (version: number, id: string, task = "42") => ({
  version,
  id,
  tags: [["tasks", task]],
});

describe("ReadTagRegistry sync cursors", () => {
  function setup() {
    const queryClient = new QueryClient();
    const registry = new ReadTagRegistry();
    registry.attach(queryClient);
    const key = actionQueryKey("listTasks", {});
    const stale = () => queryClient.getQueryState(key)?.isInvalidated ?? false;
    return { queryClient, registry, key, stale };
  }

  it("leaves data alone for events it already reflects, and invalidates it for newer ones", async () => {
    const { queryClient, registry, key, stale } = setup();
    queryClient.setQueryData(key, "cached");
    const hash = queryClient.getQueryCache().find({ queryKey: key })!.queryHash;
    registry.record(hash, [["tasks"]], "5.b");

    await invalidateForEvents(queryClient, registry, [
      tasksEvent(4, "a"),
      tasksEvent(5, "b"),
    ]);
    expect(stale()).toBe(false);

    await invalidateForEvents(queryClient, registry, [tasksEvent(6, "c")]);
    expect(stale()).toBe(true);
  });

  it("invalidates an answer once it lands when a newer event arrived while it was in flight", async () => {
    const { queryClient, registry, key, stale } = setup();
    const answer = (cursor: string) => {
      let settle!: () => void;
      const fetched = queryClient.fetchQuery({
        queryKey: key,
        queryFn: () =>
          registry.read(hashKey(key), async () => {
            await new Promise<void>((resolve) => (settle = resolve));
            return { data: "tasks", tags: [["tasks"]], cursor };
          }),
      });
      return { fetched, settle: () => settle() };
    };

    const older = answer("8.h");
    await vi.waitFor(() => expect(registry.position()).toBe(""));
    await invalidateForEvents(queryClient, registry, [tasksEvent(7, "g")]);
    older.settle();
    await older.fetched;
    await vi.waitFor(() => expect(queryClient.getQueryData(key)).toBe("tasks"));
    expect(stale()).toBe(false);

    const newer = answer("8.h");
    await invalidateForEvents(queryClient, registry, [tasksEvent(9, "i")]);
    newer.settle();
    await newer.fetched;
    await vi.waitFor(() => expect(stale()).toBe(true));
  });

  it("puts the stream's start at the oldest data held or being fetched", async () => {
    const { registry } = setup();
    expect(registry.position()).toBe("");

    registry.record("tasks", [["tasks"]], "5.b");
    registry.record("greeting", [], "1.a");
    expect(registry.position()).toBe("5.b");
    registry.record("notes", [["notes"]], "3.a");
    expect(registry.position()).toBe("3.a");
    expect(registry.position("2.z")).toBe("2.z");
    expect(registry.position("")).toBe("");
    expect(registry.latest()).toBe("5.b");
  });

  it("starts after every event seen when nothing is held, but no later than a fetch in flight", async () => {
    const { registry } = setup();
    registry.observe([tasksEvent(9, "z")]);
    expect(registry.position()).toBe("9.z");

    let settle!: () => void;
    const reading = registry.read("drafts", async () => {
      await new Promise<void>((resolve) => (settle = resolve));
      return { data: [], tags: [["drafts"]], cursor: "10.d" };
    });
    registry.record("tasks", [["tasks"]], "12.c");
    expect(registry.position()).toBe("9.z");
    settle();
    await reading;
    expect(registry.position()).toBe("10.d");
  });
});
