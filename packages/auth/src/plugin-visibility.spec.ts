import { chat } from "@parlor/chat/server";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestApp, signUp, type TestApp } from "./testing/app.js";

let database: DatabaseHandle;
let app: TestApp;

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
  await database.db.execute(sql`select 1`);
  app = createTestApp(database, { plugins: [chat()], visible: () => () => false });
}, 30_000);

afterAll(async () => {
  await app.server.close();
  await database.close();
});

describe("createServer({ visible }) that hides every action", () => {
  it("hides the app's actions but leaves the auth and chat plugins working for a user", async () => {
    const alice = await signUp(app.server, "Alice");

    const own = await alice.post("/_parlor/actions/whoami", {});
    expect(own.status).toBe(404);

    expect((await alice.account("sessions")).status).toBe(200);
    const chatOpen = await alice.post("/_parlor/chat/actions/open", {});
    expect(chatOpen.status).toBe(200);
  });
});
