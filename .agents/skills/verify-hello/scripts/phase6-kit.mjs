// Shared code of the phase 6 check scripts (the Mac and iOS shells, the shared Parlor Host
// service and its releases), on top of the phase 5 kit: native instances, the webviews of
// both shells, the app's native pairing dialog, the installed service in an isolated HOME,
// source copies that act as a second app or bundle another host release, and release fixtures.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { HOMES_ROOT } from "./agent-home.mjs";
import {
  Inconclusive,
  PAGE_LIB,
  postJson,
  processesWithHome,
  token,
  REAL_HOME,
  ROOT,
  helloCli,
  load,
  makeHome,
  parseEval,
  readJsonLines,
  runAsync,
  runSync,
  sleep,
  writeAgentProfiles,
} from "./phase4-kit.mjs";
import { nativeTool } from "./webview.mjs";

export * from "./phase5-kit.mjs";

export const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
export const HARNESS_HOME =
  process.env.PARLOR_VERIFY_HOME ?? join(homedir(), ".cache", "parlor-verify-hello");
const TOOLS_DIR = join(HARNESS_HOME, "tools");
export const HELLO_APP_ID = "dev.parlor.hello";
export const SECOND_APP = { id: "dev.parlor.hellotwo", name: "Hello Two" };
export const SESSION_ACCOUNT = "parlor.session";

/** A short, unique instance id; chosen before `up` so a check knows the snapshot path in advance. */
export function instanceId(tag) {
  return `${tag}-${randomBytes(2).toString("hex")}`;
}

export function snapshotRepo(id) {
  return join(HARNESS_HOME, "instances", id, "repo");
}

/** `$H up` for any target; `release`/`noLaunch`/`sharedOrigin`/`home`/`source`/`id` map to the driver flags. */
export async function upNative(
  check,
  {
    name,
    target = "mac",
    seed = "baseline",
    home,
    release,
    noLaunch,
    source,
    id,
    sharedOrigin,
  },
) {
  const args = ["up", "--target", target];
  if (id) args.push("--id", id);
  if (seed) args.push("--seed", seed);
  if (home) args.push("--home", home);
  if (release) args.push("--release");
  if (noLaunch) args.push("--no-launch");
  if (sharedOrigin) args.push("--shared-origin");
  if (source) args.push("--source", source);
  const { load1, cores } = load();
  check.log(`load ${load1} on ${cores} cores before up ${args.slice(1).join(" ")}`);
  const result = await helloCli(args, { timeout: 2_700_000 });
  check.save(`${name}.up.log`, result.stderr);
  if (result.status !== 0) {
    if (/refusing to start/.test(result.stderr))
      throw new Inconclusive(
        `hello up refused to start: ${result.stderr.split("\n").find((l) => l.includes("refusing"))}`,
      );
    throw new Error(
      `hello up ${args.join(" ")} failed (${result.status})\n${result.stderr.slice(-2500)}`,
    );
  }
  const up = JSON.parse(result.stdout);
  for (const origin of [
    up.urls.web,
    `${up.urls.web}/`,
    up.urls.server,
    `${up.urls.server}/`,
  ])
    check.origins.add(origin);
  check.onCleanup(async () => {
    const down = await helloCli(
      ["down", up.id, "--save-log", join(check.dir, `${name}.dev.log`)],
      { timeout: 180_000 },
    );
    if (down.status !== 0) check.log(`down ${up.id} failed: ${down.stderr.slice(-600)}`);
  });
  check.log(
    `${name}: ${up.id} up (${target}${release ? ", release" : ""}) at ${up.urls.web}`,
  );
  return up;
}

export async function instanceInfo(id) {
  const result = await helloCli(["info", id]);
  return JSON.parse(result.stdout);
}

/** A mac or iOS app's webview, driven through `$H webview` and `$H screenshot`. */
export class Webview {
  constructor(check, instance) {
    this.check = check;
    this.info = instance;
    this.id = instance.id;
  }

