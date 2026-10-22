// The harness-owned TCP forwarder in front of a serverless instance's server. It listens on the
// instance's public port, tags every accepted connection by the process on the other end (the
// browser's Chrome, the host's process, anything else), logs the HTTP requests that pass, and can
// cut one side: the sockets of that side stay open and their bytes stop, as a pulled cable looks,
// and new connections of that side are accepted and then held, until the cut ends.
import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import net from "node:net";

import { createExchangeTracker } from "./http-log.mjs";
import { createSideClassifier } from "./side-classifier.mjs";

const SIDES = ["browser", "host"];
const QUEUE_LIMIT_BYTES = 4 * 1024 * 1024;

export { SIDES };

/** One direction of a proxied connection: reads are never stopped, so a close is seen when it happens. */
class Lane {
  constructor(conn, direction, from) {
    this.conn = conn;
    this.direction = direction;
    this.from = from;
    this.queue = [];
    this.queued = 0;
    this.ended = false;
    this.endSent = false;
    this.blocked = false;
    from.on("data", (chunk) => this.receive(chunk));
    from.on("end", () => {
      this.ended = true;
      conn.noteClosed(direction === "up" ? "client" : "server");
      this.flush();
    });
    from.resume();
  }

  get to() {
    return this.direction === "up" ? this.conn.upstream : this.conn.client;
  }

  get open() {
    const to = this.to;
    return !this.conn.held && to !== undefined && !to.connecting && !to.destroyed;
  }

  receive(chunk) {
    if (this.queue.length === 0 && this.open && !this.blocked) {
      this.write(chunk, Date.now());
      return;
    }
    this.queue.push(chunk);
    this.queued += chunk.length;
    if (this.queued > QUEUE_LIMIT_BYTES) this.from.pause();
  }

  write(chunk, at) {
    this.conn.tracker[this.direction === "up" ? "request" : "response"](chunk, at);
    if (this.to.write(chunk)) return;
    this.blocked = true;
    this.from.pause();
    this.to.once("drain", () => {
      this.blocked = false;
      this.flush();
    });
  }

  flush() {
    while (this.queue.length > 0 && this.open && !this.blocked) {
      const chunk = this.queue.shift();
      this.queued -= chunk.length;
      this.write(chunk, Date.now());
    }
    if (this.queue.length > 0 || this.blocked || !this.open) return;
    if (this.from.isPaused()) this.from.resume();
    if (this.ended && !this.endSent) {
      this.endSent = true;
      this.to.end();
    }
  }
}

