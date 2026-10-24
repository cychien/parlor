import { createHash } from "node:crypto";

import type { AgentUiClient } from "@parlor/agent-ui/client";
import { PresenceSetupCancelled } from "@parlor/capabilities";
import { encodeBase64url } from "@parlor/capabilities/encoding";
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
  checkPairingProof,
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
  answer: (request: Request) => Response | Promise<Response> | undefined = () =>
    undefined,
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
  answer?: (request: Request) => Response | Promise<Response> | undefined,
) {
  const { auth, calls } = client(deviceKey, answer);
  await auth.signUp({ name: "Alice", email: "alice@example.com", password: PASSWORD });
  await settled(auth);
  return { auth, calls };
}

describe("linking a device", () => {
  async function secondDevice(
    key = new TestDeviceKey(),
    answer?: (request: Request) => Response | Promise<Response> | undefined,
    email = "alice@example.com",
  ) {
    const { auth } = client(key, answer);
    await auth.signIn({ email, password: PASSWORD });
    await settled(auth);
    return auth;
  }

  it("A4: a new device shows a code, a linked one checks and vouches for it, and the new one sees it", async () => {
    const { auth: laptop } = await signedIn(new TestDeviceKey());
    await laptop.device();
    const phone = await secondDevice();
    expect(await phone.linkState()).toMatchObject({ vouched: false, pairing: false });
    const started = await phone.startLink();
    expect(started.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    const pending = await laptop.resolveLink(
      `${started.code.slice(0, 4).toLowerCase()}-${started.code.slice(4)}`,
    );
    expect(pending).toMatchObject({ id: started.deviceId, platform: "web" });
    expect(await laptop.canVouch()).toBe(true);
    await laptop.vouch(pending);
    expect(await phone.linkState()).toEqual({
      deviceId: started.deviceId,
      vouched: true,
      pairing: false,
    });
    const session = laptop.current();
    if (session.status !== "signed-in") throw new Error("signed out");
    const asHostSees = await app.provider.device!(
      asId("user", session.user.id),
      asId("device", started.deviceId),
    );
    expect(asHostSees?.vouches).toEqual([
      expect.objectContaining({
        voucher: (await laptop.device())!.id,
        commitment: pending.commitment,
      }),
    ]);
    await expect(laptop.resolveLink(started.code)).rejects.toThrow(/No device of yours/);
  });

  it("finds the device a scanned QR names by its id and whole commitment, and refuses an altered one", async () => {
    const { auth: laptop } = await signedIn(new TestDeviceKey());
    await laptop.device();
    const phone = await secondDevice();
    const started = await phone.startLink();
    const pending = await laptop.resolveLink({
      deviceId: started.deviceId,
      commitment: started.commitment,
    });
    expect(pending).toMatchObject({
      id: started.deviceId,
      commitment: started.commitment,
      code: started.code,
    });
    const altered = `${started.commitment.slice(0, -1)}${started.commitment.endsWith("A") ? "B" : "A"}`;
    await expect(
      laptop.resolveLink({ deviceId: started.deviceId, commitment: altered }),
    ).rejects.toThrow(/do not match/);
  });

  it("A3: refuses to vouch when the keys the app returns do not match the code", async () => {
    const other = await new TestDeviceKey().publicKeys({
      rpId: "hello.example",
      userId: "u",
      userName: "u",
      challenge: new Uint8Array([1]),
    });
    let token: string | undefined;
    const laptop = createAuthClient({
      baseUrl: ORIGIN,
      deviceKey: new TestDeviceKey(),
      session: {
        get: async () => token,
        set: async (next) => {
          token = next;
        },
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "POST") request.headers.set("origin", "tauri://localhost");
        const response = await server.fetch(request);
        if (!new URL(request.url).pathname.endsWith("/resolveDeviceLink"))
          return response;
        const body = (await response.json()) as { data: Record<string, unknown> };
        return Response.json({
          ...body,
          data: { ...body.data, signingKey: other.signing.publicKey },
        });
      },
    });
    await laptop.signUp({
      name: "Alice",
      email: "alice@example.com",
      password: PASSWORD,
    });
    await settled(laptop);
    await laptop.device();
    const phone = await secondDevice();
    const { code } = await phone.startLink();
    await expect(laptop.resolveLink(code)).rejects.toThrow(/do not match this code/);
    expect(await phone.linkState()).toMatchObject({ vouched: false });
  });

  it("S6: another account cannot find the code, and a device with no presence key cannot vouch", async () => {
    const { auth: laptop } = await signedIn(new TestDeviceKey(false));
    await laptop.device();
    const phone = await secondDevice();
    const { code, deviceId } = await phone.startLink();
    const { auth: bob } = client(new TestDeviceKey());
    await bob.signUp({ name: "Bob", email: "bob@example.com", password: PASSWORD });
    await settled(bob);
    await expect(bob.resolveLink(code)).rejects.toThrow(/No device of yours/);
    expect(await laptop.canVouch()).toBe(false);
    const pending = await laptop.resolveLink(code);
    expect(pending.id).toBe(deviceId);
    await expect(laptop.vouch(pending)).rejects.toMatchObject({ name: "LinkOnComputer" });
  });
});

