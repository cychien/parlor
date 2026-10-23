import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import type { DatabaseHandle } from "@parlor/data";
import { createServer, type FrameworkServer, type ServerOptions } from "@parlor/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { AUTH_UNDEFINED, chat, UNAVAILABLE_WITHOUT_AUTH } from "./index.js";
import { agentRef, openDatabase, resetDatabase, testAuth } from "./spec-kit.js";

const actions = createRegistry({
  ping: defineAction({
    description: "Answer pong.",
    input: z.object({}),
    run: () => ({ pong: true }),
  }),
});

const promptTo = (hostId: string) => ({
  threadId: "t1",
  turnId: "u1",
  itemId: "p1",
  clientId: "tab",
  prompt: { text: "hello", agent: { ...agentRef, hostId } },
});

describe("chat() in a server without sign-in", () => {
  let handle: DatabaseHandle;
  let server: FrameworkServer | undefined;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    handle = await openDatabase({ name: "pglite" });
  }, 60_000);
  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await resetDatabase(handle);
    vi.stubEnv("PARLOR_DEV", "");
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  const start = (options: Partial<ServerOptions<typeof actions>> = {}) => {
    const database = {
      read: () => handle.read(),
      transaction: handle.transaction.bind(handle),
    } as const;
    server = createServer({ actions, database, plugins: [chat()], ...options });
    return server;
  };

  const call = async (path: string, init: RequestInit = {}, authorization?: string) => {
    const response = await server!.fetch(
      new Request(`http://app.test/_parlor/${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(authorization ? { authorization } : {}),
        },
      }),
    );
    return { status: response.status, body: (await response.json()) as unknown };
  };
  const post = (path: string, body: unknown, authorization?: string) =>
    call(path, { method: "POST", body: JSON.stringify(body) }, authorization);

  it("starts, serves the app, answers chat with not_found and logs one line", async () => {
    start();
    expect(await post("actions/ping", {})).toEqual({
      status: 200,
      body: { data: { pong: true }, tags: [] },
    });
    expect((await call("manifest")).status).toBe(200);
    const open = await post("chat/actions/open", {});
    expect(open.status).toBe(404);
    await server!.close();
    start({ plugins: [] });
    expect(await post("chat/actions/open", {})).toEqual(open);
    expect(warn.mock.calls).toEqual([[UNAVAILABLE_WITHOUT_AUTH]]);
    expect(UNAVAILABLE_WITHOUT_AUTH).toBe(
      "chat() is unavailable: no auth provider is configured, so every action runs without a signed-in user.",
    );
  });

  it("refuses to start when the auth option is present but undefined", () => {
    expect(() => start({ auth: undefined })).toThrow(AUTH_UNDEFINED);
    expect(AUTH_UNDEFINED.startsWith("auth is undefined.")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  const hello = (authorization: string) =>
    post(
      "chat/actions/hostHello",
      {
        protocols: { min: 2, max: 2 },
        hostVersion: "1",
        name: "Mac",
        platform: "darwin",
        agents: [{ id: agentRef.agentId, name: "Claude Code", ready: true }],
      },
      authorization,
    );

  const devHostToken = async () => {
    const request = new Request("http://app.test/_parlor/dev-auth/host", {
      method: "POST",
    });
    Object.defineProperty(request, "ip", { value: "127.0.0.1" });
    const response = await server!.fetch(request);
    const { token } = (await response.json()) as { token: string };
    return `ParlorHost ${token}`;
  };

  it("keeps a booted app with devAuth unchanged under PARLOR_DEV=1", async () => {
    vi.stubEnv("PARLOR_DEV", "1");
    start();
    expect((await hello(await devHostToken())).status).toBe(200);
    expect((await post("chat/actions/open", { threadId: "t1" })).status).toBe(200);
    expect(await post("chat/actions/send", promptTo("dev"))).toMatchObject({
      status: 200,
      body: { data: expect.anything() },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a booted app with a delegating provider unchanged", async () => {
    start({ auth: testAuth() });
    expect((await hello("Bearer alice-host")).status).toBe(200);
    expect(
      (await post("chat/actions/open", { threadId: "t1" }, "Bearer alice")).status,
    ).toBe(200);
    expect(
      await post("chat/actions/send", promptTo(agentRef.hostId), "Bearer alice"),
    ).toMatchObject({
      status: 200,
      body: { data: expect.anything() },
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
