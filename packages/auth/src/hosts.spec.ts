import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { rowsOf } from "./database.js";
import { AUTH_MIGRATIONS } from "./migrations.js";
import {
  type Browser,
  createTestApp,
  ORIGIN,
  signUp as signUpAs,
  type TestApp,
} from "./testing/app.js";
import { Computer, pair } from "./testing/computer.js";

let database: DatabaseHandle;
let app: TestApp;

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
  await database.db.execute(sql`select 1`);
}, 30_000);

afterAll(async () => {
  await database.close();
});

beforeEach(() => {
  app = createTestApp(database);
});

afterEach(async () => {
  await app.server.close();
});

const signUp = (name: string) => signUpAs(app.server, name);

const rows = async <T>(query: ReturnType<typeof sql>) =>
  rowsOf<T>(await database.db.execute(query));

async function codeFrom(response: Response): Promise<string> {
  expect(response.status).toBe(303);
  return new URL(response.headers.get("location")!).searchParams.get("code")!;
}

describe("the consent page", () => {
  it("names the computer, the app and the account, and is the one place the connection is approved", async () => {
    const alice = await signUp("Alice");
    const computer = new Computer("Alice's MacBook", "macos");
    const response = await alice.fetch(
      `/_parlor/auth/hosts/authorize?${await computer.authorizeQuery()}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action 'self' http://127.0.0.1:43124",
    );
    const html = await response.text();
    expect(html).toContain("<title>Connect a computer</title>");
    expect(html).toContain("<h1>Connect Alice&#39;s MacBook to Hello?</h1>");
    expect(html).toContain("<strong>alice@example.com</strong>");
    expect(html).toContain(
      "The coding agents on <strong>Alice&#39;s MacBook</strong> (macos) will take your prompts from Hello and run on that computer. Continue only if you just ran <code>connect</code> there.",
    );
    expect(html.replace(/<input [^>]*>/g, "")).not.toContain("K7M-4PX");
    expect(html).toContain('name="decision" value="connect">Connect</button>');
    expect(html).toContain('name="decision" value="cancel">Cancel</button>');
    expect(html).toContain(`name="keyThumbprint" value="${await computer.thumbprint()}"`);
  });

  it("refuses a visitor who is not signed in", async () => {
    const computer = new Computer();
    const response = await app.server.fetch(
      new Request(
        `${ORIGIN}/_parlor/auth/hosts/authorize?${await computer.authorizeQuery()}`,
      ),
    );
    expect(response.status).toBe(401);
  });

  it("refuses a redirect that is not this computer's loopback", async () => {
    const alice = await signUp("Alice");
    for (const redirectUri of [
      "https://evil.example/callback",
      "http://127.0.0.1:43124/elsewhere",
      "http://localhost:43124/callback",
      "http://127.0.0.1:99999/callback",
    ]) {
      const query = new URLSearchParams({
        ...(await new Computer().pairing()),
        redirectUri,
      });
      const response = await alice.fetch(`/_parlor/auth/hosts/authorize?${query}`);
      expect(response.status, redirectUri).toBe(400);
    }
  });

  it("refuses an answer that did not come from this app's origin", async () => {
    const alice = await signUp("Alice");
    const computer = new Computer();
    const response = await alice.fetch("/_parlor/auth/hosts/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
      },
      body: new URLSearchParams({
        ...(await computer.pairing()),
        decision: "connect",
      }).toString(),
    });
    expect(response.status).toBe(403);
  });
});

describe("letting the coding agents on the computer use the app", () => {
  const answer = async (
    browser: Awaited<ReturnType<typeof signUp>>,
    computer: Computer,
    fields: Record<string, string>,
  ) =>
    browser.fetch("/_parlor/auth/hosts/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...(await computer.pairing()),
        decision: "connect",
        ...fields,
      }).toString(),
      redirect: "manual",
    });

  it("offers it on the consent page, checked, only when the computer can", async () => {
    const alice = await signUp("Alice");
    const computer = new Computer();
    const offered = await alice.fetch(
      `/_parlor/auth/hosts/authorize?${await computer.authorizeQuery()}&agentTools=offered`,
    );
    const html = await offered.text();
    expect(html).toContain(
      '<input type="checkbox" name="useAgentTools" value="on" checked><span>Also let Claude Code and Codex on this computer use Hello when you name it.',
    );
    expect(html).toContain('name="agentTools" value="offered"');
    const plain = await alice.fetch(
      `/_parlor/auth/hosts/authorize?${await computer.authorizeQuery()}`,
    );
    expect(await plain.text()).not.toContain("useAgentTools");
  });

  it("tells the computer what the user chose, and nothing when it did not offer", async () => {
    const alice = await signUp("Alice");
    const choiceOf = async (fields: Record<string, string>) =>
      new URL(
        (await answer(alice, new Computer(), fields)).headers.get("location")!,
      ).searchParams.get("agentTools");
    expect(await choiceOf({ agentTools: "offered", useAgentTools: "on" })).toBe("on");
    expect(await choiceOf({ agentTools: "offered" })).toBe("off");
    expect(await choiceOf({})).toBeNull();
  });

  it("says on the connected page how to ask the agents, by the name they know the app by", async () => {
    const page = async (query: string) =>
      (
        await app.server.fetch(
          new Request(`${ORIGIN}/_parlor/auth/hosts/connected${query}`),
        )
      ).text();
    const both = await page("?agentTools=hello-localhost-5173");
    expect(both).toContain("<p>Use it two ways:</p>");
    expect(both).toContain("<li>In the agent sidebar of Hello.</li>");
    expect(both).toContain("ask them to “use <code>hello-localhost-5173</code> to …”");
    const tampered = await page("?agentTools=%3Cscript%3E");
    expect(tampered).not.toContain("two ways");
    expect(tampered).not.toContain("<script>alert");
    expect(await page("")).toContain("ready in the agent sidebar of Hello");
  });
});

describe("pairing a computer", () => {
  it("redirects to the computer with a code and its state, and exchanges the code once", async () => {
    const alice = await signUp("Alice");
    const computer = new Computer();
    const approved = await computer.approve(alice);
    expect(approved.status).toBe(303);
    const location = new URL(approved.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(
      "http://127.0.0.1:43124/callback",
    );
    expect(location.searchParams.get("state")).toBe(computer.state);
    const code = location.searchParams.get("code")!;
    expect(code).toMatch(/^[\w-]{43}$/);

    const exchanged = await computer.exchange(app.server, code);
    expect(exchanged.status).toBe(200);
    expect(exchanged.body).toEqual({
      grant: { id: expect.stringMatching(/^host:/), hostId: expect.any(String) },
      account: {
        userId: expect.any(String),
        name: "Alice",
        email: "alice@example.com",
      },
      landing: "/_parlor/auth/hosts/connected",
    });

    const replay = await computer.exchange(app.server, code);
    expect(replay.status).toBe(400);
    expect(replay.body).toEqual({
      error: {
        code: "invalid_grant",
        message: "The pairing code is invalid, expired or already used.",
      },
    });
  });

  it("stores only the computer's public key", async () => {
    const alice = await signUp("Alice");
    const computer = await pair(app.server, alice);
    const grantId = computer.grant!.grant.id;
    const stored = await rows<{ public_key: unknown; kid: string; name: string }>(
      sql`select public_key, kid, name from parlor_auth_hosts where grant_id = ${grantId}`,
    );
    expect(stored).toEqual([
      {
        public_key: await computer.publicKey(),
        kid: await computer.thumbprint(),
        name: "Fake host",
      },
    ]);
    expect(stored[0]!.public_key).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(stored[0]!.public_key).not.toHaveProperty("d");
    const columns = await rows<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_name = 'parlor_auth_hosts' order by column_name`,
    );
    expect(columns.map((column) => column.column_name)).toEqual([
      "created_at",
      "grant_id",
      "host_id",
      "kid",
      "last_used_at",
      "name",
      "platform",
      "public_key",
      "user_id",
    ]);
  });

  it("refuses a proof signed by a different key, and the code is spent", async () => {
    const alice = await signUp("Alice");
    const computer = new Computer();
    const thief = new Computer();
    const code = await codeFrom(await computer.approve(alice));
    const forged = await thief.sign(new TextEncoder().encode(code));
    expect((await computer.exchange(app.server, code, { proof: forged })).status).toBe(
      400,
    );
    expect((await computer.exchange(app.server, code)).status).toBe(400);
  });

  it("refuses a different key presenting a valid proof of its own", async () => {
    const alice = await signUp("Alice");
    const computer = new Computer();
    const thief = new Computer();
    const code = await codeFrom(await computer.approve(alice));
    const response = await app.server.fetch(
      new Request(`${ORIGIN}/_parlor/auth/hosts/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          codeVerifier: computer.codeVerifier,
          publicKey: await thief.publicKey(),
          proof: await thief.sign(new TextEncoder().encode(code)),
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(
      await rows(
        sql`select 1 from parlor_auth_hosts where kid = ${await thief.thumbprint()}`,
      ),
    ).toEqual([]);
  });

  it("refuses a code verifier that does not match the challenge", async () => {
    const alice = await signUp("Alice");
    const computer = new Computer();
    const code = await codeFrom(await computer.approve(alice));
    const wrong = await computer.exchange(app.server, code, {
      codeVerifier: "x".repeat(43),
    });
    expect(wrong.status).toBe(400);
  });

  it("refuses an expired code", async () => {
    const alice = await signUp("Alice");
    const computer = new Computer();
    const code = await codeFrom(await computer.approve(alice));
    await database.db.execute(
      sql`update parlor_auth_host_codes set expires_at = now() - interval '1 second' where key_thumbprint = ${await computer.thumbprint()}`,
    );
    expect((await computer.exchange(app.server, code)).status).toBe(400);
  });

  it("refuses a public key that carries its private half", async () => {
    const alice = await signUp("Alice");
    const computer = new Computer();
    const code = await codeFrom(await computer.approve(alice));
    const response = await app.server.fetch(
      new Request(`${ORIGIN}/_parlor/auth/hosts/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          codeVerifier: computer.codeVerifier,
          publicKey: { ...(await computer.publicKey()), d: "AAAA" },
          proof: await computer.sign(new TextEncoder().encode(code)),
        }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("sends a cancel back to the computer without storing a code", async () => {
    const alice = await signUp("Alice");
    const computer = new Computer();
    const before = await rows(sql`select 1 from parlor_auth_host_codes`);
    const cancelled = await computer.approve(alice, "cancel");
    expect(cancelled.status).toBe(303);
    expect(cancelled.headers.get("location")).toBe(
      `http://127.0.0.1:43124/callback?error=access_denied&state=${computer.state}`,
    );
    expect(await rows(sql`select 1 from parlor_auth_host_codes`)).toHaveLength(
      before.length,
    );
  });

  it("answers the code as JSON for an in-app pairing", async () => {
    const alice = await signUp("Alice");
    const computer = new Computer("Alice's Mac", "macos", "urn:parlor:ipc");
    const response = await alice.post("/_parlor/auth/hosts/authorize", {
      ...(await computer.pairing()),
      decision: "connect",
    });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as { code: string; state: string };
    expect(answer.state).toBe(computer.state);
    expect((await computer.exchange(app.server, answer.code)).status).toBe(200);
  });
});

describe("the account's computers", () => {
  const list = async (browser: Browser) => (await browser.account("hosts")).body.data;

  it("lists a user's own computers and nobody else's", async () => {
    const alice = await signUp("Alice");
    const bob = await signUp("Bob");
    const computer = await pair(app.server, alice);
    expect(await list(alice)).toEqual([
      {
        hostId: computer.grant!.grant.hostId,
        name: "Fake host",
        platform: "macos",
        connectedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        lastUsedAt: null,
      },
    ]);
    expect(await list(bob)).toEqual([]);
  });

  it("removes the key and records the revocation together when the user revokes", async () => {
    const alice = await signUp("Alice");
    const computer = await pair(app.server, alice);
    const { hostId, id } = {
      hostId: computer.grant!.grant.hostId,
      id: computer.grant!.grant.id,
    };
    const revoked = await alice.account("revokeHost", { hostId });
    expect(revoked).toMatchObject({ status: 200, body: { data: { id: hostId } } });
    expect(
      await rows(sql`select 1 from parlor_auth_hosts where grant_id = ${id}`),
    ).toEqual([]);
    expect(
      await rows(
        sql`select kind, id from parlor_auth_revocations where kind = 'grant' and id = ${id}`,
      ),
    ).toEqual([{ kind: "grant", id }]);
    expect(await list(alice)).toEqual([]);
  });

  it("answers not_found when the computer belongs to someone else", async () => {
    const alice = await signUp("Alice");
    const bob = await signUp("Bob");
    const computer = await pair(app.server, alice);
    const hostId = computer.grant!.grant.hostId;
    const stranger = await bob.account("revokeHost", { hostId });
    const missing = await bob.account("revokeHost", { hostId: "no-such-host" });
    expect(stranger.status).toBe(404);
    expect(stranger.body.error.code).toBe("not_found");
    expect(stranger.body.error.message.replace(hostId, "X")).toBe(
      missing.body.error.message.replace("no-such-host", "X"),
    );
    expect(await list(alice)).toHaveLength(1);
  });
});

describe("a database from before host grants", () => {
  it("gains the host tables once and keeps what it had", async () => {
    const old = await createDatabase({ dataDir: "memory://" });
    try {
      await old.db.execute(
        sql`create table parlor_migrations (id text primary key, applied_at timestamptz not null default now())`,
      );
      for (const migration of AUTH_MIGRATIONS) {
        await old.db.execute(sql.raw(migration.sql));
        await old.db.execute(
          sql`insert into parlor_migrations (id) values (${migration.id})`,
        );
      }
      await old.db.execute(
        sql`insert into parlor_auth_revocations (kind, id, revoked_at) values ('grant', 'oauth:u:c', now())`,
      );

      for (let start = 0; start < 2; start += 1) {
        const upgraded = createTestApp(old);
        const alice = await signUpAs(upgraded.server, "Alice");
        await pair(upgraded.server, alice, new Computer(`Mac ${start}`));
        await upgraded.server.close();
      }

      const ids = rowsOf<{ id: string }>(
        await old.db.execute(sql`select id from parlor_migrations order by id`),
      ).map((row) => row.id);
      expect(ids).toEqual([
        "auth/0001_revocations",
        "auth/0002_revocations_revoked_at",
        "auth/0003_hosts",
        "auth/0004_devices",
        "auth/0005_turn_keys",
        "auth/0006_audit",
        "auth/0007_device_linking",
      ]);
      expect(
        rowsOf(await old.db.execute(sql`select id from parlor_auth_revocations`)),
      ).toEqual([{ id: "oauth:u:c" }]);
    } finally {
      await old.close();
    }
  });
});
