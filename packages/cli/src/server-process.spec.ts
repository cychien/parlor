import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "@parlor/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  serverEnv,
  startServerProcess,
  stopServerProcess,
  untilListening,
} from "./server-process.js";

describe("serverEnv", () => {
  it("tells the server its port, the app name, the web origin and that it runs under parlor dev", () => {
    const config = parseConfig({
      app: { id: "dev.parlor.test", name: "Test" },
      server: { port: 3100 },
      web: { port: 5200 },
    });
    expect(serverEnv(config, { PATH: "/bin" })).toEqual({
      PATH: "/bin",
      PORT: "3100",
      PARLOR_WEB_ORIGIN: "http://localhost:5200",
      PARLOR_DEV: "1",
      PARLOR_APP_NAME: "Test",
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

describe("stopServerProcess", () => {
  function fakeChild() {
    const emitter = new EventEmitter();
    const kill = vi.fn();
    const child = Object.assign(emitter, {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill,
    });
    return { child: child as unknown as ChildProcess, emitter, kill };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends no signal to a child that exits on its own within the grace", async () => {
    const { child, emitter, kill } = fakeChild();
    const stopped = stopServerProcess(child, 1000);
    await vi.advanceTimersByTimeAsync(900);
    emitter.emit("exit", 0, null);
    await stopped;
    await vi.advanceTimersByTimeAsync(5000);
    expect(kill).not.toHaveBeenCalled();
  });

  it("sends SIGTERM once when the child has not exited after the grace", async () => {
    const { child, emitter, kill } = fakeChild();
    const stopped = stopServerProcess(child, 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    emitter.emit("exit", 0, null);
    await stopped;
  });

  it("returns at once for a child that already exited", async () => {
    const { child, kill } = fakeChild();
    child.exitCode = 0;
    await stopServerProcess(child, 1000);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("untilListening", () => {
  function child(state: { exitCode: number | null } = { exitCode: null }) {
    return Object.assign(state, { signalCode: null }) as unknown as ChildProcess;
  }

  it("resolves once the port accepts a connection", async () => {
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, () => {
        const { port: free } = probe.address() as AddressInfo;
        probe.close(() => resolve(free));
      });
    });
    let listened = false;
    setTimeout(() => server.listen(port, () => (listened = true)), 150);
    await untilListening(child(), port, 20);
    expect(listened).toBe(true);
    server.close();
  });

  it("stops waiting when the server process has exited", async () => {
    await expect(untilListening(child({ exitCode: 1 }), 1, 20)).resolves.toBeUndefined();
  });
});
