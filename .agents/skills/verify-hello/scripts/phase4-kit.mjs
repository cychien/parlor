// Shared code of the phase 4 check scripts (`<id>.check.mjs` in the verification directory).
// A script finds this file from its working directory: <repo>/.claude/skills/verify-hello/scripts.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  agentLoginStatus,
  HOMES_ROOT,
  hostBin,
  hostEnv,
  prepareHome,
  removeHome,
} from "./agent-home.mjs";

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export const ROOT = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
  cwd: dirname(fileURLToPath(import.meta.url)),
}).stdout.trim();
export const HELLO = join(
  ROOT,
  ".claude",
  "skills",
  "verify-hello",
  "scripts",
  "hello.mjs",
);
export const REAL_HOME = homedir();

export const AGENTS = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
];

export const FAKE_AGENT = { id: "fake", name: "Fake agent" };

/** P4_AGENTS=claude narrows a debugging run; the gate runs with none and gets both. */
export function selectedAgents() {
  const only = (process.env.P4_AGENTS ?? "").split(",").filter(Boolean);
  return only.length ? AGENTS.filter((agent) => only.includes(agent.id)) : AGENTS;
}

export class Inconclusive extends Error {}

export function verifyDir() {
  if (process.env.VERIFY_DIR) return resolve(process.env.VERIFY_DIR);
  const out = spawnSync(process.execPath, [HELLO, "evidence"], { encoding: "utf8" });
  return out.stdout.trim();
}

export function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

export function runAsync(command, args, { timeout = 120_000, env, cwd, input } = {}) {
  return new Promise((settle) => {
    const child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      settle({ status: -1, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      settle({ status, stdout, stderr, timedOut });
    });
    child.stdin.end(input ?? "");
  });
}

