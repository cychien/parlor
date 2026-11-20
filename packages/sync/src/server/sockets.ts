import type { Principal } from "@parlor/core";

import type { ServerChannel } from "../channel.js";
import type { SyncHub } from "./hub.js";
import type { MissedQuery } from "./routes.js";

/** Where a stream's frames go: a server-sent event stream or a socket. */
export interface StreamSink {
  push(frame: { readonly event?: string | undefined; readonly data: string }): void;
  close(): void;
  /** Resolves once the reader has taken everything queued, or the stream ended. */
  drained(): Promise<void>;
  onClosed(listener: () => void): void;
}

export interface StreamSpec {
  /** The caller's own stream first, then the others it hears. */
  readonly streams: readonly string[];
  readonly principal?: Principal | undefined;
  readonly clientId?: string | undefined;
  readonly channels: readonly ServerChannel[];
  readonly revoked?: AbortSignal | undefined;
  /** The server learns when its holder stops answering (`ChannelConnection.watched`). */
  readonly watched?: boolean | undefined;
}

/** A socket the platform holds for the server, also while the server sleeps. */
export interface HostedSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** What `attach` kept with it, which outlasts the server's memory. */
  readonly attachment: unknown;
  attach(value: unknown): void;
  /** When the platform last answered the client's ping on its own; undefined before it did. */
  readonly answeredAt: number | undefined;
}

/**
 * A runtime that holds sockets while the server sleeps, such as a Durable Object with
 * hibernation. It hands every close back through `SyncSockets.closed` and the alarm it was
 * asked for through `SyncSockets.alarm`, and answers `SOCKET_PING` with `SOCKET_PONG` itself.
 */
export interface SocketPlatform {
  accept(
    request: Request,
    attachment: unknown,
  ): { readonly response: Response; readonly socket: HostedSocket };
  sockets(): readonly HostedSocket[];
  /** Calls `SyncSockets.alarm` at `at`, or earlier when it already was to. */
  wakeAt(at: number): void | Promise<void>;
}

export interface RestoredSocket {
  readonly clientId: string;
  readonly audience: string | undefined;
  readonly remembered: unknown;
}

export interface SyncSockets {
  /** The platform of the instance now serving; another one than before drops what the last one wired. */
  install(platform: SocketPlatform): void;
  readonly installed: boolean;
  /**
   * Wires the sockets the platform kept while the server slept, once per instance. It runs
   * before anything else the instance serves, so no write reaches the hub before them.
   */
  ensure(): Promise<void>;
  /** What a client's socket URL carries in place of the credential this request has. */
  ticket(request: Request): Promise<string>;
  /** Accepts a socket for a ticket `ticket` gave; 401 for one that is unknown or spent. */
  open(request: Request): Promise<Response>;
  closed(socket: HostedSocket): Promise<void>;
  /** Closes the sockets whose pings went unanswered, and asks to be woken for the next due. */
  alarm(): Promise<void>;
  /** Keeps `value` with every socket of `clientId`, to hand to `restored` once they are rewired. */
  remember(clientId: string, value: unknown): void;
}

/** What a socket keeps with it: enough to wire it again after the server slept. */
export interface HeldSocket {
  readonly parlor: 1;
  /** The same socket across instances, which each hand it over as another object. */
  readonly id: string;
  readonly streams: readonly string[];
  readonly audience: string | undefined;
  readonly clientId: string | undefined;
  readonly principal: Principal | undefined;
  readonly channels: readonly string[];
  readonly openedAt: number;
  readonly remembered?: unknown;
  /** The last sync batch's cursor sent on it, to send what it missed once it is wired again. */
  readonly cursor?: string | undefined;
}

export interface SyncSocketsDeps {
  readonly hub: SyncHub;
  readonly pingMs: number;
  readonly held: (request: Request) => Promise<
    Omit<HeldSocket, "parlor" | "id" | "openedAt"> & {
      readonly revoked?: AbortSignal | undefined;
    }
  >;
  readonly attach: (
    sink: StreamSink,
    held: HeldSocket,
    revoked: AbortSignal | undefined,
    query: Omit<MissedQuery, "watchesBuild"> | undefined,
    /** False for a socket wired again, whose client was greeted when it opened. */
    greet: boolean,
  ) => Promise<void>;
  /**
   * Others write while the server sleeps (another runtime on the bus), so a socket wired again
   * catches up from the last cursor it was sent. Otherwise nothing is written meanwhile.
   */
  readonly resumes?: boolean | undefined;
  readonly restored?: ((socket: RestoredSocket) => void) | undefined;
  readonly now?: (() => number) | undefined;
  /** Starts every ticket, so a host can tell which runtime issued it (`ticketAccount`). */
  readonly ticketPrefix?: string | undefined;
}

