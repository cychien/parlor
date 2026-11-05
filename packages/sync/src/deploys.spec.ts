import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { H3 } from "h3";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ChannelConnection, ServerChannel } from "./channel.js";
import { createSyncClient, type SyncClient } from "./client/sync-client.js";
import { BUILD_HEADER } from "./protocol.js";
import { SyncHub } from "./server/hub.js";
import { registerSyncRoutes } from "./server/routes.js";
import { ensureSyncTables } from "./server/store.js";

/** One instance of a build: its own hub and its own in-memory channel, like a Durable Object. */
interface Instance {
  readonly app: H3;
  readonly hub: SyncHub;
  readonly computers: Set<ChannelConnection>;
  readonly streams: { count: number };
}

let handle: DatabaseHandle;
const instances: Instance[] = [];
let client: SyncClient | undefined;

beforeAll(async () => {
  handle = await createDatabase({ dataDir: "memory://" });
  await ensureSyncTables(handle.db);
}, 30_000);
afterEach(async () => {
  client?.stop();
  client = undefined;
  for (const running of instances.splice(0)) await running.hub.stop();
});
afterAll(async () => {
  await handle.close();
});

function instance(build: string | undefined, maxStreamMs?: number): Instance {
  const app = new H3();
  const hub = new SyncHub(handle);
  const computers = new Set<ChannelConnection>();
  const streams = { count: 0 };
  const chat: ServerChannel = {
    event: "chat",
    connect(connection) {
      computers.add(connection);
      return () => computers.delete(connection);
    },
  };
  app.use("/_parlor/sync/stream", () => {
    streams.count += 1;
  });
  registerSyncRoutes(app, {
    basePath: "/_parlor",
    data: handle,
    hub,
    scope: () => "acme",
    channels: [chat],
    keepAliveMs: 50,
    build: () => build,
    maxStreamMs,
  });
  const made = { app, hub, computers, streams };
  instances.push(made);
  return made;
}

/** Whatever answers a request: the old build until the deploy, the new one after, while a stream already open stays where it is. */
function deployment(before: Instance, after: Instance) {
  let current = before;
  return {
    deploy: () => {
      current = after;
    },
    request: (path: string, init?: RequestInit) =>
      Promise.resolve(current.app.fetch(new Request(`http://app.test${path}`, init))),
  };
}

function listen(request: (path: string, init?: RequestInit) => Promise<Response>) {
  const received: string[] = [];
  client = createSyncClient({
    request,
    safetyPollMs: 100,
    reconnectBaseMs: 1000,
    channels: [
      {
        event: "chat",
        opened: () => undefined,
        closed: () => undefined,
        receive: (data) => received.push(data),
      },
    ],
  });
  client.start();
  return received;
}

const push = (to: Instance, frame: string) => {
  for (const connection of to.computers) connection.send(frame);
};

describe("a deploy", () => {
  it("moves an open stream to the new build, so what the new build pushes arrives", async () => {
    const old = instance("build-a");
    const next = instance("build-b");
    const { deploy, request } = deployment(old, next);
    const received = listen(request);
    await vi.waitFor(() => expect(old.computers.size).toBe(1));

    deploy();
    await vi.waitFor(() => expect(next.computers.size).toBe(1), { timeout: 2000 });
    expect(old.computers.size).toBe(0);
    push(next, "turn for you");
    await vi.waitFor(() => expect(received).toEqual(["turn for you"]));
  });

  it("moves it once, even while both builds keep answering", async () => {
    const old = instance("build-a");
    const next = instance("build-b");
    const { deploy, request } = deployment(old, next);
    listen(request);
    await vi.waitFor(() => expect(old.streams.count).toBe(1));
    deploy();
    await vi.waitFor(() => expect(next.streams.count).toBe(1), { timeout: 2000 });
    client!.observeBuild("build-a");
    client!.observeBuild("build-b");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(next.streams.count).toBe(1);
  });

  it("leaves a stream alone when the server names no build", async () => {
    const old = instance(undefined);
    const next = instance(undefined);
    const { deploy, request } = deployment(old, next);
    listen(request);
    await vi.waitFor(() => expect(old.computers.size).toBe(1));
    deploy();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(old.computers.size).toBe(1);
    expect(next.streams.count).toBe(0);
  });
});

describe("a stream's lifetime", () => {
  it("ends it on time so an instance a deploy left behind drains, and the client reopens it", async () => {
    const old = instance("build-a", 200);
    const next = instance(undefined);
    const { deploy, request } = deployment(old, next);
    listen(request);
    await vi.waitFor(() => expect(old.computers.size).toBe(1));
    deploy();
    await vi.waitFor(() => expect(next.computers.size).toBe(1), { timeout: 3000 });
    expect(old.computers.size).toBe(0);
  });

  it("sends the build on every sync response", async () => {
    const one = instance("build-a");
    const token = await one.app.fetch(
      new Request("http://app.test/_parlor/sync/token", { method: "POST" }),
    );
    const poll = await one.app.fetch(new Request("http://app.test/_parlor/sync"));
    expect([token.headers.get(BUILD_HEADER), poll.headers.get(BUILD_HEADER)]).toEqual([
      "build-a",
      "build-a",
    ]);
  });
});