export function percentile(values, p) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*${BEL}|\\r`, "g");

export function stripAnsi(text) {
  return text.replace(ANSI, "");
}

export function readJsonLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export class Check {
  constructor(id) {
    this.id = id;
    this.root = verifyDir();
    this.dir = join(this.root, id);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.results = [];
    this.cleanups = [];
    this.origins = new Set();
    this.readyPrinted = false;
    this.startedAt = Date.now();
    this.launchctlBefore = launchctlLabels();
  }

  log(message) {
    const line = `[${((Date.now() - this.startedAt) / 1000).toFixed(1)}s] ${message}`;
    process.stderr.write(`${line}\n`);
    appendFileSync(join(this.dir, `${this.id}.run.log`), `${line}\n`);
  }

  save(name, content) {
    const file = join(this.dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
    return file;
  }

  /** The instance is up: every predicate deadline starts after this line. */
  ready() {
    if (this.readyPrinted) return;
    this.readyPrinted = true;
    process.stdout.write("verify: ready\n");
  }

  expect(name, ok, observed) {
    this.results.push({ name, ok: Boolean(ok), observed });
    this.log(
      `${ok ? "ok    " : "NOT OK"} ${name}${observed === undefined ? "" : `: ${JSON.stringify(observed)}`}`,
    );
    return Boolean(ok);
  }

  onCleanup(fn) {
    this.cleanups.push(fn);
  }

  mark() {
    return this.cleanups.length;
  }

  /** Runs, newest first, the cleanups registered since `mark`, so one agent's instance is gone before the next starts. */
  async unwind(mark) {
    while (this.cleanups.length > mark) {
      const fn = this.cleanups.pop();
      try {
        await fn();
      } catch (error) {
        this.log(`cleanup error: ${error?.message ?? error}`);
      }
    }
    for (const origin of this.origins) deleteKeychainItem(origin);
  }

  async cleanup() {
    await this.unwind(0);
    for (const origin of this.origins) deleteKeychainItem(origin);
    const added = launchctlLabels().filter(
      (label) => !this.launchctlBefore.includes(label),
    );
    if (added.length > 0) {
      this.log(`launchd jobs this check left behind: ${added.join(", ")}`);
      for (const label of added) runSync("launchctl", ["remove", label]);
    }
  }

  async run(main) {
    let inconclusive;
    const stop = async (signal) => {
      this.log(`got ${signal}, cleaning up`);
      await this.cleanup();
      process.exit(130);
    };
    process.on("SIGTERM", () => void stop("SIGTERM"));
    process.on("SIGINT", () => void stop("SIGINT"));
    try {
      await main(this);
    } catch (error) {
      if (error instanceof Inconclusive) inconclusive = error.message;
      else
        this.expect(
          `script ran to the end without an error`,
          false,
          String(error?.stack ?? error),
        );
    } finally {
      await this.cleanup();
    }
    const failed = this.results.filter((result) => !result.ok);
    const verdict = inconclusive ? "INCONCLUSIVE" : failed.length === 0 ? "PASS" : "FAIL";
    this.save("result.json", {
      id: this.id,
      verdict,
      inconclusive,
      seconds: (Date.now() - this.startedAt) / 1000,
      results: this.results,
    });
    if (verdict === "PASS") {
      process.stdout.write(`PASS ${this.id}: ${this.results.length} assertions\n`);
      process.exit(0);
    }
    if (inconclusive) {
      process.stdout.write(`FAIL ${this.id}: INCONCLUSIVE, ${inconclusive}\n`);
      process.exit(2);
    }
    for (const result of failed) {
      process.stdout.write(
        `  not ok: ${result.name} ${JSON.stringify(result.observed ?? null)}\n`,
      );
    }
    process.stdout.write(
      `FAIL ${this.id}: ${failed.length} of ${this.results.length} assertions failed\n`,
    );
    process.exit(1);
  }
}

function launchctlLabels() {
  const out = runSync("launchctl", ["list"]);
  return out.stdout
    .split("\n")
    .map((line) => line.split(/\s+/).pop() ?? "")
    .filter((label) => /parlor/i.test(label));
}

export function deleteKeychainItem(origin) {
  return runSync("security", [
    "delete-generic-password",
    "-s",
    "dev.parlor.host",
    "-a",
    origin,
  ]);
}

export function keychainItemExists(origin) {
  return (
    runSync("security", ["find-generic-password", "-s", "dev.parlor.host", "-a", origin])
      .status === 0
  );
}

export function keychainSecret(origin) {
  const out = runSync(
    "security",
    ["find-generic-password", "-s", "dev.parlor.host", "-a", origin, "-w"],
    {
      timeout: 15_000,
    },
  );
  return out.status === 0 ? out.stdout.trim() : undefined;
}

export function scutilName() {
  return runSync("scutil", ["--get", "ComputerName"]).stdout.trim();
}

export function lanIp() {
  return runSync("ipconfig", ["getifaddr", "en0"]).stdout.trim() || undefined;
}

export function load() {
  const [one] = runSync("sysctl", ["-n", "vm.loadavg"])
    .stdout.replace(/[{}]/g, "")
    .trim()
    .split(/\s+/);
  return {
    load1: Number(one),
    cores: Number(runSync("sysctl", ["-n", "hw.ncpu"]).stdout),
  };
}

/** An isolated HOME with a short path: the control socket path must stay under the 104 byte limit. */
export function makeHome(check, tag = check.id) {
  const home = join(HOMES_ROOT, `${tag}-${randomBytes(2).toString("hex")}`);
  mkdirSync(home, { recursive: true });
  const prepared = prepareHome(home);
  check.onCleanup(() => removeHome(home));
  return { home, prepared };
}

export { removeHome };

export function requireLogins(check, home, agentIds) {
  const status = agentLoginStatus(home);
  check.save("agent-login-status.json", {
    claude: { loggedIn: status.claude.loggedIn },
    codex: { loggedIn: status.codex.loggedIn },
  });
  for (const id of agentIds) {
    if (!status[id]?.loggedIn) {
      throw new Inconclusive(
        `${id} is not logged in under the isolated HOME ${home}: ${status[id]?.detail}`,
      );
    }
  }
}

/** Every process whose environment holds HOME={home}: the host, its agents and their children. */
export function processesWithHome(home) {
  const out = runSync("ps", ["-axww", "-E", "-o", "pid=,ppid=,pgid=,command="], {
    env: { ...process.env, COLUMNS: "100000" },
  });
  const marker = new RegExp(
    `(^|\\s)HOME=${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`,
  );
  return out.stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m) => m && Number(m[1]) !== process.pid && marker.test(m[4]))
    .map((m) => ({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      line: m[4],
    }));
}

export function pidsListening(path) {
  const out = runSync("lsof", ["-t", path]);
  return out.stdout.split("\n").filter(Boolean).map(Number);
}

export async function killHome(check, home) {
  const own = new Set([process.pid, process.ppid]);
  for (let attempt = 0; attempt < 3; attempt++) {
    const live = processesWithHome(home).filter((p) => !own.has(p.pid));
    if (live.length === 0) return;
    const signal = attempt === 0 ? "SIGTERM" : "SIGKILL";
    for (const p of live) {
      for (const target of [-p.pgid, p.pid]) {
        try {
          process.kill(target, signal);
        } catch {
          /* gone */
        }
      }
    }
    await sleep(attempt === 0 ? 3000 : 1000);
  }
  const survivors = processesWithHome(home);
  if (survivors.length)
    check.log(`survivors under ${home}: ${survivors.map((p) => p.pid).join(", ")}`);
}

const PTY_HELPER = `
import os, pty, sys, select, struct, fcntl, termios, time
argv = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 250, 0, 0))
    os.execvp(argv[0], argv)
out = sys.stdout.buffer
stdin_fd = sys.stdin.fileno()
stdin_open = True
exited = None
quiet_since = None
while True:
    watch = [fd] + ([stdin_fd] if stdin_open else [])
    ready, _, _ = select.select(watch, [], [], 0.05)
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            break
        out.write(data)
        out.flush()
        quiet_since = None
    if stdin_open and stdin_fd in ready:
        data = os.read(stdin_fd, 65536)
        if not data:
            stdin_open = False
        else:
            os.write(fd, data)
    if exited is None:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            exited = os.waitstatus_to_exitcode(status)
    if exited is not None:
        if quiet_since is None:
            quiet_since = time.time()
        elif time.time() - quiet_since > 0.4 and fd not in ready:
            break
if exited is None:
    _, status = os.waitpid(pid, 0)
    exited = os.waitstatus_to_exitcode(status)
