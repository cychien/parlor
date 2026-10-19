import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle, resolveDatabaseUrl } from "./database.js";

const handles: DatabaseHandle[] = [];
let template: string;
let shared: DatabaseHandle;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "parlor-data-"));
  template = join(root, ".parlor", "pglite");
  const seeded = await createDatabase({ dataDir: template });
  await seeded.db.execute(sql`create table kept (n int)`);
  await seeded.db.execute(sql`insert into kept values (7)`);
  await seeded.close();
  shared = await copiedDatabase();
}, 30_000);

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
});

async function copiedDatabase(migrationsFolder?: string) {
  const dataDir = join(await mkdtemp(join(tmpdir(), "parlor-data-")), "pglite");
  await cp(template, dataDir, { recursive: true });
  const handle = await createDatabase({ dataDir, migrationsFolder });
  handles.push(handle);
  return handle;
}

describe("resolveDatabaseUrl", () => {
  it("reads DATABASE_URL and treats empty as unset", () => {
    expect(resolveDatabaseUrl({})).toBeUndefined();
    expect(resolveDatabaseUrl({ DATABASE_URL: "" })).toBeUndefined();
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgres://x" })).toBe("postgres://x");
  });
});

describe("createDatabase with PGlite", () => {
  it("creates missing parent directories of a file data dir and keeps its data", async () => {
    const reopened = await createDatabase({ dataDir: template });
    try {
      const rows = await reopened.db.execute(sql`select n from kept`);
      expect((rows as unknown as { rows: { n: number }[] }).rows).toEqual([{ n: 7 }]);
    } finally {
      await reopened.close();
    }
  });

  it("runs SQL, commits transactions, and rolls back on error", async () => {
    expect(shared.driver).toBe("pglite");
    await shared.db.execute(sql`create table t (n int)`);

    await shared.transaction(async (tx) => {
      await tx.execute(sql`insert into t values (1)`);
    });
    await shared
      .transaction(async (tx) => {
        await tx.execute(sql`insert into t values (2)`);
        throw new Error("boom");
      })
      .catch(() => {});

    const rows = await shared.read().execute(sql`select n from t order by n`);
    expect(rows.rows).toEqual([{ n: 1 }]);
  });

  describe("work started inside a transaction", () => {
    const within = <T>(work: Promise<T>, ms = 2000) =>
      Promise.race([
        work,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms),
        ),
      ]);
    const countOf = async (db: { execute: DatabaseHandle["db"]["execute"] }) =>
      (await db.execute(sql`select n from joined order by n`)).rows;

    it("reads through the bare handle and sees the transaction's own writes", async () => {
      await shared.db.execute(sql`create table joined (n int)`);

      const seen = await shared.transaction(async (tx) => {
        await tx.execute(sql`insert into joined values (1)`);
        return within(countOf(shared.read()));
      });

      expect(seen).toEqual([{ n: 1 }]);
      expect(await countOf(shared.read())).toEqual([{ n: 1 }]);
    });

    it("rolls back with the transaction when it writes through the bare handle", async () => {
      await shared
        .transaction(async () => {
          await within(shared.db.execute(sql`insert into joined values (2)`));
          throw new Error("boom");
        })
        .catch(() => {});

      expect(await countOf(shared.read())).toEqual([{ n: 1 }]);
    });

    it("answers queries issued together on the transaction and the bare handle", async () => {
      const [viaTx, viaHandle] = await shared.transaction((tx) =>
        within(Promise.all([countOf(tx), countOf(shared.read())])),
      );

      expect(viaTx).toEqual([{ n: 1 }]);
      expect(viaHandle).toEqual([{ n: 1 }]);
    });

    it("keeps a caller outside the transaction waiting until it commits", async () => {
      const writing = shared.transaction(async (tx) => {
        await tx.execute(sql`insert into joined values (3)`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      const outside = await within(countOf(shared.read()));
      await writing;

      expect(outside).toEqual([{ n: 1 }, { n: 3 }]);
    });

    it("goes straight to the database when it outlives the transaction", async () => {
      let late!: Promise<unknown[]>;
      await shared.transaction(async () => {
        late = new Promise((resolve) => setTimeout(resolve, 30)).then(() =>
          countOf(shared.read()),
        );
      });

      expect(await within(late)).toEqual([{ n: 1 }, { n: 3 }]);
    });

    it("runs a nested transaction on the handle inside the outer one", async () => {
      await shared
        .transaction(async () => {
          await within(
            shared.transaction((inner) =>
              inner.execute(sql`insert into joined values (4)`),
            ),
          );
          throw new Error("boom");
        })
        .catch(() => {});

      expect(await countOf(shared.read())).toEqual([{ n: 1 }, { n: 3 }]);
    });
  });

  it("applies migrations from a folder on create", async () => {
    const folder = await mkdtemp(join(tmpdir(), "parlor-migrations-"));
    await writeFile(
      join(folder, "0000_init.sql"),
      "create table tasks (id text primary key);",
    );
    await mkdir(join(folder, "meta"));
    await writeFile(
      join(folder, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [{ idx: 0, version: "7", when: 1, tag: "0000_init", breakpoints: true }],
      }),
    );
    const handle = await copiedDatabase(folder);
    await handle.db.execute(sql`insert into tasks values ('a')`);
    const rows = await handle.db.execute(sql`select count(*)::int as c from tasks`);
    expect(rows.rows).toEqual([{ c: 1 }]);
  });

  it("closes idempotently", async () => {
    const handle = await createDatabase({ dataDir: "memory://" });
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
  });
});
