import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createTestApp,
  ORIGIN,
  signUp as signUpAs,
  type TestApp,
} from "./testing/app.js";
import { type Computer, HELLO, pair } from "./testing/computer.js";
import { probePlugin } from "./testing/probe.js";

const BEHIND_PROXY = "http://10.0.3.7:8080";

let database: DatabaseHandle;
let app: TestApp;
let computer: Computer;

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
}, 30_000);

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  app = createTestApp(database, { plugins: [probePlugin] });
  computer = await pair(app.server, await signUpAs(app.server, "Alice"));
}, 30_000);

afterEach(async () => {
  await app.server.close();
});

const callFrom = async (
  origin: string,
  signed: { url: string; method?: "GET" | "POST" },
  method: "GET" | "POST" = "POST",
) => {
  const response = await app.server.fetch(
    new Request(`${origin}${HELLO}`, {
      method,
      headers: {
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        authorization: `ParlorHost ${await computer.assertion(signed)}`,
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    }),
  );
  return response.status;
};

describe("a host assertion behind a TLS-terminating proxy", () => {
  it("is checked against the app's public origin, not the URL the runtime rebuilt", async () => {
    expect(await callFrom(BEHIND_PROXY, { url: `${ORIGIN}${HELLO}` })).toBe(200);
  });

  it("is still refused for another origin, path or method", async () => {
    expect(await callFrom(BEHIND_PROXY, { url: `${BEHIND_PROXY}${HELLO}` })).toBe(401);
    expect(await callFrom(BEHIND_PROXY, { url: `https://other.example${HELLO}` })).toBe(
      401,
    );
    expect(
      await callFrom(BEHIND_PROXY, { url: `${ORIGIN}/_parlor/auth/actions/hosts` }),
    ).toBe(401);
    expect(
      await callFrom(BEHIND_PROXY, { url: `${ORIGIN}${HELLO}`, method: "GET" }),
    ).toBe(401);
  });
});
