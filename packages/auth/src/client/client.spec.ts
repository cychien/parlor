import type { SessionSnapshot } from "@parlor/client";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { createServer, type FrameworkServer } from "@parlor/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Browser, createTestApp, ORIGIN, PASSWORD, signUp } from "../testing/app.js";
import { Computer } from "../testing/computer.js";
import { type AuthClient, createAuthClient, parseComputerConnection } from "./index.js";

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

/** A page of the app: the tab keeps its cookies, and the network may be down for a while. */
function tab({ browser = new Browser(server), unreachableFor = 0 } = {}) {
  let failures = unreachableFor;
  const auth = createAuthClient({
    baseUrl: ORIGIN,
    fetch: (input, init) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new TypeError("fetch failed"));
      }
      return browser.asFetch(input, init);
    },
  });
  return { auth, browser };
}

async function sessionOf(browser: Browser): Promise<unknown> {
  return (await browser.fetch("/_parlor/auth/get-session")).json();
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

describe("the auth client on a page", () => {
  it("keeps the session in the tab's cookie and reads the account with it", async () => {
    const { auth, browser } = tab();
    await auth.signUp({ name: "Alice", email: "alice@example.com", password: PASSWORD });
    expect(await sessionOf(browser)).toMatchObject({
      user: { email: "alice@example.com" },
    });
    expect(await auth.headers()).toEqual({});
    const sessions = await auth.account.call("sessions", {});
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.current).toBe(true);
    expect(await settled(auth)).toMatchObject({
      status: "signed-in",
      user: { email: "alice@example.com" },
    });

    await auth.signOut();
    expect(await sessionOf(browser)).toBeNull();
  });

  it("reports a wrong password and signs nobody in", async () => {
    await signUp(server, "Alice");
    const { auth, browser } = tab();
    await expect(
      auth.signIn({ email: "alice@example.com", password: "wrong password here" }),
    ).rejects.toMatchObject({ name: "AuthClientError", status: 401 });
    expect(await sessionOf(browser)).toBeNull();
  });

  it("reports an anonymous session, without retrying, when the server runs without auth", async () => {
    const bare = createServer({ actions: createRegistry({}) });
    let asked = 0;
    const auth = createAuthClient({
      baseUrl: ORIGIN,
      fetch: (input, init) => {
        asked += 1;
        return bare.fetch(new Request(input, init));
      },
    });
    try {
      expect(await settled(auth)).toEqual({ status: "anonymous" });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(asked).toBe(1);
    } finally {
      await bare.close();
    }
  });

  it("waits out an unreachable server instead of signing the user out", async () => {
    const signedUp = await signUp(server, "Alice");
    const { auth } = tab({ browser: signedUp, unreachableFor: 2 });
    const seen: string[] = [];
    const stop = auth.subscribe(() => seen.push(auth.current().status));
    try {
      expect(await settled(auth)).toMatchObject({ status: "signed-in" });
    } finally {
      stop();
    }
    expect(seen).not.toContain("signed-out");
    expect(await sessionOf(signedUp)).toMatchObject({
      user: { email: "alice@example.com" },
    });
  }, 15_000);

  it("answers a request from the app's connect page with where the computer waits", async () => {
    const { auth } = tab();
    await auth.signUp({ name: "Alice", email: "alice@example.com", password: PASSWORD });
    const computer = new Computer("Alice's Mac", "macos");
    const query = `${await computer.authorizeQuery()}&agentTools=offered`;
    const parsed = parseComputerConnection(`?${query}`);
    expect(parsed?.step).toBe("confirm");
    if (parsed?.step !== "confirm") return;
    expect(parsed.request).toMatchObject({
      hostName: "Alice's Mac",
      platform: "macos",
      offersAgentTools: true,
    });

    const location = new URL(
      await auth.answerComputerConnection(parsed.request, "connect", {
        agentTools: false,
      }),
    );

    expect(location.searchParams.get("state")).toBe(computer.state);
    expect(location.searchParams.get("agentTools")).toBe("off");
    const exchanged = await computer.exchange(server, location.searchParams.get("code")!);
    expect(exchanged.status).toBe(200);
  });

  it("refuses to answer a connect request without a session", async () => {
    const { auth } = tab();
    const parsed = parseComputerConnection(`?${await new Computer().authorizeQuery()}`);
    if (parsed?.step !== "confirm") throw new Error("expected a request to confirm");
    await expect(
      auth.answerComputerConnection(parsed.request, "connect"),
    ).rejects.toMatchObject({ name: "AuthClientError", status: 401 });
  });

  it("signs out once the server revoked the session", async () => {
    const laptop = await signUp(server, "Alice");
    const { auth } = tab();
    await auth.signIn({ email: "alice@example.com", password: PASSWORD });
    const sessions = (await laptop.account("sessions")).body.data as {
      id: string;
      current: boolean;
    }[];
    const phone = sessions.find((session) => !session.current)!;
    await laptop.account("revokeSession", { id: phone.id });
    expect(await settled(auth)).toEqual({ status: "signed-out" });
  });
});

describe("parseComputerConnection", () => {
  it("reads the connected step and the name the agents know the app by", () => {
    expect(parseComputerConnection("?connected=1&agentTools=tallyo")).toEqual({
      step: "connected",
      agentTools: "tallyo",
    });
  });

  it("knows nothing of a query missing a pairing field", async () => {
    const query = new URLSearchParams(await new Computer().authorizeQuery());
    query.delete("keyThumbprint");
    expect(parseComputerConnection(`?${query}`)).toBeUndefined();
    expect(parseComputerConnection("")).toBeUndefined();
  });
});