out.write(("\\n[pty exit %d]\\n" % exited).encode())
out.flush()
`;

/** A command on a pseudo terminal, the way a user's terminal runs it. */
export class Terminal {
  constructor(check, name, command, args, { env, cwd } = {}) {
    this.check = check;
    this.name = name;
    this.events = [];
    this.raw = "";
    this.command = [command, ...args];
    this.child = spawn("python3", ["-u", "-c", PTY_HELPER, command, ...args], {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exitCode = undefined;
    this.exited = new Promise((done) => {
      this.child.on("close", (status) => {
        this.closeStatus = status;
        done();
      });
    });
    this.child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.raw += text;
      this.events.push({ at: Date.now(), type: "output", text });
      const exit = this.raw.match(/\[pty exit (-?\d+)\]/);
      if (exit) this.exitCode = Number(exit[1]);
    });
    this.child.stderr.on("data", (chunk) => {
      this.events.push({
        at: Date.now(),
        type: "helper-stderr",
        text: chunk.toString("utf8"),
      });
    });
    check.onCleanup(() => this.kill());
  }

  get text() {
    return stripAnsi(this.raw);
  }

  send(text) {
    const at = Date.now();
    this.events.push({ at, type: "input", text });
    this.child.stdin.write(text);
    return at;
  }

  async waitFor(pattern, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const match = this.text.match(pattern);
      if (match) return match;
      if (this.exitCode !== undefined) break;
      await sleep(50);
    }
    return this.text.match(pattern) ?? undefined;
  }

  async waitExit(ms) {
    await Promise.race([this.exited, sleep(ms)]);
    return this.exitCode;
  }

  kill() {
    try {
      this.child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }

  save(prefix = this.name) {
    this.check.save(`${prefix}.terminal.txt`, this.text);
    this.check.save(`${prefix}.terminal.events.json`, this.events);
  }
}

/** The page-side helpers every script shares; `Browser.page` hands them to a function. */
export const PAGE_LIB = `() => {
  const sidebar = () => document.querySelector('section.agent-sidebar');
  const nameOf = (el) => el.getAttribute('aria-label') ?? (el.labels && el.labels[0] ? el.labels[0].textContent.trim() : '');
  const agentSelect = () => [...(sidebar()?.querySelectorAll('select,[role=combobox]') ?? [])].find((el) => nameOf(el) === 'Agent');
  const agents = () => { const s = agentSelect(); return s && s.options ? [...s.options].map((o) => ({ text: o.textContent.trim(), value: o.value, selected: o.selected, disabled: o.disabled })) : []; };
  const sidebarOpen = () => { const s = sidebar(); return !!s && !s.hidden && s.getClientRects().length > 0; };
  const openButton = () => [...document.querySelectorAll('button')].find((b) => /^Agent(,.*)?$/.test((b.getAttribute('aria-label') ?? b.textContent).trim()) && !(sidebar() && sidebar().contains(b)));
  const ensureSidebar = () => { if (!sidebarOpen()) openButton()?.click(); return sidebarOpen(); };
  const log = () => document.querySelector('ol[role=log]');
  const textOf = (el) => (el ? el.textContent.trim() : '');
  const ask = (li) => {
    const group = li.querySelector('[role=group]');
    return {
      question: group ? (group.getAttribute('aria-label') ?? textOf(group)) : textOf(li),
      state: (group && group.dataset.state) ?? li.dataset.state ?? null,
      approval: (group && group.dataset.approval) ?? li.dataset.approval ?? null,
      choices: [...li.querySelectorAll('button')].map((b) => ({ text: textOf(b), effect: b.dataset.effect ?? null, disabled: b.disabled, pressed: b.getAttribute('aria-pressed'), chosen: b.dataset.chosen ?? null })),
    };
  };
  const items = () => [...(log()?.querySelectorAll(':scope > li') ?? [])].map((li) => ({
    id: li.dataset.itemId ?? null,
    kind: li.dataset.kind ?? null,
    streaming: li.dataset.streaming ?? null,
    interrupted: li.dataset.interrupted ?? null,
    text: textOf(li.querySelector('.reply,.prompt,.tool-title,p.event') ?? li),
    toolStatus: li.querySelector('.tool')?.dataset.status ?? null,
    toolTitle: textOf(li.querySelector('.tool-title')),
    ask: li.dataset.kind === 'ask' ? ask(li) : null,
    buttons: li.dataset.kind === 'confirm' ? [...li.querySelectorAll('button')].map((b) => textOf(b)) : null,
  }));
  const stopVisible = () => !!sidebar() && [...sidebar().querySelectorAll('button')].some((b) => (b.getAttribute('aria-label') ?? b.textContent).trim() === 'Stop');
  const tasks = () => [...document.querySelectorAll('[data-testid=tasks] li')].map((li) => {
    const box = li.querySelector('input[type=checkbox]');
    return { title: box ? (box.getAttribute('aria-label') ?? textOf(li)) : textOf(li), done: box ? box.checked : null };
  });
  const clickWhere = (scope, predicate) => {
    const button = [...scope.querySelectorAll('button')].find(predicate);
    if (!button) return false;
    button.click();
    return true;
  };
  return { sidebar, agentSelect, agents, sidebarOpen, openButton, ensureSidebar, log, items, stopVisible, tasks, clickWhere, textOf, nameOf };
}`;

export function parseEval(stdout) {
  const line = stdout.split("\n").find((l) => l.startsWith("result: "));
  if (line === undefined) throw new Error(`no eval result in:\n${stdout}`);
  const literal = line.slice("result: ".length).trim();
  if (literal === "undefined") return undefined;
  const once = JSON.parse(literal);
  if (typeof once !== "string") return once;
  try {
    return JSON.parse(once);
  } catch {
    return once;
  }
}

export class Browser {
  /** `profile` "bob" is a second Chrome with its own cookie jar. */
  constructor(check, info, { profile } = {}) {
    this.check = check;
    this.info = info;
    this.profile = profile;
  }

  async cli(args, { timeout = 90_000 } = {}) {
    const env = { ...process.env };
    delete env.HELLO_BROWSER_PROFILE;
    if (this.profile) env.HELLO_BROWSER_PROFILE = this.profile;
    const result = await runAsync(
      process.execPath,
      [HELLO, "browser", this.info.id, ...args],
      { env, timeout },
    );
    if (result.status !== 0) {
      throw new Error(
        `browser ${args.slice(0, 3).join(" ")} exited ${result.status}\n${result.stderr}${result.stdout}`,
      );
    }
    return result.stdout;
  }

  async eval(fn) {
    return parseEval(await this.cli(["eval", fn]));
  }

  /** Runs `body` (a function of the page helpers) in the page; async bodies are awaited. */
  page(body) {
    return this.eval(
      `async () => { const L = (${PAGE_LIB})(); return await (${body})(L); }`,
    );
  }

  open(path = "/") {
    return this.cli(["open", path]);
  }

  click(role, name) {
    return this.cli(["click", role, name]);
  }

  fill(role, name, text) {
    return this.cli(["fill", role, name, text]);
  }

  async snapshot(name) {
    const out = await this.cli(["snapshot"]);
    if (name) this.check.save(name, out);
    return out;
  }

  async screenshot(name) {
    const file = join(this.check.dir, name);
    await this.cli(["screenshot", file]);
    return file;
  }

  async pages() {
    const out = await this.cli(["pages"]);
    return [...out.matchAll(/^\s+(\d+),(.*),(true|false)$/gm)].map((m) => ({
      id: Number(m[1]),
      url: m[2],
      selected: m[3] === "true",
    }));
  }

  async newpage(url) {
    await this.cli(["newpage", url]);
    const selected = (await this.pages()).find((p) => p.selected);
    return selected?.id;
  }

  selectpage(id) {
    return this.cli(["selectpage", String(id)]);
  }

  closepage(id) {
    return this.cli(["closepage", String(id)]);
  }

  async signin(user) {
    return this.cli(["signin", user]);
  }

  async selectAgent(text) {
    await this.cli(["fill", "combobox", "Agent", text]);
    const selected = await this.page(
      `(L) => L.agents().filter((o) => o.selected).map((o) => o.text)`,
    );
    if (!selected.includes(text)) {
      await this.page(`(L) => {
        const select = L.agentSelect();
        const option = [...select.options].find((o) => o.textContent.trim() === ${JSON.stringify(text)});
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(select, option.value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }`);
    }
    return this.page(`(L) => L.agents().filter((o) => o.selected).map((o) => o.text)`);
  }

  /** Starts a new chat when the sidebar shows a thread; resolves once the log is empty. */
  async newChat() {
    const clicked = await this.page(
      `(L) => L.clickWhere(L.sidebar(), (b) => b.textContent.trim() === 'New chat' && !b.disabled)`,
    );
    if (!clicked) return false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if ((await this.page(`(L) => L.items().length`)) === 0) return true;
      await sleep(200);
    }
    throw new Error("the log still shows the old thread 10 s after New chat");
  }

  async send(text) {
    await this.fill("textbox", "Message", text);
    await this.click("button", "Send");
    return Date.now();
  }

  /** Polls the thread until it holds `prompts` prompts and no turn runs, for two polls in a row. */
  async waitSettled({ prompts, ms, label = "turn", onPoll }) {
    const deadline = Date.now() + ms;
    let stable = 0;
    let last;
    while (Date.now() < deadline) {
      last = await this.page(`(L) => ({ items: L.items(), stop: L.stopVisible() })`);
      if (onPoll) await onPoll(last);
      const promptCount = last.items.filter((i) => i.kind === "prompt").length;
      const rest = last.items.filter((i) => i.kind !== "prompt");
      const streaming = last.items.some((i) => i.streaming === "true");
      const open = last.items.some((i) => i.kind === "ask" && i.ask?.state === "open");
      const settled =
        promptCount >= prompts && rest.length > 0 && !last.stop && !streaming && !open;
      stable = settled ? stable + 1 : 0;
      if (stable >= 2) return { settled: true, last };
      await sleep(700);
    }
    this.check.log(`${label} not settled after ${ms} ms`);
    return { settled: false, last };
  }
}

/** The sidebar and app of an instance, signed in as Alice, with the sidebar open. */
export async function openAliceSidebar(check, browser, { signedIn = true } = {}) {
  if (!signedIn) await browser.signin("alice");
  await browser.cli(["emulate", "--viewport", "1280x720x1"]);
  await browser.open("/");
  for (let attempt = 0; attempt < 2; attempt++) {
    await browser.page(
      `(L) => { if (!L.sidebarOpen()) L.openButton()?.click(); return true; }`,
    );
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (await browser.page(`(L) => L.sidebarOpen()`)) return true;
      await sleep(300);
    }
  }
  return false;
}

export async function upInstance(
  check,
  { name, seed, noAuth, home, source, serverless } = {},
) {
  const args = [HELLO, "up"];
  if (seed) args.push("--seed", seed);
  if (source) args.push("--source", source);
  if (noAuth) args.push("--no-auth");
  if (home) args.push("--home", home);
  if (serverless) args.push("--serverless");
  const { load1, cores } = load();
  check.log(`load ${load1} on ${cores} cores before starting ${name ?? "an instance"}`);
  const result = await runAsync(process.execPath, args.slice(0), { timeout: 360_000 });
  check.save(`${name ?? "instance"}.up.log`, result.stderr);
  if (result.status !== 0) {
    if (/refusing to start/.test(result.stderr)) {
      throw new Inconclusive(
        `hello up refused to start: ${result.stderr.split("\n").find((l) => l.includes("refusing")) ?? result.stderr.slice(-500)}`,
      );
    }
    throw new Error(`hello up failed (${result.status})\n${result.stderr.slice(-2000)}`);
  }
  const info = JSON.parse(result.stdout);
  check.origins.add(info.urls.web);
  check.origins.add(`${info.urls.web}/`);
  check.onCleanup(async () => {
    const down = await runAsync(
      process.execPath,
      [
        HELLO,
        "down",
        info.id,
        "--save-log",
        join(check.dir, `${name ?? info.id}.dev.log`),
      ],
      { timeout: 120_000 },
    );
    if (down.status !== 0)
      check.log(`down ${info.id} failed: ${down.stderr.slice(-500)}`);
  });
  return info;
}

export function helloCli(args, { timeout = 180_000, env } = {}) {
  return runAsync(process.execPath, [HELLO, ...args], { timeout, env });
}

/**
 * One `netcut`: resolves at the restore with `{side, cutAt, restoredAt}` and, from the command's
 * stderr, `openAtCut`, `heldNew` and `closedDuringCut` (lists of `conn` ids, see `requestLog`).
 */
export async function netcut(info, side, seconds) {
  const result = await helloCli(["netcut", info.id, side, "--seconds", String(seconds)], {
    timeout: (seconds + 60) * 1000,
  });
  if (result.status !== 0) throw new Error(`netcut failed: ${result.stderr.slice(-800)}`);
  const detail = result.stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .at(-1);
  return { ...detail, ...JSON.parse(result.stdout) };
}

/** Every request the instance's forwarder logged so far, with `respondedAt` and `conn`, in log order. */
export function requestLog(info) {
  return readJsonLines(info.requestLog);
}

export async function sqlRows(check, info, query) {
  const result = await helloCli(["sql", info.id, query], { timeout: 240_000 });
  if (result.status !== 0) throw new Error(`sql failed: ${result.stderr.slice(-800)}`);
  return JSON.parse(result.stdout);
}

export async function token(info, kind = "session", user = "alice") {
  const result = await helloCli(["token", info.id, "--as", user, "--kind", kind]);
  if (result.status !== 0) throw new Error(`token failed: ${result.stderr}`);
  return result.stdout.trim();
}

export async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

/** The isolated user's computer: the unpublished host CLI of an instance snapshot, run as `parlor-host`. */
export class MacHost {
  /** `binInfo`: run the CLI from another instance's snapshot, so two apps share one daemon release. */
  constructor(check, { home, info, extraEnv = {}, binInfo = info }) {
    this.check = check;
    this.home = home;
    this.info = info;
    this.binInfo = binInfo;
    this.bin = hostBin(resolve(binInfo.appDir, "..", ".."));
    this.extraEnv = extraEnv;
    this.hostRoot = join(home, ".parlor", "host");
    this.controlSocket = join(this.hostRoot, "run", "control.sock");
    this.proxySocket = join(this.hostRoot, "run", "proxy.sock");
    this.logFile = join(this.hostRoot, "logs", "daemon.log");
    this.grantsFile = join(this.hostRoot, "grants.json");
    this.openedUrls = join(home, "opened-urls.log");
    check.onCleanup(() => this.stop());
  }

  get cwd() {
    return resolve(this.binInfo.appDir, "..", "..");
  }

  env() {
    return {
      ...hostEnv(this.home),
      TERM: "xterm-256color",
      NO_COLOR: "1",
      ...this.extraEnv,
    };
  }

  terminal(name, args) {
    return new Terminal(this.check, name, process.execPath, [this.bin, ...args], {
      env: this.env(),
      cwd: this.cwd,
    });
  }

  cli(args, { timeout = 60_000 } = {}) {
    return runAsync(process.execPath, [this.bin, ...args], {
      env: this.env(),
      cwd: this.cwd,
      timeout,
    });
  }

  async status() {
    const result = await this.cli(["status", "--json"]);
    try {
      return {
        ...JSON.parse(result.stdout.trim().split("\n").pop()),
        exit: result.status,
      };
    } catch {
      return {
        error: `${result.stdout}${result.stderr}`.slice(0, 500),
        exit: result.status,
      };
    }
  }

  daemonPids() {
    return existsSync(this.controlSocket) ? pidsListening(this.controlSocket) : [];
  }

  logEvents() {
    return readJsonLines(this.logFile);
  }

  grants() {
    try {
      return JSON.parse(readFileSync(this.grantsFile, "utf8"));
    } catch {
      return undefined;
    }
  }

  async stop() {
    await killHome(this.check, this.home);
  }
}

/** The executable and arguments of a `ps -E` line, before the environment starts. */
export function commandOf(line) {
  const tokens = line.split(" ");
  const end = tokens.findIndex(
    (part, index) => index > 0 && /^[A-Z_][A-Z0-9_]*=/.test(part),
  );
  return (end === -1 ? tokens : tokens.slice(0, end)).join(" ");
}

/** One daemon's listing of agent processes: everything with this HOME except the daemon itself. */
export function agentProcesses(host) {
  const daemons = new Set(host.daemonPids());
  return processesWithHome(host.home).filter((p) => !daemons.has(p.pid));
}

/** The newest consent URL for this app: the open shim's log is shared by every app a home connects. */
export function readConsentUrl(host, terminal) {
  const fromShim = existsSync(host.openedUrls)
    ? readFileSync(host.openedUrls, "utf8")
    : "";
  const pattern = /https?:\/\/[^\s"'<>]+\/_parlor\/auth\/hosts\/authorize[^\s"'<>]*/g;
  const web = host.info.urls.web;
  const mine = (url) => url.startsWith(`${web}/_parlor/auth/hosts/authorize`);
  const found = [
    ...(fromShim.match(pattern) ?? []),
    ...(terminal.text.match(pattern) ?? []),
  ].filter(mine);
  return found.at(-1);
}

export const CONNECTED_PATTERN = /Connected to (.+?) as (\S+?)\. /;

/**
 * Alice connects the host to the instance the way a user does: run the command the sidebar
 * names and click `Connect` on the consent page, the one approval; the tab returns to the app,
 * whose browser the host then trusts unasked. `appTab` is the page id of Alice's app tab,
 * which stays selected on return.
 */
export async function connectHost(check, { host, browser, appTab, label = "connect" }) {
  const info = host.info;
  const web = info.urls.web;
  const actions = { computer: 0, browser: 0 };
  const note = await browser.page(`(L) => {
    const note = document.querySelector('[data-state="no-agents"]');
    const command = document.querySelector('[data-testid="connect-command"]');
    return { note: !!note, command: command ? command.textContent.trim() : null, noteText: note ? note.textContent.trim() : null };
  }`);
  check.save(`${label}.sidebar-before.json`, note);
  await browser.screenshot(`${label}.sidebar-before.png`);
  await browser.snapshot(`${label}.sidebar-before.aria.txt`);
  const expectedCommand = `npx @parlor/agent-host connect ${web}`;
  check.expect(
    `${label}: the sidebar names the command ${expectedCommand}`,
    note.command === expectedCommand,
    note.command,
  );
  const args = (note.command ?? expectedCommand)
    .replace(/^npx @parlor\/agent-host /, "")
    .split(/\s+/);

  const terminal = host.terminal(label, args);
  actions.computer += 1;
  const startedAt = Date.now();
  const deadline = startedAt + 60_000;
  let url;
  while (!url && Date.now() < deadline) {
    url = readConsentUrl(host, terminal);
    if (!url) await sleep(200);
  }
  if (!url) {
    terminal.save();
    throw new Error(
      `no consent URL after 60 s; terminal:\n${terminal.text.slice(-1500)}`,
    );
  }
  check.log(`consent URL ${url} after ${Date.now() - startedAt} ms`);

  const consentTab = await browser.newpage(url);
  await browser.page(
    `async () => { for (let i = 0; i < 40 && !document.querySelector('form button[value="connect"]'); i++) await new Promise((r) => setTimeout(r, 250)); return true; }`,
  );
  const consent = await browser.page(`(L) => ({
    heading: (document.querySelector('h1,h2') ?? {}).textContent ?? null,
    text: document.body.innerText.slice(0, 600),
  })`);
  await browser.snapshot(`${label}.consent.aria.txt`);
  await browser.screenshot(`${label}.consent.png`);
  check.save(`${label}.consent.json`, consent);
  const clickedAt = Date.now();
  await browser.click("button", "Connect");
  actions.browser += 1;

  const connected = await terminal.waitFor(CONNECTED_PATTERN, 60_000);
  if (!connected) {
    terminal.save();
    throw new Error(
      `the terminal never said it connected; terminal:\n${terminal.text.slice(-1500)}`,
    );
  }
  const shown = { appName: connected[1], email: connected[2] };
  check.save(`${label}.terminal-connected.json`, shown);
  const tab = await browser.page(
    `async () => { for (let i = 0; i < 40 && !(location.origin === ${JSON.stringify(web)} && !location.hash); i++) await new Promise((r) => setTimeout(r, 250)); return { url: location.href, hash: location.hash }; }`,
  );
  check.save(`${label}.tab-after.json`, tab);
  check.expect(
    `${label}: the tab returns to the app with the pairing secret already off its URL`,
    typeof tab?.url === "string" && tab.url.startsWith(web) && !tab.hash,
    tab,
  );

  await browser.closepage(consentTab);
  await browser.selectpage(appTab);
  const exitCode = await terminal.waitExit(60_000);
  terminal.save();
  return { terminal, shown, consent, tab, actions, clickedAt, exitCode, url };
}

/**
 * An instance with Better Auth on, Alice signed in with her sidebar open, and a host that
 * is not yet connected; prints `verify: ready` once the page is usable. `source` drives
 * another checkout; `beforeSignin(browser, info)` runs once the browser is up, before sign-in;
 * `announce: false` leaves `verify: ready` to a script that stands up more than one instance.
 */
export async function standUp(
  check,
  {
    tag,
    agentIds,
    seed = "baseline",
    extraEnv = {},
    home: given,
    binInfo,
    source,
    serverless,
    beforeSignin,
    announce = true,
  },
) {
  const home = given ?? makeHome(check, tag).home;
  if (agentIds.length) requireLogins(check, home, agentIds);
  const info = await upInstance(check, { name: tag, seed, source, serverless });
  const browser = new Browser(check, info);
  if (beforeSignin) {
    await browser.open("/sign-in");
    await beforeSignin(browser, info);
  }
  await browser.signin("alice");
  const open = await openAliceSidebar(check, browser);
  check.expect(`${tag}: Alice's sidebar opens`, open === true, open);
  const appTab = (await browser.pages()).find((page) => page.selected)?.id;
  const host = new MacHost(check, { home, info, extraEnv, binInfo });
  if (announce) check.ready();
  return { home, info, browser, host, appTab };
}

