import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PROMPTER = fileURLToPath(new URL("./prompter.ts", import.meta.url));

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
