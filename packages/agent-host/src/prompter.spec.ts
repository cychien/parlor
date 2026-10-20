import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computerName } from "./naming.js";
import { macDialogPrompter } from "./prompter.js";

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

describe("macDialogPrompter", () => {
  let bin: string;

  beforeEach(async () => {
    bin = await mkdtemp(join(tmpdir(), "parlor-osascript-"));
    await writeFile(
      join(bin, "osascript"),
      `#!${process.execPath}
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.OSASCRIPT_LOG, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }) + "\\n");
if (process.env.OSASCRIPT_HANG) setInterval(() => {}, 1000);
else if (process.env.OSASCRIPT_FAIL) process.exit(1);
else process.stdout.write(process.env.OSASCRIPT_REPLY + "\\n");
`,
    );
    await chmod(join(bin, "osascript"), 0o755);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
    vi.stubEnv("OSASCRIPT_LOG", join(bin, "log"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(bin, { recursive: true, force: true });
  });

  const invocations = async () =>
    (await readFile(join(bin, "log"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv: string[]; pid: number });
  const split = (argv: string[]) => {
    const at = argv.indexOf("--");
    return { script: argv.slice(0, at), args: argv.slice(at + 1) };
  };
  const account = { userId: "alice" as never, name: "Alice", email: "alice@example.com" };
  const device = { name: "Chrome on macOS", platform: "web" };

  it("asks about a new device in one `Parlor Host` dialog with Don't allow and Allow", async () => {
    vi.stubEnv("OSASCRIPT_REPLY", "Allow");
    const allowed = await macDialogPrompter().approveDevice({
      appName: "Hello",
      account,
      device,
    });
    expect(allowed).toBe(true);
    const [only] = await invocations();
    const { script, args } = split(only!.argv);
    expect(args).toEqual([
      `Chrome on macOS (web) wants to use agents on ${computerName()} for Hello as alice@example.com.`,
      "Don't allow",
      "Allow",
    ]);
    expect(script.join("\n")).toContain('with title "Parlor Host"');
    expect(script.join("\n")).toContain("display dialog");
    expect(script.join("\n")).toContain("default button (item 2 of argv)");
  });

  it("allows only on Allow: Don't allow, a dismissed dialog and a failed osascript all refuse", async () => {
    const approve = () =>
      macDialogPrompter().approveDevice({ appName: "Hello", account, device });
    vi.stubEnv("OSASCRIPT_REPLY", "Don't allow");
    expect(await approve()).toBe(false);
    vi.stubEnv("OSASCRIPT_REPLY", "");
    vi.stubEnv("OSASCRIPT_FAIL", "1");
    expect(await approve()).toBe(false);
  });

  it("hands the dialog what the app and the backend said as arguments, never as script, without control characters", async () => {
    vi.stubEnv("OSASCRIPT_REPLY", "Allow");
    await macDialogPrompter().approveDevice({
      appName: 'Hello" & (do shell script "touch /tmp/pwn") & "',
      account: { ...account, email: "alice\u001b[31m@example.com\n\r" },
      device: { name: 'Mac"\\', platform: "web" },
    });
    const { script, args } = split((await invocations())[0]!.argv);
    expect(script.join("\n")).not.toContain("touch");
    expect(script.join("\n")).not.toContain("Mac");
    expect(args[0]).toContain('Hello" & (do shell script "touch /tmp/pwn") & "');
    expect([...args[0]!].some((char) => char.charCodeAt(0) < 0x20)).toBe(false);
  });

  it("keeps an argument that looks like an option an argument", async () => {
    vi.stubEnv("OSASCRIPT_REPLY", "Allow");
    await macDialogPrompter().approveDevice({
      appName: "Hello",
      account,
      device: { name: "-e", platform: "web" },
    });
    const { argv } = (await invocations())[0]!;
    expect(argv.indexOf("--")).toBeLessThan(
      argv.findIndex((arg) => arg.startsWith("-e (")),
    );
  });

  it("closes the dialog when the turn waiting on it ends", async () => {
    vi.stubEnv("OSASCRIPT_HANG", "1");
    const controller = new AbortController();
    const waiting = macDialogPrompter().approveDevice({
      appName: "Hello",
      account,
      device,
      signal: controller.signal,
    });
    await vi.waitFor(async () => expect(await invocations()).toHaveLength(1));
    const { pid } = (await invocations())[0]!;
    controller.abort();
    expect(await waiting).toBe(false);
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow();
    });
  });

  it("shows an ask's question and its choice labels as buttons, and answers with the choice's id", async () => {
    vi.stubEnv("OSASCRIPT_REPLY", "Reject");
    const answer = await macDialogPrompter().answerHere({
      appName: "Hello",
      agent: "Claude Code",
      question: "Run `date`?",
      choices: [
        { id: "allow", label: "Allow" },
        { id: "reject", label: "Reject" },
      ],
    });
    expect(answer).toBe("reject");
    const { script, args } = split((await invocations())[0]!.argv);
    expect(args).toEqual(["Claude Code for Hello asks: Run `date`?", "Allow", "Reject"]);
    expect(script.join("\n")).toContain("buttons (rest of argv)");
  });

  it("offers more than three choices in a list, and answers undefined when it is dismissed", async () => {
    const choices = ["a", "b", "c", "d"].map((id) => ({ id, label: id.toUpperCase() }));
    vi.stubEnv("OSASCRIPT_REPLY", "C");
    const prompter = macDialogPrompter();
    const input = { appName: "Hello", agent: "Codex", question: "Which?", choices };
    expect(await prompter.answerHere(input)).toBe("c");
    const { script, args } = split((await invocations())[0]!.argv);
    expect(script.join("\n")).toContain("choose from list");
    expect(args.slice(1)).toEqual(["A", "B", "C", "D"]);
    vi.stubEnv("OSASCRIPT_REPLY", "false");
    expect(await prompter.answerHere(input)).toBeUndefined();
    vi.stubEnv("OSASCRIPT_FAIL", "1");
    expect(await prompter.answerHere(input)).toBeUndefined();
  });

  it("keeps a very long question to what a dialog can show", async () => {
    vi.stubEnv("OSASCRIPT_REPLY", "Allow");
    await macDialogPrompter().answerHere({
      appName: "Hello",
      agent: "Claude Code",
      question: "x".repeat(5_000),
      choices: [{ id: "allow", label: "Allow" }],
    });
    expect(split((await invocations())[0]!.argv).args[0]!.length).toBeLessThan(800);
  });
});
