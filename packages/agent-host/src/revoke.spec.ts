import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { asId } from "@parlor/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type AppGrant, fileGrantStore, keychainHostKeys } from "./grants.js";
import { hostPaths } from "./paths.js";

const BIN = fileURLToPath(new URL("../bin/parlor-host-dev.mjs", import.meta.url));
const SERVICE = "dev.parlor.host";

let home: string;
let app: Server;
let origin: string;
let revokeStatus = 500;
const revokes: string[] = [];
const keychain = () => join(home, "Library", "Keychains", "login.keychain-db");

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "pr-"));
  vi.stubEnv("HOME", home);
  mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
  execFileSync("security", ["create-keychain", "-p", "", keychain()], {
    env: { ...process.env, HOME: home },
  });

  app = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://stub").pathname;
      const json = (value: unknown, status = 200) =>
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify(value));
      if (path === "/_parlor/manifest")
        return json({ protocol: 1, app: { name: "Hello" } });
      if (path === "/_parlor/auth/hosts/token") {
        return json({
          grant: { id: "host:declined", hostId: "h-declined" },
          account: { userId: "alice", name: "Alice", email: "alice@example.com" },
        });
      }
      if (path === "/_parlor/auth/hosts/revoke") {
        revokes.push(request.headers.authorization ?? "");
        return json(
          revokeStatus === 200 ? {} : { error: { code: "internal" } },
          revokeStatus,
        );
      }
      json({ error: { code: "not_found" } }, 404);
    });
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

afterAll(async () => {
  app.closeAllConnections();
  await new Promise((resolve) => app.close(resolve));
  execFileSync("security", ["delete-keychain", keychain()], {
    env: { ...process.env, HOME: home },
  });
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function parlorHost(
  args: readonly string[],
  options: { readonly answer?: string; readonly path?: string } = {},
): Promise<Ran> {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: {
      ...process.env,
      HOME: home,
      PATH: [options.path, process.env.PATH].filter(Boolean).join(delimiter),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    if (options.answer !== undefined && stdout.includes("[y/N]")) {
      child.stdin.end(`${options.answer}\n`);
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve) =>
    child.once("exit", (code) => resolve({ code, stdout, stderr })),
  );
}

const paths = () => hostPaths(join(home, ".parlor", "host"));

async function savedGrants(): Promise<Record<string, AppGrant>> {
  try {
    return JSON.parse(await readFile(paths().grants, "utf8")) as Record<string, AppGrant>;
  } catch {
    return {};
  }
}

const keyKept = async () =>
  keychainHostKeys(SERVICE)
    .assert(origin, { method: "POST", url: `${origin}/_parlor/auth/hosts/revoke` })
    .then(
      () => true,
      () => false,
    );

describe("revoking a grant the app refuses to revoke", () => {
  it("T4-12: parlor-host disconnect keeps the grant and key until the app agrees", async () => {
    const grant: AppGrant = {
      appOrigin: origin,
      appName: "Hello",
      grantId: asId("grant", "host:kept"),
      hostId: asId("host", "h-kept"),
      account: { userId: asId("user", "alice"), name: "Alice" },
      workspace: join(home, "Parlor", "hello"),
      createdAt: 1,
    };
    await (await keychainHostKeys(SERVICE).create(origin)).keep(grant.grantId);
    await fileGrantStore(paths().grants).save(grant);

    revokeStatus = 500;
    const refused = await parlorHost(["disconnect", origin]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("Hello");
    expect(Object.keys(await savedGrants())).toEqual([origin]);
    expect(await keyKept()).toBe(true);

    revokeStatus = 200;
    const revokedBefore = revokes.length;
    const agreed = await parlorHost(["disconnect", origin]);
    expect(agreed).toMatchObject({ code: 0, stderr: "" });
    expect(revokes.length).toBe(revokedBefore + 1);
    expect(await savedGrants()).toEqual({});
    expect(await keyKept()).toBe(false);
  }, 60_000);

  it("T4-12: a pairing declined here keeps the grant and key, never served, until the revoke goes through", async () => {
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const browser = join(bin, "open");
    await writeFile(
      browser,
      [
        `#!${process.execPath}`,
        "const url = new URL(process.argv[2]);",
        'const callback = new URL(url.searchParams.get("redirectUri"));',
        'callback.searchParams.set("state", url.searchParams.get("state"));',
        'callback.searchParams.set("code", "code-1");',
        "await fetch(callback);",
        "",
      ].join("\n"),
    );
    await chmod(browser, 0o755);

    revokeStatus = 500;
    const declined = await parlorHost(["connect", origin], { answer: "n", path: bin });
    expect(declined.stdout).toContain(
      "Connect this computer to Hello as alice@example.com?",
    );
    expect(declined.code).not.toBe(0);
    expect(declined.stderr).toContain("Hello");
    expect(await savedGrants()).toMatchObject({
      [origin]: { grantId: "host:declined", declined: true },
    });
    expect(await keyKept()).toBe(true);

    revokeStatus = 200;
    const agreed = await parlorHost(["disconnect", origin]);
    expect(agreed).toMatchObject({ code: 0, stderr: "" });
    expect(await savedGrants()).toEqual({});
    expect(await keyKept()).toBe(false);
  }, 60_000);
});
