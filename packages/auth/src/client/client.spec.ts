import type { SessionSnapshot } from "@parlor/client";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import type { FrameworkServer } from "@parlor/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestApp, ORIGIN, PASSWORD, signUp } from "../testing/app.js";
import { Computer } from "../testing/computer.js";
import { type AuthClient, createAuthClient, type SessionStore } from "./index.js";

let database: DatabaseHandle;
let server: FrameworkServer;

const page = globalThis as { window?: unknown };

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
  // PGlite takes itself for a browser while it starts if `window` exists, so start it first.
  await database.db.execute("select 1");
  // Better Auth's client fetches the session on mount only in a browser, which it detects by `window`.
  page.window = globalThis;
}, 30_000);

afterAll(async () => {
  delete page.window;
  await database.close();
});

beforeEach(() => {
  server = createTestApp(database).server;
});

afterEach(async () => {
  await server.close();
});

function memoryStore(): SessionStore & { token: string | undefined } {
  return {
    token: undefined,
    get() {
      return Promise.resolve(this.token);
    },
    set(token) {
      this.token = token;
      return Promise.resolve();
    },
  };
}

/** A native shell: the backend is another origin, so the session is a bearer token in a store. */
function shell({ unreachableFor = 0 } = {}) {
  const store = memoryStore();
  let failures = unreachableFor;
  const auth = createAuthClient({
    baseUrl: ORIGIN,
    session: store,
    fetch: (input, init) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new TypeError("fetch failed"));
      }
      const request = new Request(input, init);
      if (request.method === "POST") request.headers.set("origin", "tauri://localhost");
      return server.fetch(request);
    },
  });
  return { auth, store };
}

function settled(auth: AuthClient): Promise<SessionSnapshot> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      stop();
      reject(new Error("the session never settled"));
    }, 10_000);
    const check = () => {
      const session = auth.current();
      if (session.status === "loading") return;
      clearTimeout(deadline);
      queueMicrotask(stop);
      resolve(session);
    };
    const stop = auth.subscribe(check);
    check();
  });
}

describe("the auth client in a native shell", () => {
  it("keeps a bearer session in its store and signs every surface with it", async () => {
    const { auth, store } = shell();
    await auth.signUp({ name: "Alice", email: "alice@example.com", password: PASSWORD });
    expect(store.token).toBeTruthy();
    expect(await auth.headers()).toEqual({ authorization: `Bearer ${store.token}` });
    const sessions = await auth.account.call("sessions", {});
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.current).toBe(true);
    expect(await settled(auth)).toMatchObject({
      status: "signed-in",
      user: { email: "alice@example.com" },
    });

    await auth.signOut();
    expect(store.token).toBeUndefined();
    expect(await auth.headers()).toEqual({});
  });

  it("reports a wrong password and stores nothing", async () => {
    await signUp(server, "Alice");
    const { auth, store } = shell();
    await expect(
      auth.signIn({ email: "alice@example.com", password: "wrong password here" }),
    ).rejects.toMatchObject({ name: "AuthClientError", status: 401 });
    expect(store.token).toBeUndefined();
  });

  it("waits out an unreachable server instead of signing the user out", async () => {
    const signedUp = await signUp(server, "Alice");
    const { auth, store } = shell({ unreachableFor: 2 });
    await store.set(signedUp.token);
    const seen: string[] = [];
    const stop = auth.subscribe(() => seen.push(auth.current().status));
    try {
      expect(await settled(auth)).toMatchObject({ status: "signed-in" });
    } finally {
      stop();
    }
    expect(seen).not.toContain("signed-out");
    expect(store.token).toBe(signedUp.token);
  }, 15_000);

  it("approves a computer's pairing with its session and answers the code", async () => {
    const { auth } = shell();
    await auth.signUp({ name: "Alice", email: "alice@example.com", password: PASSWORD });
    const computer = new Computer("Alice's Mac", "macos", "urn:parlor:ipc");
    const { redirectUri: _ipc, ...pairing } = await computer.pairing();

    const code = await auth.authorizeHost(pairing);

    const exchanged = await computer.exchange(server, code);
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.account).toMatchObject({ email: "alice@example.com" });
    const hosts = await auth.account.call("hosts", {});
    expect(hosts.map((host) => host.name)).toEqual(["Alice's Mac"]);
  });

  it("refuses to approve a pairing without a session", async () => {
    const { auth } = shell();
    const computer = new Computer("Alice's Mac", "macos", "urn:parlor:ipc");
    const { redirectUri: _ipc, ...pairing } = await computer.pairing();
    await expect(auth.authorizeHost(pairing)).rejects.toMatchObject({
      name: "AuthClientError",
      status: 401,
    });
  });

  it("drops a token the server revoked", async () => {
    const laptop = await signUp(server, "Alice");
    const { auth, store } = shell();
    await auth.signIn({ email: "alice@example.com", password: PASSWORD });
    const sessions = (await laptop.account("sessions")).body.data as {
      id: string;
      current: boolean;
    }[];
    const phone = sessions.find((session) => !session.current)!;
    await laptop.account("revokeSession", { id: phone.id });
    expect(await settled(auth)).toEqual({ status: "signed-out" });
    expect(store.token).toBeUndefined();
  });
});
