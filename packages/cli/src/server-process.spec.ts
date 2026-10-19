import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "@parlor/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import { serverEnv, startServerProcess } from "./server-process.js";

describe("serverEnv", () => {
  it("tells the server its port and the origin the web dev server serves the app on", () => {
    const config = parseConfig({
      app: { id: "dev.parlor.test", name: "Test" },
      server: { port: 3100 },
      web: { port: 5200 },
    });
    expect(serverEnv(config, { PATH: "/bin" })).toEqual({
      PATH: "/bin",
      PORT: "3100",
      PARLOR_WEB_ORIGIN: "http://localhost:5200",
    });
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port assigned")),
      );
    });
  });
}

describe("startServerProcess shutdown", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lets the server answer a held request when its process group was already signaled", async () => {
    vi.stubEnv("CI", undefined);
    vi.stubEnv("TEST", undefined);
    const rootDir = await mkdtemp(join(tmpdir(), "parlor-server-process-"));
    const closedMarker = join(rootDir, "closed");
    const arrivedMarker = join(rootDir, "arrived");
    await writeFile(
      join(rootDir, "server.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        "let release = () => {};",
        "export default {",
        "  fetch: (request: Request) => {",
        '    if (new URL(request.url).pathname === "/ready") return new Response("ready");',
        `    writeFileSync(${JSON.stringify(arrivedMarker)}, "arrived");`,
        '    return new Promise<Response>((resolve) => { release = () => resolve(new Response("answered at shutdown")); });',
        "  },",
        "  close: async () => {",
        "    await new Promise((resolve) => setTimeout(resolve, 100));",
        "    release();",
        "    await new Promise((resolve) => setTimeout(resolve, 300));",
        `    writeFileSync(${JSON.stringify(closedMarker)}, "closed");`,
        "  },",
        "};",
      ].join("\n"),
    );
    const port = await freePort();
    const config = parseConfig({
      app: { id: "dev.parlor.test", name: "Test" },
      server: { port },
    });
    const child = startServerProcess({ config, configFile: "", rootDir });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const realKill = process.kill;
    const reraised = new Promise<void>((resolve) => {
      process.kill = ((pid: number, signal?: string | number) =>
        pid === process.pid
          ? (resolve(), true)
          : realKill(pid, signal)) as typeof process.kill;
    });
    try {
      await vi.waitFor(
        async () =>
          expect(
            (
              await fetch(`http://localhost:${port}/ready`, {
                headers: { connection: "close" },
              })
            ).ok,
          ).toBe(true),
        { timeout: 30_000, interval: 100 },
      );
      const held = fetch(`http://localhost:${port}/held`, {
        headers: { connection: "close" },
      }).then((response) => response.text());

      await vi.waitFor(() => readFile(arrivedMarker, "utf8"), { interval: 20 });

      child.kill("SIGTERM");
      process.emit("SIGTERM");

      await expect(held).resolves.toBe("answered at shutdown");
      await reraised;
      await exited;
      await expect(readFile(closedMarker, "utf8")).resolves.toBe("closed");
    } finally {
      process.kill = realKill;
      child.kill("SIGKILL");
    }
  }, 60_000);
});
