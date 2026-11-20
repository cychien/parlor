import type { HostId, HostPrincipal, Tag } from "@parlor/core";
import type { ServerChannel } from "@parlor/sync";

import type { ChatOwner } from "../model.js";
import { HOSTS_TAG } from "../tags.js";
import { type ChatDb, type ChatStore, livenessQueries } from "./store.js";

/**
 * Longer than any computer stays online: the app's only server writes it once and takes it
 * back itself, so a computer's heartbeats cost the database nothing while nothing changes.
 */
export const CONNECTED_TTL_MS = 10 * 365 * 24 * 60 * 60_000;

/**
 * How the server learns that a computer left or a turn's lease lapsed without being told,
 * and announces it. Reads never depend on it: they compare the stored times themselves.
 */
export interface Liveness {
  /** How long a computer's report that it is online holds in the database. */
  readonly onlineTtlMs: number;
  /** The store, also noting the leases it grants. */
  readonly store: ChatStore;
  /**
   * Takes a computer's heartbeat in place of the lease renewal it is by default, and answers
   * a token its next ones may carry to `heard` instead of its credential.
   */
  beat?(owner: ChatOwner, host: HostPrincipal): Promise<string>;
  /** A heartbeat that carries only `token`; false when no computer holds it. */
  heard?(token: string): boolean;
  /**
   * `channel`, counting each computer's watched stream (`ChannelConnection.watched`) as it
   * being online: a socket the platform times holds it there with no heartbeat.
   */
  joined?(channel: ServerChannel): ServerChannel;
  /**
   * The computer said it is online or going offline (`hostHello`, `hostReport`); `written`
   * names the write of its liveness that recorded it (`ChatStore.reportHost`).
   */
  reported(owner: ChatOwner, host: HostPrincipal, online: boolean, written: string): void;
  start(): void;
  /** Stops its timers and resolves once what it had begun in the database has ended. */
  close(): void | Promise<void>;
}

export interface LivenessDeps {
  readonly store: ChatStore;
  readonly db: () => ChatDb;
  readonly heartbeatMs: number;
  /** Commits whatever lapsed, with the sync events it owes. */
  readonly reconcile: (owner?: ChatOwner) => Promise<void>;
  readonly announce: (owner: ChatOwner, tags: readonly Tag[]) => Promise<void>;
  /** Resolves once the tables exist; background work waits for it. */
  readonly ready: () => Promise<void>;
  readonly now?: (() => number) | undefined;
  /** Aborts when the computer's grant is revoked, so its token stops working at once. */
  readonly revoked?: ((host: HostPrincipal) => AbortSignal) | undefined;
}

type Timer = ReturnType<typeof setTimeout>;

const background = (timer: Timer): Timer => {
  (timer as { unref?: () => void }).unref?.();
  return timer;
};

const failed = (what: string) => (error: unknown) => {
  console.warn(`[parlor] chat: ${what} failed:`, error);
};

/**
 * For servers that share the database: liveness is a lease each heartbeat renews, and every
 * server looks for lapsed ones on a timer, since any of them may hold the computer.
 */
export function leasedLiveness(deps: LivenessDeps): Liveness {
  const onlineTtlMs = 2 * deps.heartbeatMs;
  let sweep: ReturnType<typeof setInterval> | undefined;
  let clamping: Promise<void> = Promise.resolve();
  return {
    onlineTtlMs,
    store: deps.store,
    reported: () => undefined,
    start() {
      clamping = deps
        .ready()
        .then(() => livenessQueries.clampOnline(deps.db(), onlineTtlMs))
        .catch(failed("shortening stale liveness"));
      sweep = setInterval(() => {
        deps
          .ready()
          .then(() => deps.reconcile())
          .catch(failed("sweeping lapsed turns"));
      }, deps.heartbeatMs);
      sweep.unref?.();
    },
    close() {
      clearInterval(sweep);
      return clamping;
    },
  };
}

interface Computer {
  owner: ChatOwner;
  host: HostPrincipal;
  /** What its heartbeats carry once it has one, sparing them the database a credential costs. */
  readonly token: string;
  heardAt: number;
  /** Its watched streams; while it has one, it is online however long it says nothing. */
  streams: number;
  /**
   * This server's write of its liveness, so nothing more is written while it stays;
   * undefined until the database has it online by this server's hand.
   */
  stored: string | undefined;
}

/**
 * For the app's only server: every computer's heartbeat reaches it, so it keeps liveness in
 * memory and touches the database only when a computer comes or goes, and looks for a lapsed
 * lease only when one it granted is due.
 */
