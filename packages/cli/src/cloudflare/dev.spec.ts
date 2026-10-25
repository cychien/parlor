import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseConfig } from "@parlor/config";
import { buildServer } from "@parlor/host";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startServerProcess } from "../server-process.js";
import { prepareCloudflareDev } from "./prepare.js";

const require = createRequire(import.meta.url);

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

function wranglerBin(): string {
  const manifest = require.resolve("wrangler/package.json");
  const { bin } = require(manifest) as { bin: { wrangler: string } };
  return join(dirname(manifest), bin.wrangler);
}

async function callAction(
  origin: string,
  name: string,
  input: unknown,
): Promise<unknown> {
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      const response = await fetch(`${origin}/_parlor/actions/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (response.ok) return ((await response.json()) as { data: unknown }).data;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${origin} did not answer ${name}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

const SERVER = `import { env } from "cloudflare:workers";
import { defineAction } from "@parlor/core";
import { createRegistry } from "@parlor/core/registry";
import { createServer } from "@parlor/server";
import { z } from "zod";

const actions = createRegistry({
  storeNote: defineAction({
    description: "Store a note in R2 and read it back.",
    input: z.object({ key: z.string(), text: z.string() }),
    run: async ({ key, text }) => {
      await env.MEDIA.put(key, text);
      const stored = await env.MEDIA.get(key);
      return {
        text: await stored.text(),
        env: { GREETING: env.GREETING, REGION: env.REGION },
        processEnv: {
          GREETING: process.env.GREETING,
          REGION: process.env.REGION,
          SHELL_WINS: process.env.SHELL_WINS,
        },
      };
    },
  }),
  openFridge: defineAction({
    description: "Ask the app's own Durable Object.",
    input: z.object({}),
    run: async () => {
      try {
        const stub = env.FRIDGE.get(env.FRIDGE.idFromName("kitchen"));
        return { reply: await (await stub.fetch("https://fridge/")).text() };
      } catch (error) {
        return { error: error.message };
      }
    },
  }),
});

export default createServer({ actions });
`;

const WORKER = `import { DurableObject } from "cloudflare:workers";

export class Fridge extends DurableObject {
  fetch() {
    return new Response("cold");
  }
}
`;

describe("a cloudflare-durable app", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reaches its R2 bucket and vars through cloudflare:workers in parlor dev and on wrangler dev", async () => {
    vi.stubEnv("CI", undefined);
    vi.stubEnv("TEST", undefined);
    vi.stubEnv("SHELL_WINS", "from-shell");
    const rootDir = await mkdtemp(join(tmpdir(), "parlor-cf-dev-"));
    await symlink(
      join(import.meta.dirname, "../../node_modules"),
      join(rootDir, "node_modules"),
    );
    await writeFile(join(rootDir, "package.json"), '{ "type": "module" }');
    await writeFile(join(rootDir, "server.ts"), SERVER);
    await writeFile(join(rootDir, "worker.ts"), WORKER);
    await writeFile(
      join(rootDir, ".dev.vars"),
      "GREETING=from-dev-vars\nSHELL_WINS=from-dev-vars\n",
    );
    const port = await freePort();
    const config = parseConfig({
      app: { id: "dev.parlor.cfdev", name: "Cloudflare dev" },
      server: { port },
      deploy: {
        preset: "cloudflare-durable",
        cloudflare: {
          exports: "worker.ts",
          wrangler: {
            vars: { REGION: "eu" },
            r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }],
            durable_objects: { bindings: [{ name: "FRIDGE", class_name: "Fridge" }] },
            migrations: [{ tag: "v1", new_sqlite_classes: ["Fridge"] }],
          },
        },
      },
    });
    const loaded = { config, rootDir, configFile: "" };

    const cloudflare = await prepareCloudflareDev(loaded, {});
    const devServer = startServerProcess(loaded, undefined, cloudflare);
    try {
      const origin = `http://localhost:${port}`;
      await expect(
        callAction(origin, "storeNote", { key: "notes/1", text: "hello from dev" }),
      ).resolves.toEqual({
        text: "hello from dev",
        env: { GREETING: "from-dev-vars", REGION: "eu" },
        processEnv: { GREETING: "from-dev-vars", REGION: "eu", SHELL_WINS: "from-shell" },
      });
      await expect(callAction(origin, "openFridge", {})).resolves.toEqual({
        error: expect.stringMatching(
          /^env\.FRIDGE is unavailable in parlor dev: it binds Fridge, a Durable Object class the app's own Worker defines/,
        ),
      });
      await expect(
        readdir(join(rootDir, ".parlor", "cloudflare", "state", "r2")),
      ).resolves.toContain("media");
    } finally {
      await stop(devServer);
    }

    const result = await buildServer(loaded, { preset: "cloudflare-durable" });
    await copyFile(
      join(rootDir, ".dev.vars"),
      join(result.outputDir, "server", ".dev.vars"),
    );
    const wranglerPort = await freePort();
    const wranglerDev = spawn(
      process.execPath,
      [
        wranglerBin(),
        "dev",
        "--config",
        join(result.outputDir, "server", "wrangler.json"),
        "--port",
        String(wranglerPort),
        "--ip",
        "127.0.0.1",
      ],
      {
        env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
        stdio: "ignore",
      },
    );
    try {
      const origin = `http://127.0.0.1:${wranglerPort}`;
      await expect(
        callAction(origin, "storeNote", { key: "notes/1", text: "hello from workerd" }),
      ).resolves.toEqual({
        text: "hello from workerd",
        env: { GREETING: "from-dev-vars", REGION: "eu" },
        processEnv: {
          GREETING: "from-dev-vars",
          REGION: "eu",
          SHELL_WINS: "from-dev-vars",
        },
      });
      await expect(callAction(origin, "openFridge", {})).resolves.toEqual({
        reply: "cold",
      });
    } finally {
      await stop(wranglerDev);
    }
  }, 240_000);
});