  async cli(args, { timeout = 120_000 } = {}) {
    const result = await helloCli(["webview", this.id, ...args], { timeout });
    if (result.status !== 0)
      throw new Error(
        `webview ${args.slice(0, 3).join(" ")} exited ${result.status}: ${result.stderr.trim().slice(-800)}`,
      );
    return result.stdout;
  }

  async eval(js) {
    const out = (await this.cli(["eval", js])).trim();
    return out === "undefined" ? undefined : JSON.parse(out);
  }

  /** `body` is a function of the phase 4 page helpers (sidebar, log, items, agents). */
  page(body) {
    return this.eval(
      `async () => { const L = (${PAGE_LIB})(); return await (${body})(L); }`,
    );
  }

  click(role, name) {
    return this.cli(["click", role, name]);
  }

  fill(role, name, text) {
    return this.cli(["fill", role, name, text]);
  }

  async snapshot(name) {
    const file = join(this.check.dir, name);
    await this.cli(["snapshot", file]);
    return readFileSync(file, "utf8");
  }

  async nodes() {
    const file = join(this.check.dir, `.${this.id}.nodes.json`);
    await this.cli(["snapshot", file, "--json"]);
    const json = JSON.parse(readFileSync(file, "utf8"));
    rmSync(file, { force: true });
    return json.nodes;
  }

  async has(role, name) {
    return (await this.nodes()).some((n) => n.role === role && n.name === name);
  }

  async waitFor(role, name, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await this.has(role, name).catch(() => false)) return true;
      await sleep(300);
    }
    return false;
  }

  async screenshot(name) {
    const file = join(this.check.dir, name);
    const result = await helloCli(["screenshot", this.id, file], { timeout: 60_000 });
    if (result.status !== 0)
      this.check.log(`screenshot ${name} failed: ${result.stderr.trim()}`);
    return file;
  }

  async path() {
    return this.eval("location.pathname").catch(() => undefined);
  }

  /** Signs in through the app's own sign-in page; resolves once the app left `/sign-in`. */
  async signin(user = "alice", ms = 60_000) {
    if (!(await this.waitFor("button", "Sign in", ms)))
      throw new Error(`${this.id}: the sign-in page never showed button "Sign in"`);
    await this.fill("textbox", "Email", `${user}@example.com`);
    await this.fill("textbox", "Password", "parlor-verify-hello");
    await this.click("button", "Sign in");
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await this.signedIn()) return true;
      await sleep(400);
    }
    throw new Error(`${this.id}: still not signed in ${ms} ms after Sign in`);
  }

  /** On an app page, not the sign-in page. */
  async signedIn() {
    const path = await this.path();
    return (
      typeof path === "string" &&
      !path.startsWith("/sign-in") &&
      !(await this.has("button", "Sign in"))
    );
  }

  async sidebarOpen() {
    return (await this.nodes()).some((n) => n.role === "textbox" && n.name === "Message");
  }

  async openSidebar(ms = 20_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await this.sidebarOpen()) return true;
      const agent = (await this.nodes()).find(
        (n) => n.role === "button" && /^Agent(,.*)?$/.test(n.name),
      );
      if (agent) await this.click("button", agent.name).catch(() => {});
      await sleep(500);
    }
    return false;
  }

  /** The options of `combobox "Agent"`, read from the page. */
  agents() {
    return this.page(`(L) => L.agents().map((o) => o.text)`);
  }

  async waitAgents(texts, ms) {
    const deadline = Date.now() + ms;
    let listed = [];
    while (Date.now() < deadline) {
      listed = await this.agents().catch(() => []);
      if (texts.every((t) => listed.includes(t))) return { ok: true, listed };
      await sleep(400);
    }
    return { ok: false, listed };
  }

  async selectAgent(text) {
    await this.fill("combobox", "Agent", text);
    return this.page(`(L) => L.agents().filter((o) => o.selected).map((o) => o.text)`);
  }

  items() {
    return this.page(`(L) => L.items()`);
  }

  async send(text) {
    await this.fill("textbox", "Message", text);
    await this.click("button", "Send");
    return Date.now();
  }

  async newChat() {
    if (await this.has("button", "New chat")) await this.click("button", "New chat");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if ((await this.items()).length === 0) return true;
      await sleep(300);
    }
    return false;
  }

  /** Same rule as the browser's: `prompts` prompts, something after them, no turn running, twice in a row. */
  async waitSettled({ prompts, ms, label = "turn", onPoll }) {
    const deadline = Date.now() + ms;
    let stable = 0;
    let last;
    while (Date.now() < deadline) {
      last = await this.page(
        `(L) => ({ items: L.items(), stop: L.stopVisible() })`,
      ).catch(() => undefined);
      if (last) {
        if (onPoll) await onPoll(last);
        const promptCount = last.items.filter((i) => i.kind === "prompt").length;
        const rest = last.items.filter((i) => i.kind !== "prompt");
        const busy =
          last.stop ||
          last.items.some((i) => i.streaming === "true") ||
          last.items.some((i) => i.kind === "ask" && i.ask?.state === "open");
        stable = promptCount >= prompts && rest.length > 0 && !busy ? stable + 1 : 0;
        if (stable >= 2) return { settled: true, last };
      }
      await sleep(700);
    }
    this.check.log(`${label} not settled after ${ms} ms`);
    return { settled: false, last };
  }
}

