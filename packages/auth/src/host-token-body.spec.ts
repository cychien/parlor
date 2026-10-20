import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestApp, ORIGIN, type TestApp } from "./testing/app.js";

let database: DatabaseHandle;
let app: TestApp;

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
}, 30_000);

afterAll(async () => {
  await database.close();
});

afterEach(async () => {
  await app.server.close();
});

function exchangeWith(chunks: number, chunkBytes: number, headers: HeadersInit = {}) {
  const pulled = { count: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled.count === chunks) {
          controller.close();
          return;
        }
        pulled.count += 1;
        controller.enqueue(new Uint8Array(chunkBytes).fill(97));
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request(`${ORIGIN}/_parlor/auth/hosts/token`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    duplex: "half",
  } as RequestInit);
  return { request, pulled };
}

describe("the public /hosts/token body", () => {
  it("stops reading a streamed body once it passes 16 KiB", async () => {
    app = createTestApp(database);
    const { request, pulled } = exchangeWith(100, 4096);
    const response = await app.server.fetch(request);
    expect(response.status).toBe(400);
    expect(pulled.count).toBeLessThanOrEqual(6);
  });

  it("refuses a declared length over 16 KiB without reading the body", async () => {
    app = createTestApp(database);
    const { request, pulled } = exchangeWith(100, 4096, { "content-length": "999999" });
    const response = await app.server.fetch(request);
    expect(response.status).toBe(400);
    expect(pulled.count).toBe(0);
  });
});
