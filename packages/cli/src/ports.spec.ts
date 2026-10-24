import { createServer, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { firstFreePort, isPortFree, resolveDevPorts } from "./ports.js";

const held: Server[] = [];

function hold(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port, host, exclusive: true }, () => {
      held.push(server);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

/** Below every OS's ephemeral range, so ports the suite's other connections get never land in it. */
const RUN_FLOOR = 10_000;
const RUN_SPAN = 20_000;

async function freeRun(length: number): Promise<number> {
  for (;;) {
    const start = RUN_FLOOR + Math.floor(Math.random() * (RUN_SPAN - length));
    let all = true;
    for (let port = start; port < start + length && all; port += 1) {
      all = await isPortFree(port);
    }
    if (all) return start;
  }
}

afterEach(async () => {
  await Promise.all(
    held.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

describe("isPortFree", () => {
  it.each(["127.0.0.1", "::1", "0.0.0.0"])(
    "is false while %s holds the port",
    async (host) => {
      const port = await freeRun(1);
      await hold(port, host);
      expect(await isPortFree(port)).toBe(false);
    },
  );
});

describe("firstFreePort", () => {
  it("returns the wanted port when it is free", async () => {
    const port = await freeRun(1);
    expect(await firstFreePort(port)).toBe(port);
  });

  it("skips a held port and a port another dev process already took", async () => {
    const port = await freeRun(3);
    await hold(port, "::1");
    expect(await firstFreePort(port, new Set([port + 1]))).toBe(port + 2);
  });
});

describe("resolveDevPorts", () => {
  it("gives each target its own web port, the first at the wanted one, none the server's", async () => {
    const port = await freeRun(5);
    await hold(port + 2, "127.0.0.1");
    const lines: string[] = [];
    expect(
      await resolveDevPorts({ server: port + 1, web: port, targets: 3 }, (line) =>
        lines.push(line),
      ),
    ).toEqual({ server: port + 1, web: [port, port + 3, port + 4] });
    expect(lines).toEqual([]);
  });

  it("keeps free ports and says nothing", async () => {
    const port = await freeRun(2);
    const lines: string[] = [];
    expect(
      await resolveDevPorts({ server: port, web: port + 1 }, (line) => lines.push(line)),
    ).toEqual({ server: port, web: [port + 1] });
    expect(lines).toEqual([]);
  });

  it("moves each busy port to the next free one and names both", async () => {
    const port = await freeRun(4);
    await hold(port, "0.0.0.0");
    await hold(port + 2, "::1");
    const lines: string[] = [];
    expect(
      await resolveDevPorts({ server: port, web: port + 2 }, (line) => lines.push(line)),
    ).toEqual({ server: port + 1, web: [port + 3] });
    expect(lines).toEqual([
      `Port ${port} is in use, so the server uses ${port + 1}.`,
      `Port ${port + 2} is in use, so the page uses ${port + 3}.`,
    ]);
  });
});
