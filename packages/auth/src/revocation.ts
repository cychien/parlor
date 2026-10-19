import type { DataProvider } from "@parlor/core";
import { sql } from "drizzle-orm";

import { type Database, rowsOf } from "./database.js";

export const REVOCATION_CHANNEL = "parlor_auth";

/** NOTIFY payload. Ids only, never content. */
export interface RevocationNotice {
  readonly kind: "session" | "grant";
  readonly id: string;
}

interface Revocation extends RevocationNotice {
  readonly at: number;
}

export interface RevocationSetOptions {
  readonly database: DataProvider;
  /**
   * The longest any credential this set guards stays valid. Older revocations are
   * forgotten: nothing they revoke can still verify.
   */
  readonly horizonMs: number;
  readonly now?: (() => number) | undefined;
  readonly relistenBaseMs?: number | undefined;
  readonly relistenMaxMs?: number | undefined;
}

/**
 * `following` answers from memory, kept current by NOTIFY. `checking` answers with one
 * primary-key lookup per call: poll-only providers always do, and a following set falls
 * back to it while its LISTEN connection is down.
 */
export type RevocationMode = "starting" | "following" | "checking";

const keyOf = ({ kind, id }: RevocationNotice) => `${kind}:${id}`;

interface Watch {
  readonly controllers: Set<WeakRef<AbortController>>;
  readonly since: number;
}

const owner = Symbol("parlor.revocation.owner");

/**
 * Every instance's view of what was revoked within the horizon. It loads before it
 * admits anyone, and whenever its LISTEN connection drops it checks the table per call
 * until it listens again and reloads, because a NOTIFY sent meanwhile is lost.
 */
export class RevocationSet {
  readonly #database: DataProvider;
  readonly #horizonMs: number;
  readonly #now: () => number;
  readonly #relistenBaseMs: number;
  readonly #relistenMaxMs: number;
  readonly #revoked = new Map<string, number>();
  readonly #watches = new Map<string, Watch>();
  readonly #forget = new FinalizationRegistry<string>((key) => this.#sweepWatch(key));
  #mode: RevocationMode = "starting";
  #ready: Promise<void> | undefined;
  #generation = 0;
  #unlisten: (() => Promise<void>) | undefined;
  #reconnecting = false;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #sweptAt = 0;
  #stopped = false;

  constructor(options: RevocationSetOptions) {
    this.#database = options.database;
    this.#horizonMs = options.horizonMs;
    this.#now = options.now ?? Date.now;
    this.#relistenBaseMs = options.relistenBaseMs ?? 1000;
    this.#relistenMaxMs = options.relistenMaxMs ?? 30_000;
  }

  get mode(): RevocationMode {
    return this.#mode;
  }

