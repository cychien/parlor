import { createHash } from "node:crypto";

import type { SessionSnapshot } from "@parlor/client";
import { asId } from "@parlor/core";
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

function client(deviceKey?: TestDeviceKey) {
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
      return server.fetch(request);
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

async function signedIn(deviceKey?: TestDeviceKey) {
  const { auth, calls } = client(deviceKey);
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
});
