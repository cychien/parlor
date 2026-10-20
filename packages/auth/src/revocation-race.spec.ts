import {
  asId,
  type AuthenticatedPrincipal,
  type HostPrincipal,
  type Principal,
} from "@parlor/core";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type Browser,
  createTestApp,
  ORIGIN,
  signUp as signUpAs,
  type TestApp,
} from "./testing/app.js";
import { type Computer, HELLO, pair } from "./testing/computer.js";
import { probePlugin } from "./testing/probe.js";

let database: DatabaseHandle;
let app: TestApp;

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
}, 30_000);

afterAll(async () => {
  await database.close();
});

beforeEach(() => {
  app = createTestApp(database, { plugins: [probePlugin] });
});

afterEach(async () => {
  await app.server.close();
});

async function eventually(check: () => Promise<boolean>, timeoutMs = 5000) {
  const started = performance.now();
  while (!(await check())) {
    if (performance.now() - started > timeoutMs)
      throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const refused = (attempt: () => Promise<Principal>) =>
  attempt().then(
    () => false,
    () => true,
  );

const signedIn = (principal: Principal): AuthenticatedPrincipal => {
  if (principal.kind === "anonymous") throw new Error("expected a signed-in principal");
  return principal;
};

const requestWith = (authorization: string) =>
  new Request(`${ORIGIN}${HELLO}`, { method: "POST", headers: { authorization } });

const assertionOf = async (computer: Computer) =>
  requestWith(`ParlorHost ${await computer.assertion({ url: `${ORIGIN}${HELLO}` })}`);

async function connected() {
  const alice = await signUpAs(app.server, "Alice");
  const computer = await pair(app.server, alice);
  const { grant, account } = computer.grant!;
  const host: HostPrincipal = {
    kind: "host",
    userId: account.userId,
    grantId: grant.id,
    hostId: grant.hostId,
  };
  return { alice, computer, host };
}

const sessionRequest = (alice: Browser) => requestWith(`Bearer ${alice.token!}`);

describe("a held stream's revocation watcher", () => {
  it("closes for a session revoked between authentication and registration", async () => {
    const { alice } = await connected();
    const principal = await app.provider.authenticate(sessionRequest(alice));
    expect(principal.kind).toBe("user");

    await alice.post("/_parlor/auth/sign-out", {});
    await eventually(() =>
      refused(() => app.provider.authenticate(sessionRequest(alice))),
    );

    const watcher = app.provider.revoked(signedIn(principal));
    await eventually(() => Promise.resolve(watcher.aborted));
    expect(watcher.aborted).toBe(true);
  });

  it("closes for a computer revoked between authentication and registration", async () => {
    const { alice, computer, host } = await connected();
    const principal = await app.provider.authenticate(await assertionOf(computer));
    expect(principal).toEqual(host);

    await alice.account("revokeHost", { hostId: host.hostId });
    await eventually(async () =>
      refused(async () => app.provider.authenticate(await assertionOf(computer))),
    );

    const watcher = app.provider.revoked(signedIn(principal));
    await eventually(() => Promise.resolve(watcher.aborted));
    expect(watcher.aborted).toBe(true);
  });

  it("closes for a turn token whose computer was revoked before registration", async () => {
    const { alice, host } = await connected();
    const delegation = await app.provider.delegate!(host, {
      threadId: asId("thread", "thr-1"),
      turnId: asId("turn", "trn-1"),
      clientId: "tab-1",
      agent: "Claude Code",
      ttlMs: 60_000,
    });
    const principal = await app.provider.authenticate(
      requestWith(`Bearer ${delegation.token}`),
    );
    expect(principal.kind).toBe("agent");

    await alice.account("revokeHost", { hostId: host.hostId });
    await eventually(() =>
      refused(() => app.provider.authenticate(requestWith(`Bearer ${delegation.token}`))),
    );

    const watcher = app.provider.revoked(signedIn(principal));
    await eventually(() => Promise.resolve(watcher.aborted));
    expect(watcher.aborted).toBe(true);
  });

  it("stays open for a principal nothing revoked", async () => {
    const { alice } = await connected();
    const principal = await app.provider.authenticate(sessionRequest(alice));
    const watcher = app.provider.revoked(signedIn(principal));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(watcher.aborted).toBe(false);
  });
});
