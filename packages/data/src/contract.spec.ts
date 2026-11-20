import net from "node:net";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createConnectionScope } from "./connection-scope.js";
import { createDatabase, type DatabaseHandle, resolveNotifications } from "./database.js";

const postgresUrl = process.env.PARLOR_TEST_DATABASE_URL;

if (!postgresUrl) {
  console.info(
    "[parlor] node-postgres contract tests skipped: set PARLOR_TEST_DATABASE_URL to run them",
  );
}

const drivers = [
  { name: "PGlite", open: () => createDatabase({ dataDir: "memory://" }) },
  ...(postgresUrl
    ? [{ name: "node-postgres", open: () => createDatabase({ url: postgresUrl }) }]
    : []),
];

const notifiers = [
  ...drivers,
  ...(postgresUrl
    ? [
        {
          name: "node-postgres notifying in process",
          open: () =>
            createDatabase({
              url: postgresUrl,
              notifications: "process",
              predecessorMs: 0,
            }),
        },
      ]
    : []),
];

const handles = new Map<string, DatabaseHandle>();

// PGlite starts on its first query and that is the slow part, so it happens once, outside any test's timeout.
beforeAll(async () => {
  for (const driver of notifiers) {
    const handle = await driver.open();
    await handle.db.execute(sql`select 1`);
    handles.set(driver.name, handle);
  }
}, 30_000);

afterAll(async () => {
  for (const handle of handles.values()) await handle.close();
});

function open(driver: (typeof notifiers)[number]): DatabaseHandle {
  return handles.get(driver.name)!;
}

const channel = () => `parlor_contract_${crypto.randomUUID().replaceAll("-", "")}`;

function received() {
  const payloads: string[] = [];
  const waiters = new Set<() => void>();
  return {
    payloads,
    handler: (payload: string) => {
      payloads.push(payload);
      for (const wake of waiters) wake();
    },
    async until(count: number) {
      const deadline = Date.now() + 3000;
      while (payloads.length < count) {
        if (Date.now() > deadline) throw new Error(`expected ${count} notifications`);
        await new Promise<void>((resolve) => {
          waiters.add(resolve);
          setTimeout(resolve, 20);
        });
      }
    },
  };
}