const TICKET_ACCOUNT = /^([A-Za-z0-9_-]+)\./;

/** The account a ticket's prefix names, for a host that routes a socket to the runtime that issued it. */
export function ticketAccount(ticket: string): string | undefined {
  return TICKET_ACCOUNT.exec(ticket)?.[1];
}

const TICKET_TTL_MS = 30_000;
/** Under the platform's limit for what a socket keeps (2 KiB on Cloudflare). */
const MAX_ATTACHMENT_CHARS = 1800;

function heldOf(value: unknown): HeldSocket | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const held = value as Partial<HeldSocket>;
  return held.parlor === 1 &&
    typeof held.id === "string" &&
    Array.isArray(held.streams) &&
    Array.isArray(held.channels)
    ? (held as HeldSocket)
    : undefined;
}

interface Wired {
  readonly held: HeldSocket;
  /** The object the instance now serving hands over for it. */
  socket: HostedSocket;
  /** Ends the stream's wiring without closing the socket, which is gone. */
  end(): void;
}

/** The cursor of a sync batch frame, which carries no event name. */
function cursorOfFrame(frame: {
  readonly event?: string | undefined;
  readonly data: string;
}) {
  if (frame.event !== undefined && frame.event !== "message") return undefined;
  try {
    const cursor = (JSON.parse(frame.data) as { cursor?: unknown }).cursor;
    return typeof cursor === "string" ? cursor : undefined;
  } catch {
    return undefined;
  }
}

function socketSink(entry: { readonly socket: HostedSocket }) {
  const listeners: (() => void)[] = [];
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    for (const listener of listeners.splice(0)) listener();
  };
  const sink: StreamSink = {
    push({ event, data }) {
      if (ended) return;
      entry.socket.send(JSON.stringify({ event: event ?? "message", data }));
      const cursor = cursorOfFrame({ event, data });
      const held = cursor === undefined ? undefined : heldOf(entry.socket.attachment);
      if (held) entry.socket.attach({ ...held, cursor });
    },
    close() {
      if (ended) return;
      entry.socket.close(1000, "The stream ended.");
      end();
    },
    drained: () => Promise.resolve(),
    onClosed(listener) {
      if (ended) queueMicrotask(listener);
      else listeners.push(listener);
    },
  };
  return { sink, end };
}