  /** Resolves once the set can answer; a failed start is retried by the next call. */
  ready(): Promise<void> {
    this.#ready ??= this.#start().catch((error: unknown) => {
      this.#ready = undefined;
      throw error;
    });
    return this.#ready;
  }

  /**
   * Revoked when a revocation of the notice is at or after `issuedAt`; without it, when
   * any revocation of the notice is within the horizon.
   */
  async isRevoked(notice: RevocationNotice, issuedAt = 0): Promise<boolean> {
    await this.ready();
    const at =
      this.#mode === "following"
        ? this.#revoked.get(keyOf(notice))
        : await this.#lookup(notice);
    return at !== undefined && at >= Math.max(issuedAt, this.#now() - this.#horizonMs);
  }

  /** Aborts when any of the notices is revoked from now on. */
  signal(notices: readonly RevocationNotice[]): AbortSignal {
    const controller = new AbortController();
    // The signal pins its controller, so a watch lives exactly as long as its holder.
    Object.defineProperty(controller.signal, owner, { value: controller });
    const since = this.#now();
    for (const notice of notices) {
      const key = keyOf(notice);
      let watch = this.#watches.get(key);
      if (!watch) this.#watches.set(key, (watch = { controllers: new Set(), since }));
      watch.controllers.add(new WeakRef(controller));
      this.#forget.register(controller.signal, key);
    }
    return controller.signal;
  }

  /** Records the revocation in the caller's transaction; the NOTIFY goes out on commit. */
  static async revoke(
    tx: unknown,
    notice: RevocationNotice,
    at: number = Date.now(),
  ): Promise<void> {
    const db = tx as Database;
    await db.execute(sql`
      insert into parlor_auth_revocations (kind, id, revoked_at)
      values (${notice.kind}, ${notice.id}, ${new Date(at).toISOString()})
      on conflict (kind, id) do update set revoked_at = excluded.revoked_at`);
    const payload: Revocation = { kind: notice.kind, id: notice.id, at };
    await db.execute(
      sql`select pg_notify(${REVOCATION_CHANNEL}, ${JSON.stringify(payload)})`,
    );
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#generation += 1;
    if (this.#retry !== undefined) clearTimeout(this.#retry);
    const unlisten = this.#unlisten;
    this.#unlisten = undefined;
    await unlisten?.().catch(() => {});
  }

  async #start(): Promise<void> {
    await this.#prune();
    if (!this.#database.listen) {
      this.#mode = "checking";
      return;
    }
    try {
      await this.#connect(this.#now() - this.#horizonMs);
    } catch (error) {
      console.warn("[parlor] revocations: LISTEN failed, checking per call:", error);
      this.#mode = "checking";
      this.#reconnect(this.#now());
    }
  }

  async #connect(since: number): Promise<void> {
    const generation = ++this.#generation;
    const unlisten = await this.#database.listen!(
      REVOCATION_CHANNEL,
      (payload) => this.#receive(payload),
      { onLost: () => this.#lost(generation) },
    );
    if (generation !== this.#generation) {
      await unlisten().catch(() => {});
      return;
    }
    this.#unlisten = unlisten;
    const revocations = await this.#load(since);
    if (generation !== this.#generation) return;
    for (const revocation of revocations) this.#apply(revocation);
    this.#mode = "following";
  }

  #lost(generation: number): void {
    if (generation !== this.#generation || this.#stopped) return;
    this.#generation += 1;
    this.#unlisten = undefined;
    this.#mode = "checking";
    this.#reconnect(this.#now());
  }

  #reconnect(lostAt: number): void {
    if (this.#reconnecting) return;
    this.#reconnecting = true;
    let delay = this.#relistenBaseMs;
    const attempt = async () => {
      this.#retry = undefined;
      if (this.#stopped) return;
      try {
        await this.#connect(Math.min(lostAt, this.#now() - this.#horizonMs));
        this.#reconnecting = false;
      } catch (error) {
        console.warn("[parlor] revocations: LISTEN failed, retrying:", error);
        this.#retry = setTimeout(attempt, delay);
        delay = Math.min(delay * 2, this.#relistenMaxMs);
      }
    };
    this.#retry = setTimeout(attempt, 0);
  }

  #receive(payload: string): void {
    try {
      this.#apply(JSON.parse(payload) as Revocation);
    } catch {
      console.warn("[parlor] revocations: ignored a malformed notice");
    }
  }

  #apply(revocation: Revocation): void {
    const key = keyOf(revocation);
    const known = this.#revoked.get(key);
    if (known === undefined || revocation.at > known)
      this.#revoked.set(key, revocation.at);
    this.#sweepExpired();
    const watch = this.#watches.get(key);
    if (!watch || revocation.at < watch.since) return;
    this.#watches.delete(key);
    for (const ref of watch.controllers) ref.deref()?.abort();
  }

  #sweepExpired(): void {
    const now = this.#now();
    if (now - this.#sweptAt < this.#horizonMs) return;
    this.#sweptAt = now;
    for (const [key, at] of this.#revoked) {
      if (at < now - this.#horizonMs) this.#revoked.delete(key);
    }
  }

  #sweepWatch(key: string): void {
    const watch = this.#watches.get(key);
    if (!watch) return;
    for (const ref of watch.controllers) if (!ref.deref()) watch.controllers.delete(ref);
    if (watch.controllers.size === 0) this.#watches.delete(key);
  }

  async #lookup(notice: RevocationNotice): Promise<number | undefined> {
    const rows = rowsOf<{ revoked_at: string | Date }>(
      await (this.#database.read() as Database).execute(sql`
        select revoked_at from parlor_auth_revocations
        where kind = ${notice.kind} and id = ${notice.id}`),
    );
    const row = rows[0];
    return row ? new Date(row.revoked_at).getTime() : undefined;
  }

  async #load(since: number): Promise<Revocation[]> {
    const rows = rowsOf<{
      kind: Revocation["kind"];
      id: string;
      revoked_at: string | Date;
    }>(
      await (this.#database.read() as Database).execute(sql`
        select kind, id, revoked_at from parlor_auth_revocations
        where revoked_at >= ${new Date(since).toISOString()}`),
    );
    return rows.map((row) => ({
      kind: row.kind,
      id: row.id,
      at: new Date(row.revoked_at).getTime(),
    }));
  }

  async #prune(): Promise<void> {
    const cutoff = new Date(this.#now() - this.#horizonMs).toISOString();
    await (this.#database.read() as Database).execute(
      sql`delete from parlor_auth_revocations where revoked_at < ${cutoff}`,
    );
  }
}
