import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PROMPTER = fileURLToPath(new URL("./prompter.ts", import.meta.url));
const PAIRING = fileURLToPath(new URL("./pairing.ts", import.meta.url));
const SPEC_KIT = fileURLToPath(new URL("./spec-kit.ts", import.meta.url));

function confirmOnTerminal(answer: string): Promise<{ out: string; confirmed: string }> {
  const script = `
    import { register } from "tsx/esm/api";
    register();
    const { terminalPrompter } = await import(${JSON.stringify(PROMPTER)});
    const confirmed = await terminalPrompter().confirmPairing({
      appName: "Hello",
      appOrigin: "http://localhost:5301",
      account: { userId: "alice", name: "Alice", email: "alice@example.com" },
      matchingCode: "K7Q-4XZ",
    });
    process.stdout.write("\\n" + String(confirmed));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["pipe", "pipe", "inherit"],
  });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    out += chunk;
    if (out.includes("[y/N]")) child.stdin.end(`${answer}\n`);
  });
  return new Promise((resolve) =>
    child.once("exit", () => resolve({ out, confirmed: out.split("\n").at(-1)! })),
  );
}

describe("terminalPrompter", () => {
  it("shows the account and the matching code and connects only on y", async () => {
    const yes = await confirmOnTerminal("y");
    expect(yes.out).toContain(
      "Connect this computer to Hello as alice@example.com? Code K7Q-4XZ [y/N] ",
    );
    expect(yes.confirmed).toBe("true");
    expect((await confirmOnTerminal("")).confirmed).toBe("false");
    expect((await confirmOnTerminal("n")).confirmed).toBe("false");
  });
});

const HOSTILE_NAME = "\u001b[2J\u001b[HHello\u0007\r";
const HOSTILE_EMAIL = "\u001b[31malice\u009b0m@example.com\u0007\rTrusted? Code ABC-123";

async function hostileApp() {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://stub").pathname;
      const body =
        path === "/_parlor/manifest"
          ? { protocol: 1, app: { name: HOSTILE_NAME } }
          : path === "/_parlor/auth/hosts/token"
            ? {
                grant: { id: "host:g1", hostId: "h1" },
                account: { userId: "alice", name: "Alice", email: HOSTILE_EMAIL },
              }
            : {};
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("what pairing prints from the app", () => {
  it("T4-10: the confirmation shows the app's name and the account without control characters", async () => {
    const app = await hostileApp();
    const script = `
      import { register } from "tsx/esm/api";
      register();
      const { pair } = await import(${JSON.stringify(PAIRING)});
      const { terminalPrompter } = await import(${JSON.stringify(PROMPTER)});
      const { memoryHostKeys } = await import(${JSON.stringify(SPEC_KIT)});
      await pair({
        appOrigin: ${JSON.stringify(app.origin)},
        hostName: "Alice's MacBook Pro",
        platform: "macos",
        keys: memoryHostKeys(),
        prompter: terminalPrompter(),
        workspaceRoot: "/Users/alice/Parlor",
        channel: {
          kind: "browser",
          open: async (url) => {
            const asked = new URL(url);
            const callback = new URL(asked.searchParams.get("redirectUri"));
            callback.searchParams.set("state", asked.searchParams.get("state"));
            callback.searchParams.set("code", "code-1");
            await fetch(callback);
          },
        },
      });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.setEncoding("latin1");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (out.includes("[y/N]")) child.stdin.end("n\n");
    });
    await new Promise((resolve) => child.once("exit", resolve));
    await app.close();

    const shown = out.slice(0, out.indexOf("[y/N]") + "[y/N] ".length);
    expect(shown).toContain("Connect this computer to");
    const bytes = [...Buffer.from(shown, "latin1")];
    expect(bytes.filter((byte) => byte < 0x20 || (byte >= 0x7f && byte <= 0x9f))).toEqual(
      [],
    );
    const text = Buffer.from(shown, "latin1").toString("utf8");
    expect(text).toContain("[2J[HHello");
    expect(text).toContain("[31malice0m@example.com");
  }, 30_000);
});