async function runForAgent(check, agent, body) {
  try {
    await body();
  } catch (error) {
    if (error instanceof Inconclusive) {
      check.log(`${agent.name}: inconclusive: ${error.message}`);
      return error;
    }
    check.expect(
      `${agent.name}: the check ran to the end`,
      false,
      String(error?.stack ?? error),
    );
  }
  return undefined;
}

/** Runs `body(agent)` for each selected agent on its own instance; one agent failing does not stop the next. */
export async function forEachAgent(check, body, agents = selectedAgents()) {
  let inconclusive;
  for (const agent of agents) {
    const mark = check.mark();
    try {
      inconclusive = (await runForAgent(check, agent, () => body(agent))) ?? inconclusive;
    } finally {
      await check.unwind(mark);
    }
  }
  if (inconclusive && check.results.every((r) => r.ok)) throw inconclusive;
}

/**
 * One instance and one pairing for every agent: runs `body(agent, session)` for each agent
 * in turn, each in a new chat with that agent picked. The runs share one database, so each
 * must touch its own rows. With `fake` (`{ script, log }`) the fake agent runs alone.
 */
export async function forEachAgentOnOneHost(
  check,
  {
    tag,
    agents = selectedAgents(),
    fake,
    seed,
    extraEnv,
    source,
    serverless,
    beforeSignin,
  },
  body,
) {
  const session = await connectedSession(check, {
    tag,
    agentIds: fake ? [] : agents.map((agent) => agent.id),
    seed,
    extraEnv,
    fake,
    source,
    serverless,
    beforeSignin,
  });
  let inconclusive;
  for (const [index, agent] of (fake ? [session.fake] : agents).entries()) {
    const failed = await runForAgent(check, agent, async () => {
      if (index > 0) await session.browser.newChat();
      const option = agentOption(agent, session.hostName);
      const chosen = await session.browser.selectAgent(option);
      if (
        !check.expect(`${tag}: ${agent.name} is picked`, chosen.includes(option), chosen)
      )
        return;
      await body(agent, session);
    });
    inconclusive = failed ?? inconclusive;
  }
  if (inconclusive && check.results.every((r) => r.ok)) throw inconclusive;
  return session;
}

