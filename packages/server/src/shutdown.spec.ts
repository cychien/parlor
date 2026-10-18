import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase } from "@parlor/data";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createServer } from "./create-server.js";

const freshDataDir = async () =>
  join(await mkdtemp(join(tmpdir(), "parlor-shutdown-")), "pglite");

let template: string;

beforeAll(async () => {
  template = await freshDataDir();
  const seeded = await createDatabase({ dataDir: template });
  await seeded.db.execute("create table notes (body text)");
  await seeded.close();
}, 30_000);

async function fileDatabase() {
  const dataDir = await freshDataDir();
  await cp(template, dataDir, { recursive: true });
  return { dataDir, database: await createDatabase({ dataDir }) };
}

function openSyncStream(server: ReturnType<typeof createServer>) {
  return server.fetch(
    new Request("http://app.test/_parlor/sync/stream?since=", {
      headers: { accept: "text/event-stream" },
    }),
  );
}

describe("createServer close", () => {
  it("ends open sync streams", async () => {
    const { database } = await fileDatabase();
    const server = createServer({ actions: createRegistry({}), database });
    const response = await openSyncStream(server);
    const reader = response.body!.getReader();
    await reader.read();

    await server.close();

    await expect(
      Promise.race([
        reader.read().then((chunk) => chunk.done),
        new Promise((resolve) => setTimeout(() => resolve("still open"), 1000)),
      ]),
    ).resolves.toBe(true);
  });

  it("closes the database it serves", async () => {
    const { database } = await fileDatabase();
    const server = createServer({ actions: createRegistry({}), database });

    await server.close();

    await expect(database.db.execute("select 1")).rejects.toThrow();
  });

  it("lets an in-flight action commit before the database closes", async () => {
    const { dataDir, database } = await fileDatabase();
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const actions = createRegistry({
      save: defineAction({
        description: "Save a note slowly.",
        input: z.object({}),
        mutates: true,
        run: async (_input, ctx) => {
          started();
          await new Promise((resolve) => setTimeout(resolve, 200));
          await ctx.db.execute("insert into notes values ('kept')");
          return {};
        },
      }),
    });
    const server = createServer({ actions, database, sync: false });
    const request = server.fetch(
      new Request("http://app.test/_parlor/actions/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    await running;

    await server.close();

    expect((await request).status).toBe(200);
    const reopened = await createDatabase({ dataDir });
    const rows = await reopened.db.execute("select body from notes");
    expect(rows.rows).toEqual([{ body: "kept" }]);
    await reopened.close();
  });

  it("can be closed twice, and the database closed by its owner afterwards", async () => {
    const { database } = await fileDatabase();
    const server = createServer({ actions: createRegistry({}), database });
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
    await expect(database.close()).resolves.toBeUndefined();
  });
});