export function connectedLiveness(deps: LivenessDeps): Liveness {
  const now = deps.now ?? Date.now;
  const graceMs = 2 * deps.heartbeatMs;
  /** Past a computer's next heartbeat, which a server that just started answers with a new token. */
  const restartGraceMs = 3 * deps.heartbeatMs;
  const computers = new Map<HostId, Computer>();
  const byToken = new Map<string, Computer>();
  let closed = false;

  let writes: Promise<void> = Promise.resolve();
  /** One at a time, so a computer that returns while it is being marked offline ends online. */
  const queued = (work: () => Promise<void>): Promise<void> => {
    const done = writes.then(() => (closed ? undefined : work()));
    writes = done.catch(() => undefined);
    return done;
  };

  const forget = (computer: Computer) => {
    if (computers.get(computer.host.hostId) === computer) {
      computers.delete(computer.host.hostId);
    }
    byToken.delete(computer.token);
  };

  let quiet: Timer | undefined;
  const watchQuiet = () => {
    if (quiet !== undefined) clearTimeout(quiet);
    quiet = undefined;
    if (closed) return;
    let next = Infinity;
    for (const computer of computers.values()) {
      if (computer.streams === 0) next = Math.min(next, computer.heardAt + graceMs);
    }
    if (next === Infinity) return;
    quiet = background(setTimeout(dropQuiet, Math.max(0, next - now())));
  };
  const dropQuiet = () => {
    quiet = undefined;
    for (const computer of [...computers.values()]) {
      if (computer.streams > 0 || computer.heardAt + graceMs > now()) continue;
      forget(computer);
      const { stored } = computer;
      const { hostId } = computer.host;
      if (stored === undefined) continue;
      queued(async () => {
        const owner = await livenessQueries.markOffline(deps.db(), hostId, stored);
        if (owner) await deps.announce(owner, [[HOSTS_TAG, hostId]]);
      }).catch(failed("marking a computer offline"));
    }
    watchQuiet();
  };

  const heardFrom = (owner: ChatOwner, host: HostPrincipal): Computer => {
    let computer = computers.get(host.hostId);
    if (computer) {
      computer.owner = owner;
      computer.host = host;
      computer.heardAt = now();
    } else {
      computer = {
        owner,
        host,
        token: `${crypto.randomUUID()}${crypto.randomUUID()}`,
        heardAt: now(),
        streams: 0,
        stored: undefined,
      };
      const signal = deps.revoked?.(host);
      if (signal?.aborted) return computer;
      computers.set(host.hostId, computer);
      byToken.set(computer.token, computer);
      const known = computer;
      signal?.addEventListener(
        "abort",
        () => {
          forget(known);
          watchQuiet();
        },
        { once: true },
      );
    }
    watchQuiet();
    return computer;
  };

  /** Has the database show the computer online, unless it already does or the computer left. */
  const store = (computer: Computer): Promise<void> =>
    queued(async () => {
      if (
        computer.stored !== undefined ||
        computers.get(computer.host.hostId) !== computer
      ) {
        return;
      }
      const { owner, host } = computer;
      const { returned, written } = await deps.store.heartbeat(
        deps.db(),
        owner,
        host,
        CONNECTED_TTL_MS,
      );
      computer.stored = written;
      if (returned) await deps.announce(owner, [[HOSTS_TAG, host.hostId]]);
    });

  let lease: { readonly timer: Timer; readonly at: number } | undefined;
  let sweeping: Promise<void> = Promise.resolve();
  const watchLease = (at: number) => {
    if (closed || (lease && lease.at <= at)) return;
    if (lease) clearTimeout(lease.timer);
    lease = { timer: background(setTimeout(leaseDue, Math.max(0, at - now()))), at };
  };
  const leaseDue = () => {
    lease = undefined;
    sweeping = deps
      .ready()
      .then(() => (closed ? undefined : deps.reconcile()))
      .then(() => (closed ? undefined : livenessQueries.nextLeaseEnd(deps.db())))
      .then((next) => {
        if (next !== undefined) watchLease(next);
      })
      .catch((error: unknown) => {
        failed("sweeping lapsed turns")(error);
        watchLease(now() + deps.heartbeatMs);
      });
  };

  let unseen: Timer | undefined;

  return {
    onlineTtlMs: CONNECTED_TTL_MS,
    store: {
      ...deps.store,
      async claimTurn(tx, owner, host, leaseMs) {
        const claimed = await deps.store.claimTurn(tx, owner, host, leaseMs);
        if (claimed) watchLease(claimed.leaseUntil);
        return claimed;
      },
    },
    async beat(owner, host) {
      const computer = heardFrom(owner, host);
      if (computer.stored === undefined) await store(computer);
      return computer.token;
    },
    joined: (channel) => ({
      event: channel.event,
      hosts: channel.hosts,
      connect(connection) {
        const leave = channel.connect(connection);
        const { principal } = connection;
        if (!connection.watched || principal?.kind !== "host") return leave;
        const computer = heardFrom(
          { scope: connection.scope, userId: principal.userId },
          principal,
        );
        computer.streams += 1;
        watchQuiet();
        if (computer.stored === undefined) {
          store(computer).catch(failed("marking a computer online"));
        }
        let left = false;
        return () => {
          leave();
          if (left) return;
          left = true;
          computer.streams -= 1;
          computer.heardAt = now();
          watchQuiet();
        };
      },
    }),
    heard(token) {
      const computer = byToken.get(token);
      if (!computer) return false;
      computer.heardAt = now();
      watchQuiet();
      return true;
    },
    reported(owner, host, online, written) {
      const computer = heardFrom(owner, host);
      if (online) {
        computer.stored = written;
        return;
      }
      forget(computer);
      watchQuiet();
    },
    start() {
      watchLease(now());
      // Computers a server that stopped left online prove themselves again, or go offline.
      unseen = background(
        setTimeout(() => {
          unseen = undefined;
          queued(async () => {
            await deps.ready();
            const absent = await livenessQueries.markOthersOffline(deps.db(), [
              ...computers.keys(),
            ]);
            for (const { id, owner } of absent) {
              await deps.announce(owner, [[HOSTS_TAG, id]]);
            }
          }).catch(failed("marking absent computers offline"));
        }, restartGraceMs),
      );
    },
    async close() {
      closed = true;
      if (quiet !== undefined) clearTimeout(quiet);
      if (lease) clearTimeout(lease.timer);
      if (unseen !== undefined) clearTimeout(unseen);
      quiet = lease = unseen = undefined;
      await Promise.all([sweeping, writes]);
    },
  };
}
