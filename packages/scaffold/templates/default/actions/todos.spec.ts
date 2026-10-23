import { fileURLToPath } from "node:url";

import { createActionClient } from "@parlor/client";
import type { ActionsOf } from "@parlor/core/registry";
import { createDatabase } from "@parlor/data";
import { createServer } from "@parlor/server";
import { afterEach, expect, test } from "vitest";

import { registry } from "./index.js";

const servers: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startApp() {
  const database = await createDatabase({
    dataDir: "memory://",
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  const server = createServer({ actions: registry, database });
  servers.push(server);
  return createActionClient<ActionsOf<typeof registry>>({
    baseUrl: "http://app.test",
    fetch: (input, init) => server.fetch(new Request(input, init)),
  });
}

test("a todo added through its action is in the list, not done", async () => {
  const app = await startApp();

  await app.call("addTodo", { title: "Buy milk" });

  expect(await app.call("listTodos", {})).toMatchObject([
    { title: "Buy milk", done: false },
  ]);
});
