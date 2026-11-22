import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createTestApp, signUp } from "./testing/app.js";

let database: DatabaseHandle;

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
}, 30_000);

afterAll(() => database.close());

it("answers a session without signing a JWT for it, which nothing reads and costs a key lookup", async () => {
  const app = createTestApp(database);
  const browser = await signUp(app.server, "Mei");

  const session = await browser.fetch("/_parlor/auth/get-session");

  expect(session.status).toBe(200);
  await expect(session.json()).resolves.toMatchObject({ user: { name: "Mei" } });
  expect(session.headers.get("set-auth-jwt")).toBeNull();
});
