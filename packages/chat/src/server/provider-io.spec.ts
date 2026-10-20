import type { DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  agentRef,
  type ChatServer,
  data,
  drivers,
  openDatabase,
  type ProviderIo,
  resetDatabase,
  rows,
  serveChat,
} from "./spec-kit.js";

const BOUND_MS = 5000;

const within = <T>(work: Promise<T>) =>
  Promise.race([
    work,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`no answer after ${BOUND_MS} ms`)), BOUND_MS),
    ),
  ]);

const hello = {
  protocols: { min: 2, max: 2 },
  hostVersion: "1.0.0",
  name: "Mac",
  platform: "darwin",
  agents: [{ id: "claude", name: "Claude", ready: true }],
};

describe.each(drivers)(
  "chat actions with an auth provider that reads the database on $name",
  (driver) => {
    let handle: DatabaseHandle;
    let app: ChatServer;
    let io: ProviderIo;

    beforeAll(async () => {
      handle = await openDatabase(driver);
    }, 60_000);
    afterAll(async () => {
      await handle.close();
    });

    beforeEach(async () => {
      await resetDatabase(handle);
      io = { database: handle };
      app = serveChat(handle, { providerIo: io });
      await within(app.action("alice-host", "hostHello", hello));
    }, 60_000);
    afterEach(async () => {
      await app.server.close();
    });

    const send = (turnId: string) =>
      app.action("alice", "send", {
        threadId: "t1",
        turnId,
        itemId: `${turnId}-prompt`,
        clientId: "tab",
        prompt: { text: "hi", agent: agentRef },
      });

    it(
      "answers a send, a claim of the queued turn and a renewal within a bound",
      { timeout: 20_000 },
      async () => {
        expect((await within(send("u1"))).status).toBe(200);

        const claim = await within(app.action("alice-host", "hostClaim", {}));
        expect(claim.status).toBe(200);
        expect(data(claim)).toMatchObject({
          turnId: "u1",
          token: { token: expect.stringMatching(/^turn\.u1\./) },
          context: expect.stringContaining("Alice"),
        });

        const renewal = await within(
          app.action("alice-host", "hostAppend", {
            turnId: "u1",
            items: [{ id: "u1.1", kind: "reply", body: { text: "hello" } }],
          }),
        );
        expect(renewal.status).toBe(200);
        expect(data(renewal)).toMatchObject({
          token: { token: expect.stringMatching(/^turn\.u1\./) },
        });
      },
    );

    it(
      "R5-07: answers a signed answer, and the database still answers after it",
      { timeout: 20_000 },
      async () => {
        app.auth.activeDevices.add("device-1");
        await within(send("u1"));
        await within(app.action("alice-host", "hostClaim", {}));
        await within(
          app.action("alice-host", "hostAppend", {
            turnId: "u1",
            items: [
              {
                id: "u1.1",
                kind: "ask",
                body: {
                  question: "Run it?",
                  choices: [{ id: "yes", label: "Yes", effect: "allow_once" }],
                  approval: "presence",
                },
              },
            ],
          }),
        );

        const answered = await within(
          app.action("alice", "answer", {
            threadId: "t1",
            turnId: "u1",
            itemId: "a1",
            answer: {
              askId: "u1.1",
              choice: "yes",
              signed: {
                deviceId: "device-1",
                at: 1,
                signature: {
                  keyId: "key-1",
                  presence: "user",
                  format: "webauthn",
                  signature: "c2ln",
                },
              },
            },
          }),
        );

        expect(answered.status).toBe(200);
        expect(
          await within(
            rows(handle, "select id from parlor_chat_items where kind = 'answer'"),
          ),
        ).toEqual([{ id: "a1" }]);
      },
    );

    it(
      "puts a turn back in the queue when its token cannot be minted",
      { timeout: 20_000 },
      async () => {
        await within(send("u1"));
        io.failDelegate = new Error("signing key unavailable");

        const failed = await within(app.action("alice-host", "hostClaim", {}));

        expect(failed.status).toBe(500);
        expect(await rows(handle, "select id, state from parlor_chat_turns")).toEqual([
          { id: "u1", state: "queued" },
        ]);

        io.failDelegate = undefined;
        const retried = await within(app.action("alice-host", "hostClaim", {}));
        expect(retried.status).toBe(200);
        expect(data(retried)).toMatchObject({ turnId: "u1" });
      },
    );

    it(
      "keeps the items of a renewal that could not mint its token",
      { timeout: 20_000 },
      async () => {
        await within(send("u1"));
        await within(app.action("alice-host", "hostClaim", {}));
        io.failDelegate = new Error("signing key unavailable");

        const failed = await within(
          app.action("alice-host", "hostAppend", {
            turnId: "u1",
            items: [{ id: "u1.1", kind: "reply", body: { text: "hello" } }],
          }),
        );
        expect(failed.status).toBe(500);

        io.failDelegate = undefined;
        const retried = await within(
          app.action("alice-host", "hostAppend", {
            turnId: "u1",
            items: [{ id: "u1.1", kind: "reply", body: { text: "hello" } }],
          }),
        );
        expect(retried.status).toBe(200);
        expect(
          await rows(handle, "select id from parlor_chat_items where kind = 'reply'"),
        ).toEqual([{ id: "u1.1" }]);
      },
    );
  },
);
