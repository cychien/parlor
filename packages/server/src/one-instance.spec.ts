import {
  ANONYMOUS,
  asId,
  type DataProvider,
  defineAction,
  type Principal,
} from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createConnectionScope, createDatabase, type DatabaseHandle } from "@parlor/data";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { AuthProvider } from "./auth.js";
import { createServer, type FrameworkServer } from "./create-server.js";
import type { PluginHost } from "./plugin.js";

const postgresUrl = process.env.PARLOR_TEST_DATABASE_URL;

const actions = createRegistry({
  addNote: defineAction({
    description: "Add a note.",
    input: z.object({}),
    writes: ["notes"],
    run: () => ({ id: crypto.randomUUID() }),
  }),
});

const alice: Principal = {
  kind: "user",
  userId: asId("user", "alice"),
  sessionId: "s-alice",
};

const auth: AuthProvider = {
  name: "test-auth",
  setup: () => ({}),
  enforcing: true,
  authenticate: (request) =>
    Promise.resolve(request.headers.has("authorization") ? alice : ANONYMOUS),
  challenge: () => new Response(null, { status: 401 }),
  revoked: () => new AbortController().signal,
};

const instancesOf = (database: DataProvider | undefined) => {
  let seen: PluginHost | undefined;
  createServer({
    actions,
    database,
    plugins: [{ name: "probe", setup: (host) => ((seen = host), {}) }],
  });
  return seen?.instances;
};

describe("a server's instances", () => {
  const provider = (notifications?: DataProvider["notifications"]): DataProvider => ({
    read: () => undefined,
    transaction: (run) => run(undefined),
    ...(notifications ? { notifications } : {}),
  });

  it("is one when its database notifies in process, and many otherwise", () => {
    expect(instancesOf(provider("process"))).toBe("one");
    expect(instancesOf(provider("database"))).toBe("many");
    expect(instancesOf(provider())).toBe("many");
    expect(instancesOf(undefined)).toBe("many");
  });
});

describe.runIf(postgresUrl)("the app's only server, on Postgres", () => {
  let database: DatabaseHandle;
  let admin: DatabaseHandle;
  let name: string;
  let server: FrameworkServer;
  let used = 0;

  beforeAll(async () => {
    admin = await createDatabase({ url: postgresUrl, notifications: "database" });
    name = `parlor_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await admin.client.query(`create database ${name}`);
    const url = new URL(postgresUrl!);
    url.pathname = `/${name}`;
    database = await createDatabase({
      url: url.href,
      notifications: "process",
      predecessorMs: 0,
    });
    const counted: DatabaseHandle = {
      ...database,
      read: () => {
        used += 1;
        return database.read();
      },
      transaction: (run) => {
        used += 1;
        return database.transaction(run);
      },
      listen: (channel, handler, options) => {
        used += 1;
        return database.listen(channel, handler, options);
      },
    };
    server = createServer({ actions, database: counted, auth });
  }, 30_000);

  afterAll(async () => {
    await server.close();
    await admin.client.query(`drop database if exists ${name} with (force)`);
    await admin.close();
  });

  const call = (path: string, init: RequestInit = {}, signedIn = true) =>
    server.fetch(
      new Request(`http://app.test${path}`, {
        ...init,
        headers: {
          ...(signedIn ? { authorization: "Bearer alice" } : {}),
          "content-type": "application/json",
        },
      }),
    );

  const listening = async () => {
    const { rows } = await admin.client.query(
      `select pid from pg_stat_activity where datname = $1 and query ilike 'listen %'`,
      [name],
    );
    return rows.length;
  };

  async function framesOf(body: ReadableStream<Uint8Array>, count: number) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const frames = () => text.split("\n\n").filter((f) => f.trim() && !f.startsWith(":"));
    const deadline = Date.now() + 3000;
    while (frames().length < count && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    return { frames: frames(), reader };
  }

  it("advises its clients to watch the build, and answers it to anyone", async () => {
    const negotiated = await call("/_parlor/sync/token", { method: "POST" });
    await expect(negotiated.json()).resolves.toMatchObject({
      transport: "sse",
      safety: "build",
    });
    expect((await call("/_parlor/sync/token", { method: "POST" }, false)).status).toBe(
      401,
    );
    const build = await call("/_parlor/sync/build", {}, false);
    expect(build.status).toBe(200);
    expect(build.headers.get("x-parlor-build")).toBeTruthy();
  });

  it("pushes a write to an open stream over no LISTEN connection, and rests while nothing happens", async () => {
    const stream = await call("/_parlor/sync/stream?safety=build");
    const { reader } = await framesOf(stream.body!, 1);
    expect(await listening()).toBe(0);

    const wrote = await call("/_parlor/actions/addNote", { method: "POST", body: "{}" });
    expect(wrote.status).toBe(200);
    const decoder = new TextDecoder();
    let pushed = "";
    while (!pushed.includes('"notes"')) {
      const { value, done } = await reader.read();
      if (done) break;
      pushed += decoder.decode(value);
    }
    expect(pushed).toContain('"notes"');

    const before = used;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(used).toBe(before);
    expect(await listening()).toBe(0);
    await reader.cancel();
  });

  it("keeps pushing after the Durable Object it runs in is replaced while the process lives on", async () => {
    const pushed = async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      id: string,
    ) => {
      const decoder = new TextDecoder();
      let text = "";
      const deadline = Date.now() + 2000;
      while (!text.includes(id) && Date.now() < deadline) {
        const next = await Promise.race([
          reader.read(),
          new Promise<undefined>((resolve) => setTimeout(resolve, 200)),
        ]);
        if (!next) continue;
        if (next.done) break;
        text += decoder.decode(next.value);
      }
      return text.includes(id);
    };
    // A fresh server, whose hub first starts inside a Durable Object instance.
    const fresh = createServer({
      actions,
      database: { ...database, close: undefined },
      auth,
    });
    const request = (path: string, init: RequestInit = {}) =>
      fresh.fetch(
        new Request(`http://app.test${path}`, {
          ...init,
          headers: { authorization: "Bearer alice", "content-type": "application/json" },
        }),
      );
    // Each Durable Object instance serves its requests in its own connection scope.
    const instance = () => createConnectionScope();
    const first = instance();
    const earlier = await first.run(() => request("/_parlor/sync/stream?safety=build"));
    const { reader: gone } = await framesOf(earlier.body!, 1);
    await gone.cancel();
    await first.close();

    const second = instance();
    try {
      const stream = await second.run(() => request("/_parlor/sync/stream?safety=build"));
      const { reader } = await framesOf(stream.body!, 1);
      const wrote = await second.run(() =>
        request("/_parlor/actions/addNote", { method: "POST", body: "{}" }),
      );
      expect(wrote.status).toBe(200);
      const { data } = (await wrote.json()) as { data: { id: string } };
      expect(await pushed(reader, data.id)).toBe(true);
      await reader.cancel();
    } finally {
      await second.close();
      await fresh.close();
    }
  });
});