export function createSyncSockets(deps: SyncSocketsDeps): SyncSockets {
  const now = deps.now ?? Date.now;
  const staleMs = Math.round(deps.pingMs * 2.5);
  const tickets = new Map<
    string,
    {
      readonly held: HeldSocket;
      readonly revoked?: AbortSignal | undefined;
      readonly expiresAt: number;
    }
  >();
  /**
   * By socket id. Wiring outlives the instance that made it while the process lives on, so
   * a new instance only hands each one its own object, and nothing a socket joined, such as
   * a computer's liveness, sees it leave and come back.
   */
  const wired = new Map<string, Wired>();
  const gone = new Set<string>();
  let platform: SocketPlatform | undefined;
  let rewired: Promise<void> | undefined;

  const wire = async (
    socket: HostedSocket,
    held: HeldSocket,
    revoked?: AbortSignal,
    query?: Omit<MissedQuery, "watchesBuild">,
    greet = true,
  ): Promise<Wired> => {
    const entry: Wired = { held, socket, end: () => undefined };
    const { sink, end } = socketSink(entry);
    entry.end = end;
    wired.set(held.id, entry);
    sink.onClosed(() => {
      if (wired.get(held.id) === entry) wired.delete(held.id);
    });
    try {
      await deps.attach(sink, held, revoked, query, greet);
    } catch (error) {
      sink.close();
      throw error;
    }
    return entry;
  };

  const rewire = async (from: SocketPlatform) => {
    await deps.hub.start();
    const present = new Set<string>();
    const restored: RestoredSocket[] = [];
    for (const socket of from.sockets()) {
      const kept = heldOf(socket.attachment);
      if (!kept || gone.has(kept.id)) continue;
      present.add(kept.id);
      const entry = wired.get(kept.id);
      if (entry) {
        entry.socket = socket;
        continue;
      }
      const resume =
        deps.resumes && kept.cursor !== undefined
          ? { since: kept.cursor, reset: false }
          : undefined;
      await wire(socket, kept, undefined, resume, false);
      if (kept.clientId !== undefined && kept.remembered !== undefined) {
        restored.push({
          clientId: kept.clientId,
          audience: kept.audience,
          remembered: kept.remembered,
        });
      }
    }
    for (const [id, entry] of wired) {
      if (present.has(id)) continue;
      wired.delete(id);
      entry.end();
    }
    for (const socket of restored) deps.restored?.(socket);
  };

  const ensure = () => {
    const current = platform;
    if (!current) return Promise.resolve();
    rewired ??= rewire(current).catch((error: unknown) => {
      if (platform === current) rewired = undefined;
      throw error;
    });
    return rewired;
  };

  const closed = async (socket: HostedSocket) => {
    const held = heldOf(socket.attachment);
    if (!held || gone.has(held.id)) return;
    gone.add(held.id);
    let entry = wired.get(held.id);
    if (!entry) {
      // Only a computer's leaving is news to anyone; a tab's socket needs no rewiring to go.
      if (held.principal?.kind !== "host") return;
      await ensure();
      entry = wired.get(held.id) ?? (await wire(socket, held));
    }
    wired.delete(held.id);
    entry.end();
  };

  return {
    install(next) {
      if (next === platform) return;
      platform = next;
      rewired = undefined;
      for (const socket of next.sockets()) {
        const held = heldOf(socket.attachment);
        const entry = held && wired.get(held.id);
        if (entry) entry.socket = socket;
      }
    },
    get installed() {
      return platform !== undefined;
    },
    ensure,
    async ticket(request) {
      const at = now();
      for (const [ticket, entry] of tickets) {
        if (entry.expiresAt <= at) tickets.delete(ticket);
      }
      const { revoked, ...rest } = await deps.held(request);
      const random = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
      const ticket = deps.ticketPrefix ? `${deps.ticketPrefix}.${random}` : random;
      tickets.set(ticket, {
        held: { parlor: 1, id: crypto.randomUUID(), ...rest, openedAt: at },
        revoked,
        expiresAt: at + TICKET_TTL_MS,
      });
      return ticket;
    },
    async open(request) {
      const current = platform;
      const url = new URL(request.url);
      const ticket = url.searchParams.get("ticket") ?? "";
      const issued = tickets.get(ticket);
      tickets.delete(ticket);
      if (!current || !issued || issued.expiresAt <= now()) {
        return Response.json(
          {
            error: {
              code: "unauthenticated",
              message: "This socket ticket is unknown or spent.",
            },
          },
          { status: 401 },
        );
      }
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response(null, { status: 426, headers: { upgrade: "websocket" } });
      }
      await ensure();
      const held: HeldSocket = { ...issued.held, openedAt: now() };
      const { response, socket } = current.accept(request, held);
      await wire(socket, held, issued.revoked, {
        since: url.searchParams.get("since") ?? "",
        reset: url.searchParams.get("reset") === "1",
      });
      await current.wakeAt(now() + staleMs);
      return response;
    },
    closed,
    async alarm() {
      const current = platform;
      if (!current) return;
      const at = now();
      let next = Infinity;
      for (const socket of current.sockets()) {
        const held = heldOf(socket.attachment);
        if (!held || gone.has(held.id)) continue;
        const heard = Math.max(socket.answeredAt ?? 0, held.openedAt);
        if (heard + staleMs > at) {
          next = Math.min(next, heard + staleMs);
          continue;
        }
        socket.close(1011, "The client stopped answering.");
        await closed(socket);
      }
      if (next < Infinity) await current.wakeAt(next);
    },
    remember(clientId, value) {
      for (const socket of platform?.sockets() ?? []) {
        const held = heldOf(socket.attachment);
        if (held?.clientId !== clientId) continue;
        const { remembered: _forgotten, ...without } = held;
        const next: HeldSocket =
          value === undefined ? without : { ...without, remembered: value };
        socket.attach(
          JSON.stringify(next).length <= MAX_ATTACHMENT_CHARS ? next : without,
        );
      }
    },
  };
}
