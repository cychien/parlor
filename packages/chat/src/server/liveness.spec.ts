import type { HostPrincipal, Tag } from "@parlor/core";
import type { DatabaseHandle } from "@parlor/data";
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

import type { ChatOwner } from "../model.js";
import { CONNECTED_TTL_MS, connectedLiveness, type Liveness } from "./liveness.js";
import {
  alice,
  type ChatServer,
  data,
  drivers,
  openDatabase,
  resetDatabase,
  rows,
  serveChat,
  TOKENS,
} from "./spec-kit.js";
import { type ChatStore, type StoredClaim, sqlChatStore } from "./store.js";

/** Short enough to wait out, long enough that a busy machine still gets several heartbeats into one grace. */
const HEARTBEAT_MS = 200;
const GRACE_MS = 2 * HEARTBEAT_MS;

const owner: ChatOwner = { scope: alice, userId: alice };
const mac = TOKENS["alice-host"] as HostPrincipal;
const pc = TOKENS["alice-host-2"] as HostPrincipal;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.each(drivers)("the app's only server's liveness on $name", (driver) => {
  let handle: DatabaseHandle;
  let liveness: Liveness;
  /** A second server on the same database, as a deploy starts beside the one it replaces. */
  let successor: Liveness;
  let announced: { owner: ChatOwner; tags: readonly Tag[] }[];
  let heartbeats: number;
  let reconciled: number;
  let claim: StoredClaim | undefined;

  beforeAll(async () => {
    handle = await openDatabase(driver, true);
  }, 60_000);
  afterAll(() => handle.close());

  let revocations: Map<string, AbortController>;
  const revocationOf = (grantId: string) => {
    let controller = revocations.get(grantId);
    if (!controller) revocations.set(grantId, (controller = new AbortController()));
    return controller;
  };

  beforeEach(async () => {
    revocations = new Map();
    await resetDatabase(handle);
    const migrating = serveChat(handle);
    await migrating.action("alice", "hosts", {});
    await migrating.server.close();
    announced = [];
    heartbeats = 0;
    reconciled = 0;
    claim = undefined;
    const store: ChatStore = {
      ...sqlChatStore,
      heartbeat: (...args) => {
        heartbeats += 1;
        return sqlChatStore.heartbeat(...args);
      },
      claimTurn: () => Promise.resolve(claim),
    };
    const server = () =>
      connectedLiveness({
        store,
        db: () => handle.db,
        heartbeatMs: HEARTBEAT_MS,
        reconcile: () => {
          reconciled += 1;
          return Promise.resolve();
        },
        announce: (to, tags) => {
          announced.push({ owner: to, tags });
          return Promise.resolve();
        },
        ready: () => Promise.resolve(),
        revoked: (host) => revocationOf(host.grantId).signal,
      });
    liveness = server();
    successor = server();
  }, 60_000);
  afterEach(async () => {
    await liveness.close();
    await successor.close();
  });

  const report = (host: HostPrincipal, online = true) =>
    sqlChatStore.reportHost(handle.db, owner, host, {
      protocol: 5,
      name: host.hostId,
      platform: "darwin",
      agents: [],
      online,
      ttlMs: liveness.onlineTtlMs,
    });
  /** As `hostHello` does: the row, then the word to the liveness. */
  const hello = async (host: HostPrincipal, to: Liveness = liveness) => {
    const { written } = await report(host);
    to.reported(owner, host, true, written);
  };
  const online = async (host: HostPrincipal) =>
    (
      (await rows(
        handle,
        `select online_until > now() and announced_online as online from parlor_chat_hosts where id = '${host.hostId}'`,
      )) as { online: boolean }[]
    )[0]?.online;
  const hostTags = () => announced.map(({ tags }) => tags);
  const gone = (host: HostPrincipal) =>
    vi.waitFor(async () => expect(await online(host)).toBe(false), { timeout: 5000 });

  /** A heartbeat with the computer's credential, as its first one is. */
  const beat = (host: HostPrincipal, to: Liveness = liveness) => to.beat!(owner, host);
  const keepBeating = (token: string, of: Liveness = liveness) => {
    const timer = setInterval(() => of.heard!(token), HEARTBEAT_MS / 5);
    return () => clearInterval(timer);
  };

  it("holds a computer's word for as long as it stays, and takes its heartbeats itself", () => {
    expect(liveness.onlineTtlMs).toBe(CONNECTED_TTL_MS);
    expect(liveness.beat).toBeTypeOf("function");
    expect(liveness.heard).toBeTypeOf("function");
  });

  it("answers a heartbeat with a token, and writes nothing for a computer the database has online", async () => {
    await hello(mac);
    const token = await beat(mac);
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(await beat(mac)).toBe(token);
    expect(liveness.heard!(token)).toBe(true);
    expect(liveness.heard!("not a token it gave")).toBe(false);
    expect(heartbeats).toBe(0);
    expect(announced).toEqual([]);
    expect(await online(mac)).toBe(true);
  });

  it("stops taking a computer's token the moment its grant is revoked", async () => {
    await hello(mac);
    const token = await beat(mac);
    expect(liveness.heard!(token)).toBe(true);
    revocationOf(mac.grantId).abort();
    expect(liveness.heard!(token)).toBe(false);
  });

  it("gives a computer whose grant is already revoked no token that works", async () => {
    revocationOf(mac.grantId).abort();
    const token = await beat(mac);
    expect(liveness.heard!(token)).toBe(false);
  });

  it("gives each computer its own token", async () => {
    await hello(mac);
    await hello(pc);
    expect(await beat(mac)).not.toBe(await beat(pc));
  });

  it("writes a computer it had not heard of online once, and announces one that was offline", async () => {
    await report(mac, false);
    await beat(mac);
    await beat(mac);
    expect(heartbeats).toBe(1);
    expect(hostTags()).toEqual([[["parlor_chat_hosts", "mac"]]]);
    expect(await online(mac)).toBe(true);
  });

  it("keeps a computer online for as long as its token heartbeats come, writing nothing", async () => {
    await hello(mac);
    const stop = keepBeating(await beat(mac));
    await pause(GRACE_MS * 3);
    stop();
    expect(await online(mac)).toBe(true);
    expect(announced).toEqual([]);
    expect(heartbeats).toBe(0);
  });

  it("marks a computer offline and announces it once, a grace after its last heartbeat", async () => {
    await hello(mac);
    const token = await beat(mac);
    await pause(HEARTBEAT_MS);
    liveness.heard!(token);
    await pause(HEARTBEAT_MS);
    expect(await online(mac)).toBe(true);
    await gone(mac);
    await pause(GRACE_MS);
    expect(hostTags()).toEqual([[["parlor_chat_hosts", "mac"]]]);
    expect(liveness.heard!(token)).toBe(false);
  });

  it("writes a computer that returns after it was dropped online again and announces it", async () => {
    await hello(mac);
    const token = await beat(mac);
    await gone(mac);
    expect(liveness.heard!(token)).toBe(false);
    const again = await beat(mac);
    expect(again).not.toBe(token);
    expect(await online(mac)).toBe(true);
    expect(hostTags()).toEqual([
      [["parlor_chat_hosts", "mac"]],
      [["parlor_chat_hosts", "mac"]],
    ]);
  });

  it("writes nothing more for a computer that said it is going offline, and forgets its token", async () => {
    await hello(mac);
    const token = await beat(mac);
    const { written } = await report(mac, false);
    liveness.reported(owner, mac, false, written);
    expect(liveness.heard!(token)).toBe(false);
    await pause(GRACE_MS * 2);
    expect(announced).toEqual([]);
    expect(heartbeats).toBe(0);
  });

  it("after a restart, marks the computers that do not come back offline and keeps those that do", async () => {
    await report(mac);
    await report(pc);
    liveness.start();
    const stop = keepBeating(await beat(pc));
    await gone(mac);
    stop();
    expect(await online(pc)).toBe(true);
    expect(hostTags()).toEqual([[["parlor_chat_hosts", "mac"]]]);
  });

  it("knows no token its predecessor gave, so the computer sends its credential again", async () => {
    await hello(mac);
    const token = await beat(mac);
    expect(successor.heard!(token)).toBe(false);
    expect(await beat(mac, successor)).not.toBe(token);
  });

  it("leaves a computer that moved to its successor online, when its own grace for it runs out", async () => {
    await hello(mac);
    await beat(mac);
    const stop = keepBeating(await beat(mac, successor), successor);
    await vi.waitFor(() => expect(heartbeats).toBe(1));
    await pause(GRACE_MS * 2);
    stop();
    expect(await online(mac)).toBe(true);
    expect(announced).toEqual([]);
  });

  it("leaves a computer that said hello to its successor online as well", async () => {
    await hello(mac);
    await beat(mac);
    await hello(mac, successor);
    const stop = keepBeating(await beat(mac, successor), successor);
    await pause(GRACE_MS * 2);
    stop();
    expect(await online(mac)).toBe(true);
    expect(announced).toEqual([]);
  });

  describe("a turn's lease", () => {
    it("is looked at when the server starts, for what a stopped one left running", async () => {
      liveness.start();
      await vi.waitFor(() => expect(reconciled).toBe(1));
    });

    it("is looked at when it is due and not before, then not again once nothing runs", async () => {
      claim = { leaseUntil: Date.now() + 400 } as StoredClaim;
      await liveness.store.claimTurn(handle.db, owner, mac, 400);
      await pause(150);
      expect(reconciled).toBe(0);
      await vi.waitFor(() => expect(reconciled).toBe(1));
      await pause(300);
      expect(reconciled).toBe(1);
    });
  });
});