describe.each(drivers)("DataProvider contract on $name", (driver) => {
  it("answers a parameterized statement through client", async () => {
    const handle = open(driver);
    const { rows } = await handle.client.query("select $1::int + 1 as n, $2::text as t", [
      41,
      "x",
    ]);
    expect(rows).toEqual([{ n: 42, t: "x" }]);
  });

  it("delivers NOTIFY to a listener until it unlistens", async () => {
    const handle = open(driver);
    const name = channel();
    const inbox = received();
    const unlisten = await handle.listen(name, inbox.handler);
    await handle.db.execute(sql`select pg_notify(${name}, 'one')`);
    await inbox.until(1);
    await unlisten();
    await handle.db.execute(sql`select pg_notify(${name}, 'two')`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(inbox.payloads).toEqual(["one"]);
  });

  it("delivers a NOTIFY sent inside a transaction only after it commits", async () => {
    const handle = open(driver);
    const name = channel();
    const inbox = received();
    await handle.listen(name, inbox.handler);
    await handle
      .transaction(async (tx) => {
        await tx.execute(sql`select pg_notify(${name}, 'rolled back')`);
        throw new Error("abort");
      })
      .catch(() => {});
    await handle.transaction(async (tx) => {
      await tx.execute(sql`select pg_notify(${name}, 'committed')`);
    });
    await inbox.until(1);
    expect(inbox.payloads).toEqual(["committed"]);
  });
});

describe.each(notifiers)("notify on $name", (driver) => {
  const quiet = () => new Promise((resolve) => setTimeout(resolve, 100));

  it("reaches a listener until it unlistens", async () => {
    const handle = open(driver);
    const name = channel();
    const inbox = received();
    const unlisten = await handle.listen(name, inbox.handler);
    await handle.notify(name, "one");
    await inbox.until(1);
    await unlisten();
    await handle.notify(name, "two");
    await quiet();
    expect(inbox.payloads).toEqual(["one"]);
  });

  it("waits for its transaction to commit and is dropped when it rolls back", async () => {
    const handle = open(driver);
    const name = channel();
    const inbox = received();
    await handle.listen(name, inbox.handler);
    await handle
      .transaction(async (tx) => {
        await handle.notify(name, "rolled back", tx);
        throw new Error("abort");
      })
      .catch(() => {});
    let beforeCommit: string[] = [];
    await handle.transaction(async (tx) => {
      await handle.notify(name, "committed", tx);
      await quiet();
      beforeCommit = [...inbox.payloads];
    });
    await inbox.until(1);
    expect(beforeCommit).toEqual([]);
    expect(inbox.payloads).toEqual(["committed"]);
  });

  it("follows a savepoint: kept when released, dropped when rolled back", async () => {
    const handle = open(driver);
    const name = channel();
    const inbox = received();
    await handle.listen(name, inbox.handler);
    await handle.transaction(async (tx) => {
      await handle.notify(name, "outer", tx);
      await tx.transaction(async (savepoint) => {
        await handle.notify(name, "released", savepoint);
      });
      await tx
        .transaction(async (savepoint) => {
          await handle.notify(name, "undone", savepoint);
          throw new Error("abort the savepoint");
        })
        .catch(() => {});
    });
    await inbox.until(2);
    await quiet();
    expect(inbox.payloads).toEqual(["outer", "released"]);
  });

  it("holds a transaction opened through db as well", async () => {
    const handle = open(driver);
    const name = channel();
    const inbox = received();
    await handle.listen(name, inbox.handler);
    await handle.db
      .transaction(async (tx) => {
        await handle.notify(name, "rolled back", tx);
        throw new Error("abort");
      })
      .catch(() => {});
    await handle.db.transaction(async (tx) => {
      await handle.notify(name, "committed", tx);
    });
    await inbox.until(1);
    await quiet();
    expect(inbox.payloads).toEqual(["committed"]);
  });
});

describe.runIf(postgresUrl)("node-postgres notifying in process", () => {
  const listening = async () => {
    const admin = new pg.Client({ connectionString: postgresUrl });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ count: number }>(
        `select count(*)::int as count from pg_stat_activity
         where datname = current_database() and query ilike 'listen %'`,
      );
      return rows[0]!.count;
    } finally {
      await admin.end();
    }
  };

  it("says so, as PGlite does, while node-postgres defaults to the database", () => {
    expect(handles.get("node-postgres notifying in process")!.notifications).toBe(
      "process",
    );
    expect(handles.get("PGlite")!.notifications).toBe("process");
    expect(handles.get("node-postgres")!.notifications).toBe("database");
  });

  it("holds no LISTEN connection for its listeners", async () => {
    const handle = handles.get("node-postgres notifying in process")!;
    const before = await listening();
    const unlisten = await handle.listen(channel(), () => {});
    expect(await listening()).toBe(before);
    await unlisten();
  });

  it("keeps each connection scope's listeners to that scope's notifications", async () => {
    const handle = handles.get("node-postgres notifying in process")!;
    const name = channel();
    const outside = received();
    const inside = received();
    await handle.listen(name, outside.handler);
    const scope = createConnectionScope();
    try {
      await scope.run(async () => {
        await handle.listen(name, inside.handler);
        await handle.transaction((tx) => handle.notify(name, "scoped", tx));
      });
      await handle.notify(name, "unscoped");
      expect(inside.payloads).toEqual(["scoped"]);
      expect(outside.payloads).toEqual(["unscoped"]);
    } finally {
      await scope.close();
    }
  });
});

describe.runIf(postgresUrl)("a server that starts beside the one it replaces", () => {
  const opened: DatabaseHandle[] = [];
  afterEach(async () => {
    for (const handle of opened.splice(0)) await handle.close();
  });
  const server = async (predecessorMs: number) => {
    const handle = await createDatabase({
      url: postgresUrl,
      notifications: "process",
      predecessorMs,
    });
    opened.push(handle);
    return handle;
  };
  const listeningTo = async (name: string) => {
    const admin = new pg.Client({ connectionString: postgresUrl });
    await admin.connect();
    try {
      const { rows } = await admin.query(
        "select pid from pg_stat_activity where query = $1",
        [`LISTEN ${pg.escapeIdentifier(name)}`],
      );
      return rows.length;
    } finally {
      await admin.end();
    }
  };

  it("hears what that one still notifies, once each, along with its own", async () => {
    const predecessor = await server(0);
    const successor = await server(5000);
    const name = channel();
    const inbox = received();
    await successor.listen(name, inbox.handler);
    await vi.waitFor(async () => expect(await listeningTo(name)).toBe(1));

    await predecessor.transaction((tx) => predecessor.notify(name, "its last write", tx));
    await successor.transaction((tx) => successor.notify(name, "my own", tx));
    await successor.notify(name, "my own, outside a transaction");
    await successor.notify(name, "said twice");
    await successor.notify(name, "said twice");
    await inbox.until(5);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(inbox.payloads.toSorted()).toEqual([
      "its last write",
      "my own",
      "my own, outside a transaction",
      "said twice",
      "said twice",
    ]);
  });

  it("hears nothing that one rolled back", async () => {
    const predecessor = await server(0);
    const successor = await server(5000);
    const name = channel();
    const inbox = received();
    await successor.listen(name, inbox.handler);
    await vi.waitFor(async () => expect(await listeningTo(name)).toBe(1));
    await predecessor
      .transaction(async (tx) => {
        await predecessor.notify(name, "undone", tx);
        throw new Error("abort");
      })
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(inbox.payloads).toEqual([]);
  });

  it("lets the database connection go when its time is up, and then hears only itself", async () => {
    const predecessor = await server(0);
    const successor = await server(400);
    const name = channel();
    const inbox = received();
    await successor.listen(name, inbox.handler);
    await vi.waitFor(async () => expect(await listeningTo(name)).toBe(1));
    await vi.waitFor(async () => expect(await listeningTo(name)).toBe(0));

    await predecessor.notify(name, "too late");
    await successor.notify(name, "mine");
    await successor.notify(name, "mine");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(inbox.payloads).toEqual(["mine", "mine"]);
  });
});

