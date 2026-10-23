import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { macDialogPrompter } from "./prompter.js";

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
  const allow = [{ id: "allow", label: "Allow" }];

  it("hands the dialog what the app and the agent said as arguments, never as script, without control characters", async () => {
    vi.stubEnv("OSASCRIPT_REPLY", "Allow");
    await macDialogPrompter().answerHere({
      appName: 'Hello" & (do shell script "touch /tmp/pwn") & "',
      agent: 'Claude"\\',
      question: "Run it?\u001b[31m\r",
      choices: allow,
    });
    const { script, args } = split((await invocations())[0]!.argv);
    expect(script.join("\n")).not.toContain("touch");
    expect(script.join("\n")).not.toContain("Claude");
    expect(args[0]).toContain('Hello" & (do shell script "touch /tmp/pwn") & "');
    expect([...args[0]!].some((char) => char.charCodeAt(0) < 0x20)).toBe(false);
  });

  it("keeps an argument that looks like an option an argument", async () => {
    vi.stubEnv("OSASCRIPT_REPLY", "Allow");
    await macDialogPrompter().answerHere({
      appName: "Hello",
      agent: "-e",
      question: "Run it?",
      choices: allow,
    });
    const { argv } = (await invocations())[0]!;
    expect(argv.indexOf("--")).toBeLessThan(
      argv.findIndex((arg) => arg.startsWith("-e for Hello")),
    );
  });

  it("closes the dialog when the turn waiting on it ends", async () => {
    vi.stubEnv("OSASCRIPT_HANG", "1");
    const controller = new AbortController();
    const waiting = macDialogPrompter().answerHere({
      appName: "Hello",
      agent: "Claude Code",
      question: "Run it?",
      choices: allow,
      signal: controller.signal,
    });
    await vi.waitFor(async () => expect(await invocations()).toHaveLength(1));
    const { pid } = (await invocations())[0]!;
    controller.abort();
    expect(await waiting).toBeUndefined();
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
