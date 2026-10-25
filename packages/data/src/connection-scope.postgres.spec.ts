import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createConnectionScope } from "./connection-scope.js";
import { createDatabase, type DatabaseHandle } from "./database.js";

const postgresUrl = process.env.PARLOR_TEST_DATABASE_URL;

if (!postgresUrl) {
  console.info(
    "[parlor] connection scope specs skipped: set PARLOR_TEST_DATABASE_URL to run them",
  );
}

async function admin<T extends pg.QueryResultRow>(url: string, query: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(query)).rows;
  } finally {
    await client.end();
  }
}

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

const backend = async (handle: DatabaseHandle) =>
  (await handle.db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!
    .pid;

const alive = async (pid: number) =>
  (
    await admin<{ n: number }>(
      postgresUrl!,
      `select count(*)::int as n from pg_stat_activity where pid = ${pid}`,
    )
  )[0]!.n === 1;

describe.runIf(postgresUrl)("connection scopes on node-postgres", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createDatabase({ url: postgresUrl });
  });

  afterAll(async () => {
    await handle.close();
  });

  it("gives a scope its own connections and closes them with it", async () => {
    const outside = await backend(handle);
    const scope = createConnectionScope();
    const inside = await scope.run(() => backend(handle));
    expect(inside).not.toBe(outside);
    expect(await scope.run(() => backend(handle))).toBe(inside);
    await scope.close();
    await expect.poll(() => alive(inside)).toBe(false);
    expect(await alive(outside)).toBe(true);
    await expect(scope.run(() => backend(handle))).rejects.toThrow(/closed/);
  });

  it("routes a db captured outside every scope to the scope it is used in", async () => {
    const captured = handle.db;
    const scope = createConnectionScope();
    try {
      const viaCapture = await scope.run(
        async () =>
          (await captured.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))
            .rows[0]!.pid,
      );
      const viaRead = await scope.run(
        async () =>
          (
            await handle
              .read()
              .execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
          ).rows[0]!.pid,
      );
      expect(viaCapture).toBe(viaRead);
    } finally {
      await scope.close();
    }
  });

  it("runs client statements on the connections of the scope it is used in", async () => {
    const pid = async () =>
      (
        (await handle.client.query("select pg_backend_pid() as pid")).rows[0] as {
          pid: number;
        }
      ).pid;
    const scope = createConnectionScope();
    try {
      const inside = await scope.run(() => backend(handle));
      expect(await scope.run(pid)).toBe(inside);
      expect(await pid()).not.toBe(inside);
    } finally {
      await scope.close();
    }
  });

  it("keeps concurrent scopes apart, transactions included", async () => {
    const one = createConnectionScope();
    const two = createConnectionScope();
    try {
      const [a, b] = await Promise.all([
        one.run(() =>
          handle.transaction(
            async (tx) =>
              (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))
                .rows[0]!.pid,
          ),
        ),
        two.run(() =>
          handle.transaction(
            async (tx) =>
              (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))
                .rows[0]!.pid,
          ),
        ),
      ]);
      expect(a).not.toBe(b);
    } finally {
      await Promise.all([one.close(), two.close()]);
    }
  });

  it("closes a scope's LISTEN connection with the scope", async () => {
    const scope = createConnectionScope();
    const channel = `parlor_scope_${crypto.randomUUID().replaceAll("-", "")}`;
    await scope.run(() => handle.listen(channel, () => {}));
    const listening = async () =>
      (
        await admin<{ n: number }>(
          postgresUrl!,
          `select count(*)::int as n from pg_stat_activity where query = 'LISTEN "${channel}"'`,
        )
      )[0]!.n;
    expect(await listening()).toBe(1);
    await scope.close();
    await expect.poll(listening).toBe(0);
  });
});

describe.runIf(postgresUrl)("directUrl", () => {
  const pooledName = `parlor_pooled_${process.pid}`;
  const directName = `parlor_direct_${process.pid}`;
  let handle: DatabaseHandle;

  beforeAll(async () => {
    for (const name of [pooledName, directName]) {
      await admin(postgresUrl!, `drop database if exists ${name}`);
      await admin(postgresUrl!, `create database ${name}`);
    }
    handle = await createDatabase({
      url: databaseUrl(postgresUrl!, pooledName),
      directUrl: databaseUrl(postgresUrl!, directName),
    });
  });

  afterAll(async () => {
    await handle?.close();
    for (const name of [pooledName, directName]) {
      await admin(postgresUrl!, `drop database if exists ${name} with (force)`);
    }
  });

  it("listens on the direct connection", async () => {
    const channel = `parlor_direct_${crypto.randomUUID().replaceAll("-", "")}`;
    const payloads: string[] = [];
    await handle.listen(channel, (payload) => payloads.push(payload));
    await handle.db.execute(sql`select pg_notify(${channel}, 'pooled')`);
    await admin(
      databaseUrl(postgresUrl!, directName),
      `select pg_notify('${channel}', 'direct')`,
    );
    await expect.poll(() => payloads).toEqual(["direct"]);
  });

  it("migrates over the direct connection", async () => {
    const folder = await mkdtemp(join(tmpdir(), "parlor-direct-"));
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "0000_init.sql"), "create table migrated (n int);");
    await writeFile(
      join(folder, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [{ idx: 0, version: "7", when: 1, tag: "0000_init", breakpoints: true }],
      }),
    );
    await handle.migrate(folder);
    const where = async (name: string) =>
      (
        await admin<{ n: number }>(
          databaseUrl(postgresUrl!, name),
          "select count(*)::int as n from information_schema.tables where table_name = 'migrated'",
        )
      )[0]!.n;
    expect(await where(directName)).toBe(1);
    expect(await where(pooledName)).toBe(0);
  });
});