/** The agent's option text in the picker: `{agent} on {hostName}`. */
export function agentOption(agent, hostName) {
  return `${agent.name} on ${hostName}`;
}

export async function waitForAgents(browser, texts, ms = 20_000) {
  const deadline = Date.now() + ms;
  let listed = [];
  while (Date.now() < deadline) {
    listed = await browser.page(`(L) => L.agents().map((o) => o.text)`);
    if (texts.every((text) => listed.includes(text))) return { ok: true, listed };
    await sleep(300);
  }
  return { ok: false, listed };
}

/** Writes `profiles` into the isolated HOME's `agents.json`, replacing entries with the same id. */
export function writeAgentProfiles(home, profiles) {
  const file = join(home, ".parlor", "host", "agents.json");
  const ids = new Set(profiles.map((profile) => profile.id));
  const kept = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8")).filter((profile) => !ids.has(profile.id))
    : [];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify([...kept, ...profiles], null, 2)}\n`);
  return file;
}

/**
 * Makes the fake ACP agent of `packages/agent-host` one of the host's agents before it
 * connects: writes `script` (a `FakeAgentScript`) to the check dir and its profile to
 * `agents.json`. With `log` (true, or a file name in the check dir) the agent appends one
 * line per ACP message there (`FAKE_AGENT_LOG`). Returns an `AGENTS`-shaped descriptor.
 */
export function addFakeAgent(
  check,
  { home, info, host },
  { script, log, tag = check.id },
) {
  const scriptFile = check.save(`${tag}.fake-script.json`, script);
  const entry = join(
    resolve(info.appDir, "..", ".."),
    "packages",
    "agent-host",
    "bin",
    "fake-agent.mjs",
  );
  const profile = {
    ...FAKE_AGENT,
    launch: { kind: "native", command: process.execPath, args: [entry, scriptFile] },
    binary: process.execPath,
  };
  writeAgentProfiles(home, [profile]);
  const logFile = log
    ? join(check.dir, log === true ? `${tag}.fake-agent.log` : log)
    : undefined;
  const env = logFile ? { FAKE_AGENT_LOG: logFile } : {};
  if (host) host.extraEnv = { ...host.extraEnv, ...env };
  return {
    ...FAKE_AGENT,
    profile,
    scriptFile,
    logFile,
    env,
    messages: () => (logFile ? readJsonLines(logFile) : []),
  };
}

/**
 * Stands up an instance, connects the Mac the way a user does and waits for the picker.
 * `profiles` are user-added agent profiles written to agents.json before the host starts;
 * `fake` (`{ script, log }`) adds the fake agent, returned as `fake`.
 */
export async function connectedSession(
  check,
  {
    tag,
    agentIds,
    extraEnv,
    seed,
    profiles,
    fake,
    source,
    serverless,
    beforeSignin,
    home,
    announce,
  },
) {
  const session = await standUp(check, {
    tag,
    agentIds,
    seed,
    extraEnv,
    source,
    serverless,
    beforeSignin,
    home,
    announce,
  });
  const extra = typeof profiles === "function" ? profiles(session) : profiles;
  if (extra?.length) writeAgentProfiles(session.home, extra);
  const fakeAgent = fake ? addFakeAgent(check, session, { tag, ...fake }) : undefined;
  const connection = await connectHost(check, { ...session, label: `${tag}-connect` });
  const hostName = scutilName();
  const wanted = [...(extra ?? []).map((p) => `${p.name} on ${hostName}`)];
  if (fakeAgent) wanted.push(agentOption(fakeAgent, hostName));
  for (const id of agentIds) {
    const agent = AGENTS.find((a) => a.id === id);
    if (agent) wanted.push(agentOption(agent, hostName));
  }
  const listed = await waitForAgents(session.browser, wanted);
  check.expect(`${tag}: the picker lists ${wanted.join(", ")}`, listed.ok, listed.listed);
  if (!listed.ok)
    throw new Error(
      `${tag}: the picker never listed the agents; terminal:\n${connection.terminal.text.slice(-1200)}`,
    );
  return { ...session, connection, hostName, fake: fakeAgent };
}

export async function cdpCookies(info) {
  const version = await (
    await fetch(`http://127.0.0.1:${info.browserCdpPort}/json/version`)
  ).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((done, abort) => {
    socket.onopen = done;
    socket.onerror = abort;
  });
  const cookies = await new Promise((done, abort) => {
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id === 1) done(message.result?.cookies ?? []);
    };
    socket.onerror = abort;
    socket.send(JSON.stringify({ id: 1, method: "Storage.getCookies" }));
    setTimeout(() => abort(new Error("Storage.getCookies timed out")), 10_000);
  });
  socket.close();
  return cookies;
}

