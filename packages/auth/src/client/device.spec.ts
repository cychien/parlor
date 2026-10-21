import { createHash } from "node:crypto";

import type { AgentUiClient } from "@parlor/agent-ui/client";
import type { SessionSnapshot } from "@parlor/client";
import { asId, type Tag } from "@parlor/core";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import type { FrameworkServer } from "@parlor/server";
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

// Relative: `createChatRuntime` is internal to `@parlor/client`, and a dependency back would cycle.
import { createChatRuntime } from "../../../client/src/react/chat/runtime.js";
import {
  promptStatement,
  signedPrompt,
  statementBytes,
  verifyStatement,
} from "../statements.js";
import { createTestApp, ORIGIN, PASSWORD, type TestApp } from "../testing/app.js";
import { TestDeviceKey } from "../testing/device.js";
import { type AuthClient, createAuthClient, type SessionStore } from "./index.js";

const PAGE = "https://hello.example";
const page = globalThis as {
  window?: unknown;
  location?: unknown;
  localStorage?: unknown;
};

let database: DatabaseHandle;
let app: TestApp;
let server: FrameworkServer;

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
  await database.db.execute("select 1");
  page.window = globalThis;
  page.location = new URL(PAGE);
}, 30_000);

afterAll(async () => {
  delete page.window;
  delete page.location;
  await database.close();
});

beforeEach(() => {
  app = createTestApp(database);
  server = app.server;
});

afterEach(async () => {
  delete page.localStorage;
  vi.restoreAllMocks();
  await server.close();
});

const DEVICE_ACTIONS = ["deviceChallenge", "enrollDevice"];

const withoutDeviceActions = (request: Request): Response | undefined =>
  DEVICE_ACTIONS.some((name) => request.url.endsWith(`/actions/${name}`))
    ? Response.json(
        { error: { code: "not_found", message: "Unknown action" } },
        { status: 404 },
      )
    : undefined;

function client(
  deviceKey?: TestDeviceKey,
  answer: (request: Request) => Response | undefined = () => undefined,
) {
  const calls: string[] = [];
  let token: string | undefined;
  const store: SessionStore = {
    get: () => Promise.resolve(token),
    set: (next) => {
      token = next;
      return Promise.resolve();
    },
  };
  const auth = createAuthClient({
    baseUrl: ORIGIN,
    session: store,
    ...(deviceKey ? { deviceKey } : {}),
    fetch: (input, init) => {
      const request = new Request(input, init);
      calls.push(new URL(request.url).pathname.replace("/_parlor/auth/", ""));
      if (request.method === "POST") request.headers.set("origin", "tauri://localhost");
      return Promise.resolve(answer(request) ?? server.fetch(request));
    },
  });
  return { auth, calls };
}

function settled(auth: AuthClient): Promise<SessionSnapshot> {
  return new Promise((resolve) => {
    const check = () => {
      const session = auth.current();
      if (session.status === "loading") return;
      queueMicrotask(stop);
      resolve(session);
    };
    const stop = auth.subscribe(check);
    check();
  });
}

async function signedIn(
  deviceKey?: TestDeviceKey,
  answer?: (request: Request) => Response | undefined,
) {
  const { auth, calls } = client(deviceKey, answer);
  await auth.signUp({ name: "Alice", email: "alice@example.com", password: PASSWORD });
  await settled(auth);
  return { auth, calls };
}

