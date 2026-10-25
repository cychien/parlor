import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createServer, type FrameworkServer } from "./create-server.js";

const actions = createRegistry({
  listNotes: defineAction({
    description: "List notes.",
    input: z.object({}),
    reads: ["notes"],
    run: () => [],
  }),
  addNote: defineAction({
    description: "Add a note.",
    input: z.object({}),
    writes: ["notes"],
    run: () => ({ id: crypto.randomUUID() }),
  }),
  hello: defineAction({
    description: "Say hello.",
    input: z.object({}),
    run: () => "hello",
  }),
});

let database: DatabaseHandle;
let server: FrameworkServer;

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
  server = createServer({ actions, database });
  await call("listNotes");
}, 30_000);
afterAll(async () => {
  await server.close();
});

async function call(name: string): Promise<{ data: unknown; cursor?: string }> {
  const response = await server.fetch(
    new Request(`http://app.test/_parlor/actions/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function eventsSince(cursor: string): Promise<unknown[]> {
  const response = await server.fetch(
    new Request(`http://app.test/_parlor/sync?since=${encodeURIComponent(cursor)}`),
  );
  return ((await response.json()) as { events: unknown[] }).events;
}

describe("the sync cursor of a read", () => {
  it("marks the last event the read's data reflects, so the log after it holds only later writes", async () => {
    await call("addNote");
    await call("addNote");
    const { cursor } = await call("listNotes");
    expect(cursor).toMatch(/^\d+\./);
    expect(await eventsSince(cursor!)).toEqual([]);

    await call("addNote");
    expect(await eventsSince(cursor!)).toEqual([
      expect.objectContaining({ tags: [["notes", expect.any(String)]] }),
    ]);
  });

  it("is absent from writes and from actions that declare no reads", async () => {
    expect(await call("addNote")).not.toHaveProperty("cursor");
    expect(await call("hello")).not.toHaveProperty("cursor");
  });
});