function axTool() {
  return nativeTool(TOOLS_DIR, "webview-ax");
}

/** The accessibility tree of a process's windows (sheets and dialogs included). */
export function axTree(pid) {
  const result = runSync(axTool(), ["tree", String(pid)]);
  if (result.status !== 0)
    throw new Error(`webview-ax tree ${pid}: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

export function axPress(pid, path) {
  const result = runSync(axTool(), ["press", String(pid), path]);
  if (result.status !== 0)
    throw new Error(`webview-ax press ${pid} ${path}: ${result.stderr.trim()}`);
  return Date.now();
}

/** The app's native dialog: the window or sheet holding the static text `title`, with its texts and buttons. */
export function findNativeDialog(pid, title) {
  const tree = axTree(pid);
  const scan = (node) => {
    const texts = [];
    const buttons = [];
    const collect = (n) => {
      if (n.role === "AXStaticText" && (n.value ?? n.title))
        texts.push(n.value ?? n.title);
      if (n.role === "AXTextArea" && n.value) texts.push(n.value);
      if (n.role === "AXButton" && (n.title ?? n.desc))
        buttons.push({ name: n.title ?? n.desc, path: n.path });
      for (const c of n.children ?? []) collect(c);
    };
    collect(node);
    return { texts, buttons };
  };
  const containers = [];
  const walk = (node) => {
    if (["AXWindow", "AXSheet"].includes(node.role)) containers.push(node);
    for (const child of node.children ?? []) if (child.role === "AXSheet") walk(child);
  };
  for (const window of tree.windows) walk(window);
  for (const node of containers.reverse()) {
    if (node.role === "AXWindow" && node.title === title)
      return {
        ...scan(node),
        title: node.title,
        frame: node.frame,
        role: node.role,
        pid,
      };
    const { texts, buttons } = scan(node);
    if (
      node.role === "AXSheet" ||
      node.subrole === "AXDialog" ||
      node.subrole === "AXSystemDialog"
    ) {
      if (texts.some((t) => t.trim() === title))
        return { texts, buttons, title, frame: node.frame, role: node.role, pid };
    }
  }
  return undefined;
}

export async function waitNativeDialog(pid, title, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const dialog = (() => {
      try {
        return findNativeDialog(pid, title);
      } catch {
        return undefined;
      }
    })();
    if (dialog) return dialog;
    await sleep(250);
  }
  return undefined;
}

export async function screenshotRegion(check, frame, name) {
  if (!frame) return undefined;
  const file = join(check.dir, name);
  const region = [frame.x, frame.y, frame.w, frame.h].map((v) => Math.round(v)).join(",");
  await runAsync("screencapture", ["-x", `-R${region}`, file], { timeout: 15_000 });
  return file;
}

export function pressDialogButton(dialog, name) {
  const button = dialog.buttons.find((b) => b.name === name);
  if (!button)
    throw new Error(
      `the dialog has no button "${name}": ${JSON.stringify(dialog.buttons.map((b) => b.name))}`,
    );
  return axPress(dialog.pid, button.path);
}

export function appPid(instance) {
  return instance.appPid;
}

/** The installed service of an isolated HOME. */
export class Service {
  constructor(home) {
    this.home = home;
    this.root = join(home, ".parlor", "host");
    this.current = join(this.root, "current");
    this.versions = join(this.root, "versions");
    this.control = join(this.root, "run", "control.sock");
    this.daemonLog = join(this.root, "logs", "daemon.log");
    this.loginItem = join(home, "Library", "LaunchAgents", "dev.parlor.host.plist");
  }

  env() {
    return {
      HOME: this.home,
      PATH: SYSTEM_PATH,
      USER: process.env.USER ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp/",
    };
  }

  bin() {
    return join(this.current, "parlor-host");
  }

  /** `parlor-host status --json` of the installed release, run as the user would from a terminal. */
  async status() {
    if (!existsSync(this.bin())) return { error: `${this.bin()} does not exist` };
    const result = await runAsync(this.bin(), ["status", "--json"], {
      env: this.env(),
      timeout: 30_000,
    });
    try {
      return {
        ...JSON.parse(result.stdout.trim().split("\n").pop()),
        exit: result.status,
      };
    } catch {
      return {
        error: `${result.stdout}${result.stderr}`.slice(0, 600),
        exit: result.status,
      };
    }
  }

  /** The daemon: the pids `lsof -t` reports on the control socket. */
  daemonPids() {
    if (!existsSync(this.control)) return [];
    return runSync("lsof", ["-t", this.control])
      .stdout.split("\n")
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
  }

  /** Every process of this HOME whose command runs a parlor-host binary. */
  hostProcesses() {
    const out = runSync("ps", ["-axww", "-E", "-o", "pid=,ppid=,lstart=,command="], {
      env: { ...process.env, COLUMNS: "100000" },
    }).stdout;
    const marker = new RegExp(
      `(^|\\s)HOME=${this.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`,
    );
    return out
      .split("\n")
      .map((line) =>
        line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s+(.*)$/),
      )
      .filter(
        (m) =>
          m && marker.test(m[4]) && /parlor-host(\s|$)/.test(m[4].split(/\s[A-Z_]+=/)[0]),
      )
      .map((m) => ({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        started: m[3],
        command: m[4].split(/\s[A-Z_][A-Z0-9_]*=/)[0],
      }));
  }

  /** `ls -l` of `current` and where it resolves. */
  currentLink() {
    let link;
    let real;
    try {
      link = readlinkSync(this.current);
      real = realpathSync(this.current);
    } catch {
      /* missing */
    }
    return {
      exists: existsSync(this.current),
      isLink: (() => {
        try {
          return lstatSync(this.current).isSymbolicLink();
        } catch {
          return false;
        }
      })(),
      link,
      real,
      ls:
        runSync("ls", ["-l", this.current]).stdout +
        runSync("ls", ["-lR", this.versions]).stdout,
    };
  }

  loginItemPlist() {
    if (!existsSync(this.loginItem)) return undefined;
    const result = runSync("plutil", ["-convert", "json", "-o", "-", this.loginItem]);
    try {
      return JSON.parse(result.stdout);
    } catch {
      return { raw: readFileSync(this.loginItem, "utf8") };
    }
  }

  logEvents() {
    return readJsonLines(this.daemonLog);
  }

  /** The `{"event":"ensure",...}` lines an app appended to its log, newest last. */
  ensureLines(appId) {
    return readJsonLines(
      join(this.home, "Library", "Logs", appId, "parlor-host.log"),
    ).filter((line) => line.event === "ensure");
  }

  ensureLogFile(appId) {
    return join(this.home, "Library", "Logs", appId, "parlor-host.log");
  }
}

/** The app's session item in the login Keychain, by attributes only (no secret is read). */
export function sessionItem(appId) {
  const result = runSync("security", [
    "find-generic-password",
    "-s",
    appId,
    "-a",
    SESSION_ACCOUNT,
  ]);
  return {
    exists: result.status === 0,
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

export function deleteSessionItem(appId) {
  for (let i = 0; i < 5; i++) {
    if (
      runSync("security", ["delete-generic-password", "-s", appId, "-a", SESSION_ACCOUNT])
        .status !== 0
    )
      break;
  }
}

/** Deletes the session items of `appIds` now and when the check ends. */
export function ownSessionItems(check, appIds) {
  for (const appId of appIds) deleteSessionItem(appId);
  check.onCleanup(() => {
    for (const appId of appIds) deleteSessionItem(appId);
  });
}

/** Fails the check when it touched the developer's own `~/.parlor` or LaunchAgents. */
export function guardRealHome(check) {
  const paths = [
    join(REAL_HOME, ".parlor"),
    join(REAL_HOME, "Library", "LaunchAgents", "dev.parlor.host.plist"),
  ];
  const before = Object.fromEntries(
    paths.map((p) => [p, existsSync(p) ? statSync(p).mtimeMs : null]),
  );
  check.onCleanup(() => {
    const after = Object.fromEntries(
      paths.map((p) => [p, existsSync(p) ? statSync(p).mtimeMs : null]),
    );
    const changed = paths.filter((p) => before[p] !== after[p]);
    if (changed.length) {
      check.expect(
        "the developer's own ~/.parlor and LaunchAgents are untouched",
        false,
        { before, after },
      );
    }
  });
}

/** An isolated HOME under the short homes root, removed when the check ends. */
export function shortHome(check, tag) {
  const made = makeHome(check, tag);
  if (Buffer.byteLength(made.home) >= 40)
    throw new Error(
      `the isolated HOME ${made.home} is ${Buffer.byteLength(made.home)} bytes; keep it under 40 (${HOMES_ROOT})`,
    );
  return made.home;
}

/**
 * Registers the fake agent before the app starts the service: its profile in the HOME's
 * agents.json points at the snapshot of instance `id` (created by `up --id id`), through a
 * wrapper that sets FAKE_AGENT_LOG, because the app, not the check, starts the daemon.
 */
export function registerFakeAgent(check, { home, id, script, tag = check.id }) {
  const scriptFile = check.save(`${tag}.fake-script.json`, script);
  const logFile = join(check.dir, `${tag}.fake-agent.log`);
  const entry = join(snapshotRepo(id), "packages", "agent-host", "bin", "fake-agent.mjs");
  const wrapper = join(check.dir, `${tag}.fake-agent.sh`);
  const q = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
  writeFileSync(
    wrapper,
    `#!/bin/sh\nFAKE_AGENT_LOG=${q(logFile)} exec ${q(process.execPath)} ${q(entry)} ${q(scriptFile)} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  const profile = {
    id: "fake",
    name: "Fake agent",
    launch: { kind: "native", command: wrapper, args: [] },
    binary: wrapper,
  };
  writeAgentProfiles(home, [profile]);
  return {
    id: "fake",
    name: "Fake agent",
    profile,
    scriptFile,
    logFile,
    messages: () => readJsonLines(logFile),
  };
}

/**
 * A copy of this checkout acting as another app (`appId`, `appName`) and/or bundling another
 * host release (`release`: a dir with `parlor-host` and `parlor-host.sig`), committed so the
 * driver can snapshot it; removed when the check ends.
 */
export async function sourceCopy(check, { tag, appId, appName, release }) {
  const dir = join(HARNESS_HOME, "sources", `${tag}-${randomBytes(2).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  check.onCleanup(() => rmSync(dir, { recursive: true, force: true }));
  const rsync = await runAsync(
    "rsync",
    [
      "-a",
      "--delete",
      "--exclude=/.git",
      "--exclude=node_modules",
      "--exclude=.parlor",
      "--exclude=/docs",
      "--exclude=dist",
      "--exclude=target",
      `${ROOT}/`,
      `${dir}/`,
    ],
    { timeout: 300_000 },
  );
  if (rsync.status !== 0) throw new Error(`rsync into ${dir} failed: ${rsync.stderr}`);
  const config = join(dir, "examples", "hello", "parlor.config.ts");
  let text = readFileSync(config, "utf8");
  if (appId) {
    if (!text.includes(`id: "${HELLO_APP_ID}"`))
      throw new Error(`${config} has no id: "${HELLO_APP_ID}"`);
    text = text.replace(`id: "${HELLO_APP_ID}"`, `id: "${appId}"`);
  }
  if (appName) {
    if (!/name: "Hello"/.test(text)) throw new Error(`${config} has no name: "Hello"`);
    text = text.replace(/name: "Hello"/, `name: "${appName}"`);
  }
  writeFileSync(config, text);
  if (release) {
    const bin = join(dir, "packages", "agent-host-darwin-arm64", "bin");
    if (!existsSync(dirname(bin)))
      throw new Error(
        `this checkout has no packages/agent-host-darwin-arm64 to bundle another host release into`,
      );
    mkdirSync(bin, { recursive: true });
    cpSync(join(release, "parlor-host"), join(bin, "parlor-host"));
    cpSync(join(release, "parlor-host.sig"), join(bin, "parlor-host.sig"));
    chmodSync(join(bin, "parlor-host"), 0o755);
  }
  const git = (args) =>
    runSync(
      "git",
      ["-c", "user.name=verify", "-c", "user.email=verify@example.com", ...args],
      { cwd: dir },
    );
  git(["init", "-q"]);
  git(["add", "-A", "-f", "."]);
  const commit = git(["commit", "-q", "--no-verify", "-m", `verify source copy ${tag}`]);
  if (commit.status !== 0) throw new Error(`committing ${dir} failed: ${commit.stderr}`);
  check.log(
    `source copy ${dir} (${appId ?? HELLO_APP_ID}${release ? `, release from ${release}` : ""})`,
  );
  return dir;
}

export class ProvisionError extends Error {}

/** A release key pair under the check dir: Ed25519, private in PKCS8 PEM, public in SPKI PEM. */
export function releaseKeys(check, name) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = check.save(
    `${name}.key.pem`,
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  const pub = check.save(
    `${name}.pub.pem`,
    publicKey.export({ type: "spki", format: "pem" }),
  );
  return { name, key, pub };
}

/**
 * `node packages/agent-host/scripts/release.mjs --version V --key PEM --out DIR` with the trusted
 * public key fixed at build time through PARLOR_HOST_RELEASE_KEY_FILE.
 */
export async function buildHostRelease(check, { version, signWith, trusted, label }) {
  const script = join(ROOT, "packages", "agent-host", "scripts", "release.mjs");
  if (!existsSync(script))
    throw new ProvisionError(
      `this checkout has no packages/agent-host/scripts/release.mjs, so no host release can be built`,
    );
  if (!existsSync(join(ROOT, "node_modules"))) {
    const install = await runAsync(
      "pnpm",
      ["install", "--offline", "--frozen-lockfile"],
      { cwd: ROOT, timeout: 600_000 },
    );
    if (install.status !== 0)
      throw new ProvisionError(
        `pnpm install --offline in ${ROOT} failed: ${install.stderr.slice(-800)}`,
      );
  }
  const out = join(check.dir, `${label}.release`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const result = await runAsync(
    process.execPath,
    [script, "--version", version, "--key", signWith.key, "--out", out],
    {
      cwd: ROOT,
      env: { ...process.env, PARLOR_HOST_RELEASE_KEY_FILE: trusted.pub },
      timeout: 900_000,
    },
  );
  check.save(`${label}.release.log`, `${result.stdout}\n${result.stderr}`);
  if (
    result.status !== 0 ||
    !existsSync(join(out, "parlor-host")) ||
    !existsSync(join(out, "parlor-host.sig"))
  )
    throw new ProvisionError(
      `release.mjs --version ${version} exited ${result.status}: ${result.stderr.slice(-800)}`,
    );
  return out;
}

/** Release fixtures signed with one trusted Ed25519 key; a spec with `otherKey` signs with a second key. */
export async function hostReleases(check, specs) {
  const trusted = releaseKeys(check, "trusted");
  const other = releaseKeys(check, "other");
  const built = {};
  for (const spec of specs) {
    built[spec.label] = await buildHostRelease(check, {
      version: spec.version,
      label: spec.label,
      trusted,
      signWith: spec.otherKey ? other : trusted,
    });
  }
  check.log(
    `host releases built: ${specs.map((s) => `${s.label}=${s.version}`).join(", ")}`,
  );
  return { trusted, other, built };
}

/** Launches a release app with `open -n` and the driver's launch environment; resolves with the launch time. */
export async function openApp(instance) {
  const env = Object.entries(instance.launchEnv ?? {}).flatMap(([k, v]) => [
    "--env",
    `${k}=${v}`,
  ]);
  const at = Date.now();
  const result = await runAsync("open", ["-n", ...env, instance.appBundle], {
    timeout: 30_000,
  });
  if (result.status !== 0)
    throw new Error(`open -n ${instance.appBundle} failed: ${result.stderr}`);
  return at;
}

export async function quitApp(instance) {
  const result = await helloCli(["quit", instance.id], { timeout: 60_000 });
  if (result.status !== 0)
    throw new Error(`quit ${instance.id} failed: ${result.stderr}`);
}

export async function launchApp(instance) {
  const result = await helloCli(["launch", instance.id], { timeout: 90_000 });
  if (result.status !== 0)
    throw new Error(`launch ${instance.id} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

export async function waitAppPid(id, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const now = await instanceInfo(id);
    if (now.appPid) return now;
    await sleep(100);
  }
  return undefined;
}

/**
 * Alice connects this Mac from the app the way a user does: `button "Use agents on this
 * computer"` in the sidebar, then `Connect` in the native dialog. Returns what the dialog showed.
 */
export async function connectHere(
  check,
  webview,
  { appName, label, answer = "Connect", ms = 60_000 },
) {
  await webview.snapshot(`${label}.sidebar-before.aria.txt`);
  await webview.screenshot(`${label}.sidebar-before.png`);
  const here = await webview.waitFor("button", "Use agents on this computer", 15_000);
  if (
    !check.expect(
      `${label}: the sidebar offers button "Use agents on this computer"`,
      here,
      here,
    )
  )
    return undefined;
  const clickedAt = Date.now();
  await webview.click("button", "Use agents on this computer");
  const current = await instanceInfo(webview.id);
  const title = `Connect this Mac to ${appName}`;
  const dialog = await waitNativeDialog(current.appPid, title, ms);
  if (
    !check.expect(
      `${label}: the app shows the native dialog "${title}"`,
      Boolean(dialog),
      dialog ?? null,
    )
  ) {
    await webview.screenshot(`${label}.no-dialog.png`);
    return undefined;
  }
  await screenshotRegion(check, dialog.frame, `${label}.dialog.png`);
  await webview.screenshot(`${label}.dialog-window.png`);
  check.save(`${label}.dialog.json`, dialog);
  const answeredAt = pressDialogButton(dialog, answer);
  return { dialog, clickedAt, answeredAt };
}

/** `listTasks` as `user` over HTTP: the second view of a task mutation that must not restart the instance. */
export async function listTasks(instance, user = "alice") {
  const session = await token(instance, "session", user);
  const response = await postJson(
    `${instance.urls.server}/_parlor/actions/listTasks`,
    {},
    {
      authorization: `Bearer ${session}`,
    },
  );
  if (!Array.isArray(response.json?.data))
    throw new Error(
      `listTasks answered ${response.status}: ${response.text.slice(0, 300)}`,
    );
  return response.json.data;
}

/**
 * Samples every process of `home` (the app, the service, its agents) every `everyMs`, keeping
 * each pid's first and last sighting with its parent and command.
 */
export function homeSampler(home, everyMs = 400) {
  const seen = new Map();
  const ticks = [];
  const run = { stopped: false };
  const loop = (async () => {
    while (!run.stopped) {
      const at = Date.now();
      const now = processesWithHome(home);
      ticks.push({ at, pids: now.map((p) => p.pid) });
      for (const p of now) {
        const command = p.line.split(/\s[A-Z_][A-Z0-9_]*=/)[0];
        const entry = seen.get(p.pid) ?? { pid: p.pid, ppid: p.ppid, command, first: at };
        entry.last = at;
        seen.set(p.pid, entry);
      }
      await sleep(everyMs);
    }
  })();
  return {
    processes: () => [...seen.values()],
    ticks: () => ticks,
    async stop() {
      run.stopped = true;
      await loop;
      return { processes: [...seen.values()], ticks };
    },
  };
}

/** True when `pid` descends from `ancestor` in the sampled parent links. */
export function descendsFrom(processes, pid, ancestor) {
  const parents = new Map(processes.map((p) => [p.pid, p.ppid]));
  for (let at = pid, hops = 0; at > 1 && hops < 64; at = parents.get(at), hops++) {
    if (at === ancestor) return true;
    if (!parents.has(at)) {
      const ppid = Number(runSync("ps", ["-o", "ppid=", "-p", String(at)]).stdout.trim());
      if (!ppid) return false;
      parents.set(at, ppid);
    }
  }
  return false;
}

/** Everything the page keeps in web storage, CryptoKeys and binary values made printable. */
export const STORAGE_DUMP = `async () => {
  const printable = (v, depth = 0) => {
    if (depth > 8) return '[deep]';
    if (v === null || v === undefined || typeof v !== 'object') return v;
    if (typeof CryptoKey !== 'undefined' && v instanceof CryptoKey) return { CryptoKey: { type: v.type, extractable: v.extractable, algorithm: v.algorithm, usages: v.usages } };
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) { const b = new Uint8Array(v.buffer ?? v); let s = ''; for (const x of b) s += String.fromCharCode(x); return { bytes: btoa(s) }; }
    if (v instanceof Date) return { date: v.toISOString() };
    if (Array.isArray(v)) return v.map((x) => printable(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, printable(x, depth + 1)]));
  };
  const area = (s) => { const out = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); out[k] = s.getItem(k); } return out; };
  const req = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const indexed = {};
  const names = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [];
  for (const name of names) {
    const db = await req(indexedDB.open(name));
    indexed[name] = {};
    for (const store of db.objectStoreNames) {
      const tx = db.transaction(store);
      const keys = await req(tx.objectStore(store).getAllKeys());
      const values = await req(tx.objectStore(store).getAll());
      indexed[name][store] = keys.map((k, i) => ({ key: printable(k), value: printable(values[i]) }));
    }
    db.close();
  }
  return { origin: location.origin, href: location.href, localStorage: area(localStorage), sessionStorage: area(sessionStorage), indexedDB: indexed, cookie: document.cookie };
}`;

export { parseEval, sleep };