describe("resolveNotifications", () => {
  it("keeps notifications in process only for an app with one server", () => {
    expect(resolveNotifications("one")).toBe("process");
    expect(resolveNotifications("many")).toBe("database");
    expect(resolveNotifications(undefined)).toBe("database");
  });
});

describe.runIf(postgresUrl)("node-postgres when the server drops a connection", () => {
  const admin = async (query: string) => {
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      await client.query(query);
    } finally {
      await client.end();
    }
  };

  it("reports a dropped LISTEN connection once instead of crashing", async () => {
    const handle = open(drivers[1]!);
    const name = channel();
    let lost = 0;
    let reported!: () => void;
    const report = new Promise<void>((resolve) => (reported = resolve));
    await handle.listen(name, () => {}, {
      onLost: () => {
        lost += 1;
        reported();
      },
    });
    await admin(
      `select pg_terminate_backend(pid) from pg_stat_activity where query = 'LISTEN "${name}"'`,
    );
    await Promise.race([report, new Promise((resolve) => setTimeout(resolve, 3000))]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lost).toBe(1);
    const inbox = received();
    await handle.listen(name, inbox.handler);
    await handle.db.execute(sql`select pg_notify(${name}, 'again')`);
    await inbox.until(1);
  });

  it("survives losing its idle pooled connections and serves the next query", async () => {
    const handle = open(drivers[1]!);
    await handle.db.execute(sql`select 1`);
    await admin(
      "select pg_terminate_backend(pid) from pg_stat_activity where pid <> pg_backend_pid() and state = 'idle' and datname = current_database()",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await handle.db.execute(sql`select 2 as n`);
    expect(result.rows).toEqual([{ n: 2 }]);
  });
});

/** A TCP hop to Postgres that can stop carrying bytes while every socket stays open, as a dead NAT or proxy does. */
async function freezableProxy(target: URL) {
  const pairs: [net.Socket, net.Socket][] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    client.pipe(upstream);
    upstream.pipe(client);
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", drop);
    upstream.on("error", drop);
    pairs.push([client, upstream]);
    sockets.add(client).add(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String((server.address() as net.AddressInfo).port);
  return {
    url: url.toString(),
    freeze() {
      for (const [client, upstream] of pairs.splice(0)) {
        client.unpipe(upstream);
        upstream.unpipe(client);
        client.pause();
        upstream.pause();
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

describe.runIf(postgresUrl)("node-postgres when a LISTEN connection goes silent", () => {
  it("reports it lost, so the listener listens again", async () => {
    const proxy = await freezableProxy(new URL(postgresUrl!));
    const handle = await createDatabase({
      url: postgresUrl,
      directUrl: proxy.url,
      listenCheckMs: 200,
    });
    try {
      const name = channel();
      let reported!: () => void;
      const lost = new Promise<void>((resolve) => (reported = resolve));
      await handle.listen(name, () => {}, { onLost: () => reported() });
      proxy.freeze();
      await expect(
        Promise.race([
          lost.then(() => "lost"),
          new Promise((resolve) => setTimeout(() => resolve("still listening"), 2000)),
        ]),
      ).resolves.toBe("lost");
      const inbox = received();
      await handle.listen(name, inbox.handler);
      await handle.db.execute(sql`select pg_notify(${name}, 'again')`);
      await inbox.until(1);
    } finally {
      await handle.close();
      await proxy.close();
    }
  });
});
