import { randomBytes } from "node:crypto";

import pg from "pg";

import { REVOCATION_CHANNEL } from "../revocation.js";

export const postgresUrl = process.env.PARLOR_TEST_DATABASE_URL;

export interface ScratchDatabase {
  readonly url: string;
  drop(): Promise<void>;
}

async function admin<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export async function createScratchDatabase(baseUrl: string): Promise<ScratchDatabase> {
  const name = `parlor_test_${randomBytes(6).toString("hex")}`;
  await admin(baseUrl, (client) => client.query(`create database ${name}`));
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return {
    url: url.href,
    drop: () =>
      admin(baseUrl, (client) =>
        client.query(`drop database if exists ${name} with (force)`),
      ).then(() => undefined),
  };
}

export function revocationListeners(url: string): Promise<number[]> {
  return admin(url, async (client) => {
    const { rows } = await client.query<{ pid: number }>(
      `select pid from pg_stat_activity
       where datname = current_database() and query = 'LISTEN "${REVOCATION_CHANNEL}"'`,
    );
    return rows.map((row) => row.pid);
  });
}

export function terminate(url: string, pids: readonly number[]): Promise<void> {
  return admin(url, async (client) => {
    for (const pid of pids) await client.query("select pg_terminate_backend($1)", [pid]);
  });
}

export async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}