describe("removing a device", () => {
  async function another(
    key: TestDeviceKey,
    answer?: (request: Request) => Response | Promise<Response> | undefined,
  ) {
    const { auth } = client(key, answer);
    await auth.signIn({ email: "alice@example.com", password: PASSWORD });
    await settled(auth);
    await auth.device();
    return auth;
  }

  it("A6: a linked device removes another with presence; it leaves the list and no computer gets its keys", async () => {
    const { auth: laptop } = await signedIn(new TestDeviceKey());
    const own = (await laptop.device())!;
    const phone = await another(new TestDeviceKey());
    const phoneId = (await phone.device())!.id;
    expect(
      (await laptop.listDevices()).map(({ id, current }) => ({ id, current })),
    ).toEqual(
      expect.arrayContaining([
        { id: own.id, current: true },
        { id: phoneId, current: false },
      ]),
    );
    await laptop.removeDevice(phoneId);
    expect((await laptop.listDevices()).map(({ id }) => id)).toEqual([own.id]);
    expect(await phone.linkState()).toEqual({ vouched: false, pairing: false });
    expect((await phone.startLink()).deviceId).not.toBe(phoneId);
    const session = laptop.current();
    if (session.status !== "signed-in") throw new Error("signed out");
    expect(
      await app.provider.device!(asId("user", session.user.id), asId("device", phoneId)),
    ).toBeUndefined();
    await expect(laptop.removeDevice(phoneId)).rejects.toThrow(/No device/);
  });

  it("D3: refuses a removal signed for another device, and a device with no presence key cannot remove", async () => {
    const tamper = async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      return server.fetch(
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify({ ...body, device: "someone-else" }),
        }),
      );
    };
    const { auth: laptop } = await signedIn(new TestDeviceKey(), (request) =>
      request.url.endsWith("/actions/removeDevice") ? tamper(request) : undefined,
    );
    await laptop.device();
    const phone = await another(new TestDeviceKey(false));
    const phoneId = (await phone.device())!.id;
    await expect(laptop.removeDevice(phoneId)).rejects.toThrow(/did not check out/);
    await expect(phone.removeDevice(phoneId)).rejects.toMatchObject({
      name: "LinkOnComputer",
    });
    expect((await laptop.listDevices()).map(({ id }) => id)).toContain(phoneId);
  });
});

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

  it("asks for setup while enrolling would make a passkey, and is ready once enrolled", async () => {
    const key = new TestDeviceKey();
    key.setup = "needed";
    const { auth } = await signedIn(key);
    expect(await auth.deviceSetup()).toBe("needed");
    await auth.device();
    expect(await auth.deviceSetup()).toBe("ready");
  });

  it("enrolls nothing when the passkey is cancelled, and enrolls on the next call", async () => {
    const key = new TestDeviceKey();
    key.cancelNext = true;
    const { auth, calls } = await signedIn(key);
    await expect(auth.device()).rejects.toBeInstanceOf(PresenceSetupCancelled);
    expect(calls.filter((call) => call.endsWith("/enrollDevice"))).toEqual([]);
    const device = await auth.device();
    expect(device?.keys.presenceKey).toBeDefined();
    expect(calls.filter((call) => call.endsWith("/enrollDevice"))).toHaveLength(1);
  });

  it("enrolls without a presence key when the user skips the passkey", async () => {
    const { auth } = await signedIn(new TestDeviceKey());
    const device = await auth.device({ presence: false });
    expect(device?.keys.presenceKey).toBeUndefined();
    const devices = await auth.account.call("devices", {});
    expect(devices).toEqual([expect.objectContaining({ id: device!.id })]);
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

  it("D4: signs a prompt with Face ID or Touch ID when asked, which a host that wants presence accepts", async () => {
    const { auth } = await signedIn(new TestDeviceKey());
    const device = (await auth.device())!;
    const plain = await device.signPrompt(prompt);
    const present = await device.signPrompt(prompt, { presence: true });
    expect([plain.signature.presence, present.signature.presence]).toEqual([
      "none",
      "user",
    ]);
    const pinned = await pinnedFor(auth, device.id);
    const verify = async (signed: typeof plain) =>
      verifyStatement(
        (await signedPrompt(PAGE, {
          id: asId("item", "p1"),
          threadId: prompt.threadId,
          turnId: prompt.turnId,
          seq: 1,
          at: signed.at,
          author: "user",
          kind: "prompt",
          body: { text: prompt.text, agent: prompt.agent, signed },
        }))!,
        pinned,
        { requirePresence: true, now: signed.at, maxAgeMs: 60_000 },
      );
    expect([await verify(plain), await verify(present)]).toEqual([
      "presence_required",
      "valid",
    ]);
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

  it("keeps the pairing secret the host's redirect puts on the URL, takes it off, and proves it on prompts", async () => {
    const secret = encodeBase64url(new Uint8Array(32).map((_, at) => at + 1));
    const stored = new Map<string, string>();
    page.localStorage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    };
    const replaceState = vi.fn();
    const scope = globalThis as { history?: unknown };
    scope.history = { state: null, replaceState };
    page.location = new URL(`${PAGE}/todos?x=1#parlor-host-pairing=${secret}`);
    try {
      const { auth } = await signedIn(new TestDeviceKey());
      expect(stored.get("parlor:host-pairing")).toBe(secret);
      expect(replaceState).toHaveBeenCalledWith(null, "", "/todos?x=1");
      const device = (await auth.device())!;
      const signed = await device.signPrompt(prompt);
      expect(
        await checkPairingProof(
          secret,
          signed.pairing!,
          device.id,
          device.keys.signingKey,
        ),
      ).toBe(true);
    } finally {
      page.location = new URL(PAGE);
      delete scope.history;
    }
  });

  it("proves no pairing on a prompt from a browser the host never redirected", async () => {
    const { auth } = await signedIn(new TestDeviceKey());
    const signed = await (await auth.device())!.signPrompt(prompt);
    expect(signed).not.toHaveProperty("pairing");
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

  it("T6-07: lets the chat send one unsigned prompt without an error against a backend without device actions (regression-guard)", async () => {
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
      onResume: () => () => undefined,
      onNegotiated: () => () => undefined,
      transport: () => undefined,
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
        { presence: true },
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