/** A `parlor-host mcp-proxy` child with the given proxy environment; JSON-RPC lines in and out. */
export class ProxyClient {
  constructor(check, host, env) {
    this.pending = new Map();
    this.buffer = "";
    this.lines = [];
    this.child = spawn(process.execPath, [host.bin, "mcp-proxy"], {
      cwd: host.cwd,
      env: { ...host.env(), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk));
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        const at = Date.now();
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          this.lines.push({ at, line });
          continue;
        }
        this.lines.push({ at, message });
        const waiter = this.pending.get(message.id);
        if (waiter) {
          this.pending.delete(message.id);
          waiter({ at, message });
        }
      }
    });
    this.exited = new Promise((done) => this.child.on("close", () => done()));
    check.onCleanup(() => this.child.kill("SIGKILL"));
    this.nextId = 1;
  }

  request(method, params, { timeout = 15_000 } = {}) {
    const id = this.nextId++;
    const sentAt = Date.now();
    const answer = new Promise((done) => {
      this.pending.set(id, done);
      setTimeout(() => {
        if (this.pending.delete(id))
          done({ at: Date.now(), message: undefined, timedOut: true });
      }, timeout);
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return answer.then((result) => ({ ...result, sentAt, id }));
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "verify-p4", version: "1" },
    });
    this.notify("notifications/initialized");
    return result;
  }
}

export function proxyEnvOf(processLine) {
  const socket = processLine.match(/(?:^|\s)PARLOR_HOST_PROXY_SOCKET=(\S+)/)?.[1];
  const nonce = processLine.match(/(?:^|\s)PARLOR_HOST_PROXY_NONCE=(\S+)/)?.[1];
  return socket && nonce
    ? { PARLOR_HOST_PROXY_SOCKET: socket, PARLOR_HOST_PROXY_NONCE: nonce }
    : undefined;
}

export function findProxyProcesses(host) {
  return agentProcesses(host).filter((p) => proxyEnvOf(p.line) !== undefined);
}

export function sha8(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

export function decodeJwtPayload(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function walkFiles(
  root,
  { skip = () => false, maxBytes = 64 * 1024 * 1024 } = {},
) {
  const files = [];
  const visit = (path) => {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return;
    }
    if (skip(path, stat)) return;
    if (stat.isSymbolicLink()) {
      try {
        const real = statSync(path);
        if (real.isFile() && real.size <= maxBytes) files.push(path);
      } catch {
        /* dangling */
      }
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
    } else if (stat.isFile() && stat.size <= maxBytes) {
      files.push(path);
    }
  };
  visit(root);
  return files;
}

export {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  join,
  readlinkSync,
};