describe("the auth client's device", () => {
  it("is nothing while nobody is signed in", async () => {
    const { auth } = client(new TestDeviceKey());
    expect(await settled(auth)).toMatchObject({ status: "signed-out" });
    expect(await auth.device()).toBeUndefined();
  });

  it("is nothing where this platform has no device key", async () => {
    const { auth } = await signedIn();
    expect(await auth.device()).toBeUndefined();
  });

  it("enrolls on first use, once, and registers the keys the device proved it holds", async () => {
    const { auth, calls } = await signedIn(new TestDeviceKey());
    expect(calls.filter((call) => call.startsWith("actions/"))).toEqual([]);
    const device = await auth.device();
    expect(await auth.device()).toBe(device);
    expect(calls.filter((call) => call.startsWith("actions/"))).toEqual([
      "actions/deviceChallenge",
      "actions/enrollDevice",
    ]);
    const devices = await auth.account.call("devices", {});
    expect(devices).toEqual([
      expect.objectContaining({ id: device!.id, platform: "web" }),
    ]);
  });

  it("R5-04: shares one enrollment between calls made at once", async () => {
    const { auth, calls } = await signedIn(new TestDeviceKey());
    const [first, second] = await Promise.all([auth.device(), auth.device()]);
    expect(second).toBe(first);
    expect(calls.filter((call) => call.startsWith("actions/"))).toEqual([
      "actions/deviceChallenge",
      "actions/enrollDevice",
    ]);
  });

  async function pinnedFor(auth: AuthClient, deviceId: string) {
    const whoami = await server.fetch(
      new Request(`${ORIGIN}/_parlor/actions/whoami`, {
        method: "POST",
        headers: {
          ...Object.fromEntries(new Headers(await auth.headers())),
          "content-type": "application/json",
          origin: ORIGIN,
        },
        body: "{}",
      }),
    );
    const { userId } = (await whoami.json()).data.principal;
    const keys = (await app.provider.device!(
      asId("user", userId),
      asId("device", deviceId),
    ))!;
    return {
      deviceId: keys.id,
      signingKey: keys.signingKey,
      presenceKey: keys.presenceKey,
    };
  }

  const prompt = {
    threadId: asId("thread", "t1"),
    turnId: asId("turn", "u1"),
    agent: { hostId: asId("host", "mac"), agentId: "claude" },
    text: "run ls",
  };
  const maxAge = { requirePresence: false, now: Date.now(), maxAgeMs: 60_000 };

  it("signs a prompt the host rebuilds from the logged item and verifies with the account's keys", async () => {
    const { auth } = await signedIn(new TestDeviceKey());
    const device = (await auth.device())!;
    const before = Date.now();
    const signed = await device.signPrompt(prompt);
    expect(signed).toMatchObject({ deviceId: device.id });
    expect(signed.at).toBeGreaterThanOrEqual(before);
    const rebuilt = await signedPrompt(PAGE, {
      id: asId("item", "p1"),
      threadId: prompt.threadId,
      turnId: prompt.turnId,
      seq: 1,
      at: signed.at,
      author: "user",
      kind: "prompt",
      body: { text: prompt.text, agent: prompt.agent, signed },
    });
    expect(rebuilt?.statement).toMatchObject({
      app: PAGE,
      kind: "prompt",
      at: signed.at,
    });
    const pinned = await pinnedFor(auth, device.id);
    expect(await verifyStatement(rebuilt!, pinned, { ...maxAge, now: signed.at })).toBe(
      "valid",
    );
  });

  it("signs an answer with presence only when asked to", async () => {
    const { auth } = await signedIn(new TestDeviceKey());
    const device = (await auth.device())!;
    const answer = {
      threadId: prompt.threadId,
      askId: asId("item", "u1.1"),
      choice: "yes",
    };
    const plain = await device.signAnswer(answer, { presence: false });
    const present = await device.signAnswer(answer, { presence: true });
    expect([plain.signature.presence, present.signature.presence]).toEqual([
      "none",
      "user",
    ]);
    const pinned = await pinnedFor(auth, device.id);
    const { answerStatement } = await import("../statements.js");
    const verify = async (signed: typeof plain, requirePresence: boolean) =>
      verifyStatement(
        {
          statement: await answerStatement(PAGE, answer, signed.at),
          deviceId: signed.deviceId,
          signature: signed.signature,
        },
        pinned,
        { requirePresence, now: signed.at, maxAgeMs: 60_000 },
      );
    expect(await verify(plain, true)).toBe("presence_required");
    expect(await verify(present, true)).toBe("valid");
  });

  it("logs the digest of what it signed when the page asks for it", async () => {
    const { auth } = await signedIn(new TestDeviceKey());
    const device = (await auth.device())!;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await device.signPrompt(prompt);
    expect(info).not.toHaveBeenCalled();
    page.localStorage = {
      getItem: (key: string) => (key === "parlor:debug" ? "statements" : null),
    };
    const signed = await device.signPrompt(prompt);
    const statement = await promptStatement(PAGE, prompt, signed.at);
    expect(info).toHaveBeenCalledWith(
      `[parlor] signed prompt sha256=${createHash("sha256").update(statementBytes(statement)).digest("hex")}`,
    );
  });
  it("T6-07: resolves nothing, and tries again next time, against a backend without device actions", async () => {
    let older = true;
    const { auth, calls } = await signedIn(new TestDeviceKey(), (request) =>
      older ? withoutDeviceActions(request) : undefined,
    );
    expect(await auth.device()).toBeUndefined();
    expect(calls.filter((call) => call.startsWith("actions/"))).toEqual([
      "actions/deviceChallenge",
    ]);
    older = false;
    expect(await auth.device()).toMatchObject({ id: expect.any(String) });
  });

  it("T6-07: lets the chat send one unsigned prompt without an error against a backend without device actions", async () => {
    const { auth } = await signedIn(new TestDeviceKey(), withoutDeviceActions);
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const host = {
      id: asId("host", "mac"),
      name: "Alice's Mac",
      platform: "macos",
      online: true,
      agents: [{ id: "claude", name: "Claude Code", ready: true }],
    };
    const thread = { id: asId("thread", "t1"), title: "t1", updatedAt: 1, lastSeq: 1 };
    const snapshot = {
      threads: [thread],
      hosts: [host],
      page: { thread, items: [], open: [], turns: [], hasMore: false },
    };
    const runtime = createChatRuntime({
      calls: {
        call: async (name: string, input: Record<string, unknown>) => {
          sent.push({ name, input });
          return name === "open" ? snapshot : name === "send" ? { id: "t1" } : [];
        },
        invoke: vi.fn(),
      } as never,
      clientId: "tab-1",
      appOrigin: PAGE,
      agentUi: {
        watch: () => () => undefined,
        confirmations: { get: () => [], subscribe: () => () => undefined },
      } as unknown as AgentUiClient,
      addChannel: () => () => undefined,
      onSyncTags: (_listener: (tags: readonly Tag[]) => void) => () => undefined,
      auth,
      localHost: Promise.resolve({ available: false, reason: "no host" }),
      threadId: undefined,
    });
    runtime.start();
    await vi.waitFor(() => expect(runtime.get().status).toBe("idle"));
    await runtime.send("hello");
    const sends = sent.filter((call) => call.name === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.input.prompt).toEqual({
      text: "hello",
      agent: { hostId: "mac", agentId: "claude" },
    });
    expect(runtime.get().error).toBeUndefined();
  });

  it("still rejects a device action that fails for any other reason", async () => {
    const { auth } = await signedIn(new TestDeviceKey(), (request) =>
      request.url.endsWith("/actions/deviceChallenge")
        ? Response.json({ error: { code: "internal", message: "boom" } }, { status: 500 })
        : undefined,
    );
    await expect(auth.device()).rejects.toMatchObject({ code: "internal" });
  });

  describe("the origin a statement names", () => {
    afterEach(() => {
      page.location = new URL(PAGE);
    });

    it("T6-05: is the page's origin in a browser, whatever server the page talks to", async () => {
      const { auth } = await signedIn(new TestDeviceKey());
      const device = (await auth.device())!;
      const signed = await device.signPrompt(prompt);
      const statement = await promptStatement(PAGE, prompt, signed.at);
      const pinned = await pinnedFor(auth, device.id);
      expect(
        await verifyStatement(
          { statement, deviceId: signed.deviceId, signature: signed.signature },
          pinned,
          { ...maxAge, now: signed.at },
        ),
      ).toBe("valid");
    });

    it("is the backend's origin in a shell, and its passkey is made for that site", async () => {
      page.location = new URL("tauri://app.local");
      const key = new TestDeviceKey();
      const enrolled = vi.spyOn(key, "publicKeys");
      const { auth } = await signedIn(key);
      const device = (await auth.device())!;
      expect(enrolled).toHaveBeenCalledWith(
        expect.objectContaining({ rpId: new URL(ORIGIN).hostname }),
      );
      const signed = await device.signPrompt(prompt);
      const statement = await promptStatement(ORIGIN, prompt, signed.at);
      const pinned = await pinnedFor(auth, device.id);
      expect(
        await verifyStatement(
          { statement, deviceId: signed.deviceId, signature: signed.signature },
          pinned,
          { ...maxAge, now: signed.at },
        ),
      ).toBe("valid");
    });
  });
});