export async function startForwarder({
  port,
  backendPort,
  backendHost = "localhost",
  requestLog,
  controlPath,
  hostHomes,
  announce = () => {},
}) {
  const classifier = createSideClassifier({ hostHomes });
  const logFd = openSync(requestLog, "a");
  const conns = new Set();
  const cuts = new Map();
  let sequence = 0;

  function writeLog(entry) {
    try {
      writeSync(logFd, `${JSON.stringify(entry)}\n`);
    } catch {
      // the log is evidence, never a reason to drop traffic
    }
  }

  function logExchange(conn, { at, method, path, status, respondedAt }) {
    writeLog({ at, method, path, status, side: conn.side, respondedAt, conn: conn.id });
  }

  function finish(conn, by) {
    if (conn.destroyed) return;
    conn.destroyed = true;
    conns.delete(conn);
    conn.tracker.close();
    for (const exchange of conn.unlogged.splice(0)) logExchange(conn, exchange);
    if (by === "server") conn.client.destroySoon();
    else conn.client.destroy();
    if (by === "client") conn.upstream?.destroy();
    else conn.upstream?.destroySoon();
  }

  function peerGone(conn, by) {
    if (conn.destroyed) return;
    conn.noteClosed(by);
    if (conn.held) conn.gone ??= by;
    else finish(conn, by);
  }

  function open(conn) {
    const upstream = net.connect({
      port: backendPort,
      host: backendHost,
      allowHalfOpen: true,
    });
    conn.upstream = upstream;
    upstream.setNoDelay(true);
    conn.down = new Lane(conn, "down", upstream);
    upstream.on("error", () => peerGone(conn, "server"));
    upstream.on("close", () => peerGone(conn, "server"));
    upstream.once("connect", () => conn.up.flush());
  }

  function release(conn) {
    conn.held = false;
    if (!conn.upstream) {
      if (conn.gone) finish(conn, conn.gone);
      else open(conn);
      return;
    }
    if (conn.gone === "client") conn.up.ended = true;
    if (conn.gone === "server") conn.down.ended = true;
    conn.up.flush();
    conn.down.flush();
    if (conn.gone) finish(conn, conn.gone);
  }

  const server = [];
  const onConnection = (client) => {
    const conn = {
      id: (sequence += 1),
      client,
      upstream: undefined,
      up: undefined,
      down: undefined,
      side: "other",
      classified: false,
      unlogged: [],
      held: cuts.size > 0,
      gone: undefined,
      destroyed: false,
      tracker: undefined,
      noteClosed(by) {
        const cut = cuts.get(conn.side);
        if (cut && !cut.closed.some((entry) => entry.conn === conn.id))
          cut.closed.push({ conn: conn.id, by, at: Date.now() });
      },
    };
    conn.tracker = createExchangeTracker({
      onExchange: (exchange) => {
        if (conn.classified) logExchange(conn, exchange);
        else conn.unlogged.push(exchange);
      },
    });
    conns.add(conn);
    client.setNoDelay(true);
    conn.up = new Lane(conn, "up", client);
    client.on("error", () => peerGone(conn, "client"));
    client.on("close", () => peerGone(conn, "client"));
    if (!conn.held) open(conn);
    classifier.sideOf(client.remotePort, port).then((side) => {
      if (conn.destroyed) return;
      conn.side = side;
      conn.classified = true;
      for (const exchange of conn.unlogged.splice(0)) logExchange(conn, exchange);
      const cut = cuts.get(side);
      if (cut) {
        conn.held = true;
        cut.held.push(conn.id);
      } else if (conn.held) release(conn);
    });
  };

  async function listen(host) {
    const instance = net.createServer(
      { allowHalfOpen: true, pauseOnConnect: true },
      onConnection,
    );
    await new Promise((resolve, reject) => {
      instance.once("error", reject);
      instance.listen({ port, host }, resolve);
    });
    server.push(instance);
  }
  await listen("127.0.0.1");
  await listen("::1").catch(() => {});

  function startCut(side, ms) {
    if (cuts.has(side)) throw new Error(`${side} is already cut`);
    const members = () =>
      [...conns].filter((conn) => conn.side === side && !conn.destroyed);
    const state = {
      cutAt: Date.now(),
      open: members()
        .filter((conn) => !conn.held)
        .map((conn) => conn.id),
      held: [],
      closed: [],
    };
    cuts.set(side, state);
    for (const conn of members()) conn.held = true;
    for (const conn of conns) if (!conn.classified) conn.held = true;
    return new Promise((done) => {
      setTimeout(() => {
        const restoredAt = Date.now();
        cuts.delete(side);
        for (const conn of members()) release(conn);
        done({ side, ...state, restoredAt });
      }, ms);
    });
  }

  rmSync(controlPath, { force: true });
  const control = net.createServer((socket) => {
    let buffer = "";
    socket.on("error", () => {});
    socket.on("data", async (data) => {
      buffer += data;
      if (!buffer.includes("\n")) return;
      const line = buffer.slice(0, buffer.indexOf("\n"));
      buffer = "";
      let reply;
      try {
        const request = JSON.parse(line);
        if (request.op !== "cut" || !SIDES.includes(request.side) || !(request.ms >= 0))
          throw new Error(`bad request ${line}`);
        reply = await startCut(request.side, request.ms);
      } catch (error) {
        reply = { error: String(error?.message ?? error) };
      }
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    control.once("error", reject);
    control.listen(controlPath, resolve);
  });
  announce(`forwarding ${port} -> ${backendPort}, requests to ${requestLog}`);

  return async function close() {
    for (const instance of server) instance.close();
    control.close();
    for (const conn of [...conns]) finish(conn, "client");
    rmSync(controlPath, { force: true });
    await classifier.close();
    closeSync(logFd);
  };
}

/** One cut through the control socket: resolves at the restore with the times and counts. */
export function requestCut(controlPath, side, ms) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(controlPath);
    let reply = "";
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ op: "cut", side, ms })}\n`),
    );
    socket.on("data", (data) => (reply += data));
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        resolve(JSON.parse(reply));
      } catch {
        reject(
          new Error(`the forwarder closed without an answer (${reply || "nothing"})`),
        );
      }
    });
  });
}
