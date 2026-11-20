import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import type { HostedSocket, SocketPlatform } from "@parlor/sync/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createServer, type FrameworkServer } from "./create-server.js";

const actions = createRegistry({
  addNote: defineAction({
    description: "Add a note.",
    input: z.object({}),
    writes: ["notes"],
    run: () => ({ id: crypto.randomUUID() }),
  }),
});

interface Line {
  readonly sent: string[];
  attachment: unknown;
  closed: boolean;
}

/** One Durable Object instance's view of the sockets the platform holds. */
function instance(lines: Line[]): SocketPlatform & { of(line: Line): HostedSocket } {
  const wrapped = new Map<Line, HostedSocket>();
  const of = (line: Line) => {
    let socket = wrapped.get(line);
    if (!socket) {
      socket = {
        send: (data) => void (line.closed || line.sent.push(data)),
        close: () => void (line.closed = true),
        get attachment() {
          return line.attachment;
        },
        attach: (value) => void (line.attachment = value),
        answeredAt: undefined,
      };
      wrapped.set(line, socket);
    }
    return socket;
  };
  return {
    of,
    accept(_request, attachment) {
      const line: Line = { sent: [], attachment, closed: false };
      lines.push(line);
      return { response: new Response("upgraded"), socket: of(line) };
    },
    sockets: () => lines.filter((line) => !line.closed).map(of),
    wakeAt: () => undefined,
  };
}

let database: DatabaseHandle;
let server: FrameworkServer;

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
  server = createServer({ actions, database });
}, 30_000);
afterAll(() => server.close());

const call = (path: string, init: RequestInit = {}) =>
  server.fetch(
    new Request(`http://app.test${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-parlor-client": "tab-1",
        ...(init.headers as object),
      },
    }),
  );

describe("a server whose runtime holds its sockets while it sleeps", () => {
  it("serves sync over them, and wires them again in the next instance with what each client last said", async () => {
    const lines: Line[] = [];
    server.installSockets!(instance(lines));
    const negotiated = (await (
      await call("/_parlor/sync/token?transports=ws", { method: "POST" })
    ).json()) as { transport: string; ticket: string };
    expect(negotiated.transport).toBe("ws");
    const opened = await call(`/_parlor/sync/socket?ticket=${negotiated.ticket}&since=`, {
      headers: { upgrade: "websocket" },
    });
    expect(await opened.text()).toBe("upgraded");
    expect(JSON.parse(lines[0]!.sent[0]!)).toMatchObject({ event: "handshake" });

    const presence = {
      type: "presence",
      focused: true,
      visible: true,
      platform: "web",
      ops: ["screen"],
    };
    expect(
      (await call("/_parlor/ui", { method: "POST", body: JSON.stringify(presence) }))
        .status,
    ).toBe(204);
    expect(lines[0]!.attachment).toMatchObject({
      clientId: "tab-1",
      remembered: presence,
    });

    server.installSockets!(instance(lines));
    const wrote = await call("/_parlor/actions/addNote", { method: "POST", body: "{}" });
    const { data } = (await wrote.json()) as { data: { id: string } };
    await vi.waitFor(() => expect(lines[0]!.sent.join("\n")).toContain(data.id));

    const leave = await call("/_parlor/ui", {
      method: "POST",
      body: JSON.stringify({ type: "leave" }),
    });
    expect(leave.status).toBe(204);
    expect(lines[0]!.attachment).not.toHaveProperty("remembered");
  });

  it("answers a socket's opening itself, never through the router", async () => {
    server.installSockets!(instance([]));
    const refused = await call("/_parlor/sync/socket?ticket=nothing", {
      headers: { upgrade: "websocket" },
    });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("x-parlor-unrouted")).toBeNull();
  });
});