describe.each(drivers)("the chat of the app's only server on $name", (driver) => {
  let handle: DatabaseHandle;
  let app: ChatServer;
  const HELLO = {
    protocols: { min: 2, max: 5 },
    hostVersion: "1.0.0",
    name: "Alice's Mac",
    platform: "darwin",
    agents: [{ id: "claude", name: "Claude", ready: true }],
  };

  beforeAll(async () => {
    handle = await openDatabase(driver, true);
  }, 60_000);
  afterAll(() => handle.close());
  beforeEach(async () => {
    await resetDatabase(handle);
    app = serveChat(handle, { instances: "one" });
  }, 60_000);
  afterEach(() => app.server.close());

  const updates = async () =>
    (
      (await rows(
        handle,
        "select xmin::text as version from parlor_chat_hosts where id = 'mac'",
      )) as { version: string }[]
    )[0]?.version;

  it("answers a heartbeat with a token, and takes that token's heartbeats from anyone without rewriting anything", async () => {
    await app.action("alice-host", "hostHello", HELLO);
    const written = await updates();
    const events = await rows(handle, "select count(*)::int as n from sync_events");

    const first = await app.post("alice-host", "heartbeat", {});
    expect(first.status).toBe(200);
    const { beat: token } = first.body as { beat: string };
    expect(token.length).toBeGreaterThanOrEqual(32);
    for (let beat = 0; beat < 3; beat += 1) {
      expect((await app.post(undefined, "beat", { token })).status).toBe(204);
    }
    expect((await app.post(undefined, "beat", { token: "made up" })).status).toBe(404);
    expect((await app.post(undefined, "beat", {})).status).toBe(404);

    expect(await updates()).toBe(written);
    expect(await rows(handle, "select count(*)::int as n from sync_events")).toEqual(
      events,
    );
    expect(data(await app.action("alice", "hosts", {}))).toMatchObject([
      { id: "mac", online: true },
    ]);
  });

  it("serves as one of several without tokens: each heartbeat renews a lease, and none is answered", async () => {
    await app.server.close();
    app = serveChat(handle, { instances: "many" });
    await app.action("alice-host", "hostHello", HELLO);
    const written = await updates();
    const reply = await app.post("alice-host", "heartbeat", {});
    expect(reply.status).toBe(204);
    expect(await updates()).not.toBe(written);
    expect((await app.post(undefined, "beat", { token: "any" })).status).toBe(404);
  });
});
