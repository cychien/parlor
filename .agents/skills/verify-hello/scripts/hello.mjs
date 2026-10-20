#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { cpus, homedir, loadavg } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  agentLoginStatus,
  hostBin,
  hostEnv,
  prepareHome,
  withoutAuth,
} from "./agent-home.mjs";
import { createHostCommand } from "./host.mjs";

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = join(SKILL_DIR, "fixtures");
const APP_PATH = "examples/hello";
const BUNDLE_ID = "dev.parlor.hello";
const HOME = canonicalPath(
  process.env.PARLOR_VERIFY_HOME ?? join(homedir(), ".cache", "parlor-verify-hello"),
);
const INSTANCES_DIR = join(HOME, "instances");
const CARGO_TARGET_DIR = join(HOME, "cargo-target");
const LOCK_DIR = join(HOME, ".lock");
const XCODE_DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";
const DEFAULT_DEVICE = "iPhone 17 Pro";
const TARGETS = ["web", "mac", "ios"];
const PORT_RANGES = { server: [3300, 3399], web: [5300, 5399], cdp: [9300, 9399] };
const MCP_CALL_TIMEOUT_MS = 180_000;
const MCP_CALL_MAX_TOTAL_MS = 300_000;
const FOCUS_SETTLE_MS = 5000;
const FOCUS_PROBE = "__helloFocusProbe";
const READY_TIMEOUT_MS = { web: 120_000, mac: 1_800_000, ios: 1_800_000 };
const STOP_GRACE_MS = 10_000;
const SNAPSHOT_EXCLUDES = [
  "/.git",
  "/.agents",
  "/.claude",
  "/docs",
  "node_modules",
  ".parlor",
  "dist",
  ".output",
  ".nitro",
  "coverage",
  "*.log",
  ".DS_Store",
  `/${APP_PATH}/parlor.config.ts`,
  `/${APP_PATH}/parlor.config.source.ts`,
];
const FINGERPRINT_SKIP = [".agents/", ".claude/", "docs/"];
const USERS = {
  alice: { id: "alice", name: "Alice", email: "alice@example.com" },
  bob: { id: "bob", name: "Bob", email: "bob@example.com" },
};
const PASSWORD = "parlor-verify-hello";
// better-auth/crypto hashPassword(PASSWORD): seeding writes it as is, without Better Auth.
const PASSWORD_HASH =
  "8d1a9a3c2713d7517fd3870ae6145587:b8adeda943efe474d1faf107a9c2c2eda5ffb67f8685b6d0b8cfc4028dc457042aac911886cc083ccfddba5d0c722be570955117e788fe2e1a0e017306752224";
const HARNESS_CLIENT = "verify-hello";
const HARNESS_REDIRECT = "http://127.0.0.1:47001/callback";

const USAGE = `usage: hello.mjs <command> [args]

  up [--id ID] [--target web|mac|ios] [--seed DATASET] [--device NAME] [--source DIR]
     [--no-auth --home HOME] [--home HOME] [--keep-on-failure] [--force]
                          snapshot the checkout, pick free ports, launch, wait until usable;
                          refused when the 1-minute load is at or above 0.7 x cores (HELLO_MAX_LOAD
                          overrides), when a mac or ios target is asked while another native
                          instance is still starting, or when HELLO_MAX_INSTANCES (unset by
                          default) are running, unless --force
                          --home HOME runs parlor dev (and the dev host it spawns) with HOME=HOME, an
                          isolated home whose agent logins are linked (see agent-home); --no-auth also
                          snapshots hello with the auth option and its imports removed from server.ts,
                          so plain parlor dev installs devAuth, and needs --home
  doctor ID               read-only health check; exit 1 when the instance is not worth driving
  seed ID DATASET         load a fixture straight into PGlite (stops and restarts a running instance)
  sql ID QUERY            read-only SQL against the instance's PGlite (stops and restarts it)
  stop ID | start ID      stop or start the processes, keeping the snapshot and its data
  sync ID                 copy the current checkout into a running instance (tsx and Vite reload)
  mcp ID tools | resources [--as USER]
                          raw MCP tools/list or resources/list against the instance, as alice
                          unless --as names another seeded user
  mcp ID resource URI     raw MCP resources/read, prints the contents; exit 1 on error
  mcp ID call TOOL [JSON] [--out FILE] [--as USER]
                          raw MCP tools/call; --out also writes {tool, input, startedAt, endedAt, ms,
                          isError, result} (epoch ms) for a call started in the background with &
  agent ID --out DIR [--model M] [--as USER] PROMPT
                          Claude Code headless, MCP-only tools, transcript into DIR
  token ID [--as USER] [--kind session|mcp]
                          print a bearer token: a session for actions, sync and /ui, or an MCP access token
  browser ID signin [USER]
                          sign the selected tab in as USER (alice by default), signing out first
  browser ID open [PATH] | click ROLE NAME | fill ROLE NAME TEXT | snapshot [FILE]
                          chrome-devtools-axi in this instance's own session, refs found by role and name;
                          any other axi command (screenshot FILE, wait TEXT, eval JS, console) passes through
  browser ID focus on|off make the selected page report document.hasFocus() true or false, firing blur
                          or focus; open, click, fill undo off, and after a click or fill off needs a fresh tab
  host ID pair --as USER --name NAME [--out DIR] [--no-approve] [--no-exchange]
                          pair a fake computer with the user's account (host-initiated, PKCE, ES256)
  host ID exchange|assert|call|request|play|hello|online|send|stream|seed-thread|list
                          drive that computer over the real wire; host selfcheck verifies the
                          signing helpers; see SKILL.md, "Fake host"
  screenshot ID FILE      capture the mac window or the iOS simulator screen
  info ID | list          print one instance's state, or every instance plus stray processes
                          under the home that belong to no instance
  reap [--kill]           list processes whose cwd or command is under the home (deleted cwds
                          included); exit 1 while any remain; --kill sends SIGTERM then SIGKILL
  down ID... | --all [--save-log FILE]
                          stop what this skill started and delete the snapshot, never evidence;
                          exit 1 and keep the instance when any process or listener survives SIGKILL
  evidence                print and create this branch's verification directory
  agent-home HOME         create an isolated HOME: empty ~/.parlor, symlinks to the developer's Codex
                          file login and login Keychain, and an open shim that records URLs; prints JSON
  parlor-host ID HOME [ARGS...]
                          run the unpublished host CLI from instance ID's snapshot as parlor-host with
                          HOME=HOME (prepared as agent-home does); its exit code passes through

users: ${Object.keys(USERS).join(", ")} (password ${PASSWORD})
datasets: ${datasets().join(", ")}
home: ${HOME}`;

class CliError extends Error {}

function positiveNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!(value > 0)) throw new CliError(`${name} must be a positive number, got "${raw}"`);
  return value;
}

function fail(message) {
  throw new CliError(message);
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    fail(
      `${command} ${args.join(" ")} exited ${result.status}\n${result.stderr ?? ""}${result.stdout ?? ""}`,
    );
  }
  return result;
}

function datasets() {
  return readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => basename(file, ".sql"))
    .sort();
}

function fixturePath(name) {
  const path = join(FIXTURES_DIR, `${name}.sql`);
  if (!existsSync(path))
    fail(`no dataset "${name}". Available: ${datasets().join(", ")}`);
  return path;
}

function instanceDir(id) {
  return join(INSTANCES_DIR, id);
}

function statePath(id) {
  return join(instanceDir(id), "state.json");
}

function readState(id) {
  if (!id) fail("missing instance id");
  if (!existsSync(statePath(id))) fail(`no instance "${id}" under ${INSTANCES_DIR}`);
  return JSON.parse(readFileSync(statePath(id), "utf8"));
}

function writeState(state) {
  writeFileSync(statePath(state.id), `${JSON.stringify(state, null, 2)}\n`);
}

function allStates() {
  if (!existsSync(INSTANCES_DIR)) return [];
  return readdirSync(INSTANCES_DIR)
    .filter((id) => existsSync(statePath(id)))
    .map((id) => readState(id));
}

function urls(state) {
  const web = `http://localhost:${state.ports.web}`;
  return {
    web,
    server: `http://localhost:${state.ports.server}`,
    mcp: `${web}/_parlor/mcp`,
  };
}

function userOf(name = "alice") {
  const user = USERS[name];
  if (!user)
    fail(`no seeded user "${name}"; pick one of ${Object.keys(USERS).join(", ")}`);
  return user;
}

function accountsSql(state) {
  const resource = urls(state).mcp;
  const users = Object.values(USERS);
  return `
INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
  ${users.map((u) => `('${u.id}', '${u.name}', '${u.email}', true, now(), now())`).join(",\n  ")}
ON CONFLICT (id) DO NOTHING;
INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES
  ${users.map((u) => `('${u.id}-credential', '${u.id}', 'credential', '${u.id}', '${PASSWORD_HASH}', now(), now())`).join(",\n  ")}
ON CONFLICT (id) DO NOTHING;
INSERT INTO oauth_resource (id, identifier, name, created_at, updated_at)
VALUES ('verify-hello-mcp', '${resource}', '${resource}', now(), now())
ON CONFLICT (identifier) DO NOTHING;
INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method,
  application_type, grant_types, response_types, scopes, skip_consent, require_pkce,
  created_at, updated_at)
VALUES ('${HARNESS_CLIENT}', '${HARNESS_CLIENT}', 'verify-hello', ARRAY['http://127.0.0.1/callback'],
  'none', 'native', ARRAY['authorization_code', 'refresh_token'], ARRAY['code'],
  ARRAY['mcp', 'offline_access'], true, true, now(), now())
ON CONFLICT (client_id) DO NOTHING;
INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at)
VALUES ('${HARNESS_CLIENT}-mcp', '${HARNESS_CLIENT}', '${resource}', now())
ON CONFLICT (id) DO NOTHING;`;
}

async function signIn(state, name) {
  const user = userOf(name);
  const web = urls(state).web;
  const response = await fetch(`${web}/_parlor/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: web },
    body: JSON.stringify({ email: user.email, password: PASSWORD }),
    signal: AbortSignal.timeout(10_000),
  });
  const token = response.headers.get("set-auth-token");
  if (!response.ok || !token) {
    throw new CliError(
      `sign-in as ${name} answered ${response.status}: ${await response.text()}`,
    );
  }
  return token;
}

/** One session per user per instance, kept in its state, so probes do not pile up sessions. */
async function sessionToken(state, name = "alice", { fresh = false } = {}) {
  const cached = state.sessions?.[name];
  if (cached && !fresh) return cached;
  const token = await signIn(state, name);
  state.sessions = { ...state.sessions, [name]: token };
  writeState(state);
  return token;
}

async function asUser(state, name, send) {
  let response = await send(await sessionToken(state, name));
  if (response.status === 401) {
    response = await send(await sessionToken(state, name, { fresh: true }));
  }
  return response;
}

function authedPost(state, url, body, name) {
  return asUser(state, name, (token) =>
    probe(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
}

function authedGet(state, url, name) {
  return asUser(state, name, (token) =>
    probe(url, { headers: { authorization: `Bearer ${token}` } }),
  );
}

/** The harness client is seeded with skip_consent, so the code comes straight back. */
async function accessToken(state, name = "alice") {
  const cached = state.tokens?.[name];
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const u = urls(state);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: HARNESS_CLIENT,
    redirect_uri: HARNESS_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: randomBytes(8).toString("hex"),
    scope: "mcp offline_access",
    resource: u.mcp,
  });
  const authorize = await asUser(state, name, async (session) => {
    const response = await fetch(`${u.web}/_parlor/auth/oauth2/authorize?${query}`, {
      headers: { authorization: `Bearer ${session}`, accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    return response;
  });
  // Better Auth answers a request it takes for a fetch with {redirect, url} instead of a 302.
  const text = await authorize.text();
  const location =
    authorize.headers.get("location") ?? JSON.parse(text || "{}").url ?? undefined;
  const code = location && new URL(location, u.web).searchParams.get("code");
  if (!code)
    throw new CliError(`authorize as ${name} answered ${authorize.status} ${text}`);
  const exchange = await fetch(`${u.web}/_parlor/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: HARNESS_REDIRECT,
      client_id: HARNESS_CLIENT,
      code_verifier: verifier,
      resource: u.mcp,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await exchange.json().catch(() => ({}));
  if (!exchange.ok || !body.access_token) {
    throw new CliError(
      `token exchange as ${name} answered ${exchange.status}: ${JSON.stringify(body)}`,
    );
  }
  state.tokens = {
    ...state.tokens,
    [name]: { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 },
  };
  writeState(state);
  return body.access_token;
}

function processTable() {
  return run("ps", ["-A", "-o", "pid=,ppid=,pgid=,%cpu=,etime=,command="])
    .stdout.split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, pgid, cpu, elapsed, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      cpu: Number(cpu),
      elapsed,
      command,
    }));
}

function processCwds(pids) {
  const args = ["-nP", "-a", "-d", "cwd", "-F", "pn"];
  if (pids) args.push("-p", pids.join(","));
  const cwds = new Map();
  let pid;
  for (const line of run("lsof", args, { allowFailure: true }).stdout.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    if (line[0] === "n" && pid !== undefined) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

function isUnder(path, root) {
  return path !== undefined && (path === root || path.startsWith(`${root}/`));
}

function ancestorPids(table) {
  const parents = new Map(table.map((p) => [p.pid, p.ppid]));
  const chain = new Set();
  for (let pid = process.pid; pid > 1 && !chain.has(pid); pid = parents.get(pid)) {
    chain.add(pid);
  }
  return chain;
}

function processesUnder(root, table = processTable()) {
  const cwds = processCwds();
  const self = ancestorPids(table);
  return table
    .filter((p) => !self.has(p.pid))
    .map((p) => ({ ...p, cwd: cwds.get(p.pid) }))
    .filter((p) => isUnder(p.cwd, root) || p.command.includes(`${root}/`));
}

function instanceIdIn(text) {
  const prefix = `${INSTANCES_DIR}/`;
  const at = text?.indexOf(prefix) ?? -1;
  return at < 0 ? undefined : text.slice(at + prefix.length).split(/[/\s]/)[0];
}

function instanceIdOf(p) {
  return instanceIdIn(p.cwd) ?? instanceIdIn(p.command);
}

function processKey(p) {
  return `${p.pid} ${p.command}`;
}

function ownedProcesses(state, table = processTable()) {
  const dir = `${instanceDir(state.id)}/`;
  const recorded = new Set((state.processes ?? []).map(processKey));
  const owned = new Map(
    table
      .filter(
        (p) =>
          (p.pid === state.pid && p.command.includes(dir)) || recorded.has(processKey(p)),
      )
      .map((p) => [p.pid, p]),
  );
  const groups = new Set(
    [...owned.values()].filter((p) => p.pid === p.pgid).map((p) => p.pid),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of table) {
      if (owned.has(p.pid) || !(owned.has(p.ppid) || groups.has(p.pgid))) continue;
      owned.set(p.pid, p);
      if (p.pid === p.pgid) groups.add(p.pid);
      grew = true;
    }
  }
  return [...owned.values()].filter(
    (p) => p.pgid !== process.pid && p.pid !== process.pid,
  );
}

function isRunning(state) {
  return ownedProcesses(state).length > 0;
}

function listenerPids(port) {
  const result = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    allowFailure: true,
  });
  return result.stdout.split("\n").filter(Boolean).map(Number);
}

function serverClients(port) {
  const result = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-F", "pcn"], {
    allowFailure: true,
  });
  const clients = new Map();
  let current = {};
  for (const line of result.stdout.split("\n")) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") current = { pid: Number(value) };
    if (field === "c") current.command = value;
    if (field === "n" && value.endsWith(`->127.0.0.1:${port}`))
      clients.set(current.pid, current);
    if (field === "n" && value.endsWith(`->[::1]:${port}`))
      clients.set(current.pid, current);
  }
  return [...clients.values()];
}

async function withLock(task) {
  mkdirSync(HOME, { recursive: true });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() - statSync(LOCK_DIR).mtimeMs > 120_000)
        rmSync(LOCK_DIR, { recursive: true, force: true });
      if (Date.now() > deadline) fail(`could not take ${LOCK_DIR}`);
      await sleep(200);
    }
  }
  try {
    return await task();
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

function pickPort([from, to], reserved) {
  for (let port = from; port <= to; port += 1) {
    if (!reserved.has(port) && listenerPids(port).length === 0) return port;
  }
  return fail(`no free port in ${from}-${to}`);
}

function reservedPorts() {
  return new Set(allStates().flatMap((s) => [s.ports.server, s.ports.web, s.cdpPort]));
}

function allocateCdpPort() {
  return pickPort(PORT_RANGES.cdp, reservedPorts());
}

function allocatePorts() {
  const reserved = reservedPorts();
  const server = pickPort(PORT_RANGES.server, reserved);
  reserved.add(server);
  return { server, web: pickPort(PORT_RANGES.web, reserved) };
}

function sourceRoot(option) {
  const root = run("git", [
    "-C",
    option ?? SKILL_DIR,
    "rev-parse",
    "--show-toplevel",
  ]).stdout.trim();
  if (!existsSync(join(root, APP_PATH, "parlor.config.ts")))
    fail(`${root} has no ${APP_PATH}`);
  return root;
}

function sourceRevision(root) {
  const head = run("git", ["-C", root, "rev-parse", "HEAD"]).stdout.trim();
  const files = run("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "-z"])
    .stdout.split("\0")
    .filter((file) => file && !FINGERPRINT_SKIP.some((skip) => file.startsWith(skip)))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const path = join(root, file);
    if (!existsSync(path) || statSync(path).isDirectory()) continue;
    hash.update(file).update("\0").update(readFileSync(path)).update("\0");
  }
  return { head, fingerprint: hash.digest("hex").slice(0, 16) };
}

function appDir(state) {
  return join(instanceDir(state.id), "repo", APP_PATH);
}

function logPath(state) {
  return join(instanceDir(state.id), "dev.log");
}

function configOverlay(ports) {
  return `import source from "./parlor.config.source.ts";

export default {
  ...source,
  server: { ...source.server, port: ${ports.server}, url: "http://localhost:${ports.server}" },
  web: { ...source.web, port: ${ports.web} },
};
`;
}

function snapshot(state) {
  const repo = join(instanceDir(state.id), "repo");
  mkdirSync(repo, { recursive: true });
  run("rsync", [
    "-a",
    "--delete",
    ...SNAPSHOT_EXCLUDES.map((pattern) => `--exclude=${pattern}`),
    `${state.source}/`,
    `${repo}/`,
  ]);
  copyFileSync(
    join(state.source, APP_PATH, "parlor.config.ts"),
    join(appDir(state), "parlor.config.source.ts"),
  );
  writeFileSync(join(appDir(state), "parlor.config.ts"), configOverlay(state.ports));
  if (state.noAuth) {
    const server = join(appDir(state), "server.ts");
    writeFileSync(server, withoutAuth(readFileSync(server, "utf8")));
  }
  mkdirSync(join(appDir(state), ".parlor"), { recursive: true });
  const out = openSync(logPath(state), "a");
  try {
    run("pnpm", ["install", "--offline", "--frozen-lockfile"], {
      cwd: repo,
      stdio: ["ignore", out, out],
    });
  } finally {
    closeSync(out);
  }
}

function devEnv(state) {
  const env = { ...process.env, FORCE_COLOR: "0", BROWSER: "none" };
  if (state.home) Object.assign(env, hostEnv(state.home, env));
  if (state.target === "mac") env.CARGO_TARGET_DIR = CARGO_TARGET_DIR;
  if (state.target === "ios" && !env.DEVELOPER_DIR && existsSync(XCODE_DEVELOPER_DIR)) {
    env.DEVELOPER_DIR = XCODE_DEVELOPER_DIR;
  }
  return env;
}

function xcrun(args, options = {}) {
  return run("xcrun", args, { env: devEnv({ target: "ios" }), ...options });
}

function simulator(name) {
  const { devices } = JSON.parse(
    xcrun(["simctl", "list", "devices", "available", "-j"]).stdout,
  );
  const match = Object.entries(devices)
    .filter(([runtime]) => runtime.includes("iOS"))
    .flatMap(([, list]) => list)
    .find((device) => device.name === name || device.udid === name);
  if (!match) fail(`no available iOS simulator named "${name}"`);
  return { udid: match.udid, name: match.name, booted: match.state === "Booted" };
}

function iosAppRunning(udid) {
  const result = xcrun(["simctl", "spawn", udid, "launchctl", "list"], {
    allowFailure: true,
  });
  return result.status === 0 && result.stdout.includes(`UIKitApplication:${BUNDLE_ID}`);
}

async function probe(url, init = {}) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { ok: response.ok, status: response.status, text, json };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: String(error?.cause?.code ?? error),
      json: undefined,
    };
  }
}

function postJson(url, body) {
  return probe(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function shellProcess(state, table) {
  if (state.target !== "mac") return undefined;
  return ownedProcesses(state, table).find((p) => /\/parlor_app(\s|$)/.test(p.command));
}

function externalClients(state, table) {
  const owned = new Set(ownedProcesses(state, table).map((p) => p.pid));
  return serverClients(state.ports.server).filter(
    (client) => !owned.has(client.pid) && client.pid !== process.pid,
  );
}

async function readiness(state) {
  const u = urls(state);
  const page = await probe(`${u.web}/`);
  if (!page.ok || !page.text.includes("<title>Hello</title>"))
    return "web page not served yet";
  let list;
  try {
    list = state.noAuth
      ? await postJson(`${u.web}/_parlor/actions/listTasks`, {})
      : await authedPost(state, `${u.web}/_parlor/actions/listTasks`, {});
  } catch {
    return "sign-in through the Vite proxy not answering yet";
  }
  if (!list.ok || !Array.isArray(list.json?.data))
    return "listTasks through the Vite proxy not answering yet";
  const table = processTable();
  if (state.target === "mac" && !shellProcess(state, table))
    return "parlor_app not running yet (cargo build)";
  if (state.target === "ios" && !iosAppRunning(state.simulator.udid))
    return "iOS app not running yet (xcodebuild)";
  if (state.target !== "web" && externalClients(state, table).length === 0) {
    return "shell has not connected to the server yet";
  }
  return undefined;
}

function logSince(state, offset) {
  return readFileSync(logPath(state)).subarray(offset).toString("utf8");
}

async function waitReady(state, logOffset) {
  const deadline = Date.now() + READY_TIMEOUT_MS[state.target];
  let last = "";
  while (Date.now() < deadline) {
    if (!isRunning(state)) fail(`parlor dev exited before it was ready\n${tail(state)}`);
    if (/^Node\.js v\d+/m.test(logSince(state, logOffset))) {
      fail(`a dev process crashed during launch\n${tail(state)}`);
    }
    const pending = await readiness(state);
    if (!pending) return;
    if (pending !== last) log(`waiting: ${pending}`);
    last = pending;
    await sleep(1000);
  }
  fail(
    `not ready after ${READY_TIMEOUT_MS[state.target] / 1000}s: ${last}\n${tail(state)}`,
  );
}

function tail(state, lines = 40) {
  if (!existsSync(logPath(state))) return "";
  const text = readFileSync(logPath(state), "utf8").trimEnd().split("\n");
  return `--- last ${lines} lines of ${logPath(state)} ---\n${text.slice(-lines).join("\n")}`;
}

async function start(state) {
  if (isRunning(state)) fail(`instance ${state.id} is already running`);
  const logOffset = existsSync(logPath(state)) ? statSync(logPath(state)).size : 0;
  const out = openSync(logPath(state), "a");
  const args = ["dev", "--target", state.target];
  if (state.target === "ios") args.push("--device", state.simulator.udid);
  const child = spawn(join(appDir(state), "node_modules", ".bin", "parlor"), args, {
    cwd: appDir(state),
    detached: true,
    stdio: ["ignore", out, out],
    env: devEnv(state),
  });
  closeSync(out);
  child.unref();
  state.pid = child.pid;
  state.processes = [];
  delete state.readyAt;
  writeState(state);
  log(
    `started parlor dev --target ${state.target} (pid ${child.pid}), log ${logPath(state)}`,
  );
  await waitReady(state, logOffset);
  state.processes = ownedProcesses(state).map(({ pid, command }) => ({ pid, command }));
  state.readyAt = new Date().toISOString();
  writeState(state);
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch {
    return false;
  }
  return true;
}

function describeProcess(p) {
  const command = p.command.length > 140 ? `${p.command.slice(0, 140)}...` : p.command;
  return `pid ${p.pid} ppid ${p.ppid} pgid ${p.pgid} elapsed ${p.elapsed} cwd ${p.cwd ?? "?"} ${command}`;
}

function instanceSurvivors(state) {
  const table = processTable();
  const found = new Map();
  const add = (p, reason) => {
    const entry = found.get(p.pid) ?? { ...p, reasons: [] };
    entry.reasons.push(reason);
    found.set(p.pid, entry);
  };
  for (const p of ownedProcesses(state, table)) add(p, "instance process");
  for (const p of processesUnder(instanceDir(state.id), table))
    add(p, "cwd or command under the instance dir");
  const ports = [...Object.values(state.ports), state.cdpPort].filter(Boolean);
  for (const port of ports) {
    for (const pid of listenerPids(port)) {
      const p = table.find((row) => row.pid === pid);
      if (p) add({ ...p, cwd: processCwds([pid]).get(pid) }, `listening on port ${port}`);
    }
  }
  return [...found.values()];
}

async function waitUntil(done, ms) {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await sleep(250);
  return done();
}

async function killSurvivors(state) {
  let survivors = instanceSurvivors(state);
  for (let round = 0; survivors.length > 0 && round < 3; round += 1) {
    log(
      `killing leftovers of ${state.id}:\n  ${survivors.map(describeProcess).join("\n  ")}`,
    );
    for (const p of survivors) signal(p.pid, "SIGKILL");
    await waitUntil(() => instanceSurvivors(state).length === 0, 3000);
    survivors = instanceSurvivors(state);
  }
  return survivors;
}

async function stopProcesses(state) {
  state.processes = ownedProcesses(state).map(({ pid, command }) => ({ pid, command }));
  writeState(state);
  let owned = ownedProcesses(state);
  if (owned.length > 0) {
    for (const pgid of new Set(owned.map((p) => p.pgid))) signal(-pgid, "SIGTERM");
    if (!(await waitUntil(() => ownedProcesses(state).length === 0, STOP_GRACE_MS))) {
      owned = ownedProcesses(state);
      log(`force killing ${owned.map((p) => p.pid).join(" ")}`);
      for (const p of owned.filter((q) => q.pid === q.pgid)) signal(-p.pgid, "SIGKILL");
      for (const p of owned) signal(p.pid, "SIGKILL");
    }
  }
  if (state.target === "ios" && state.simulator) {
    xcrun(["simctl", "terminate", state.simulator.udid, BUNDLE_ID], {
      allowFailure: true,
    });
  }
  const survivors = await killSurvivors(state);
  if (survivors.length > 0) {
    fail(
      `${state.id} still has ${survivors.length} process(es) after SIGKILL, so its state in ${instanceDir(state.id)} is kept:\n  ` +
        `${survivors.map((p) => `${describeProcess(p)} [${p.reasons.join("; ")}]`).join("\n  ")}\n` +
        "Retry down, or run reap --kill.",
    );
  }
  state.processes = [];
  writeState(state);
}

function pgliteModules(state) {
  const require = createRequire(
    join(instanceDir(state.id), "repo", "packages", "data", "package.json"),
  );
  return {
    PGlite: require("@electric-sql/pglite").PGlite,
    drizzle: require("drizzle-orm/pglite").drizzle,
    migrate: require("drizzle-orm/pglite/migrator").migrate,
  };
}

async function withDatabase(state, task) {
  const { PGlite, drizzle, migrate } = pgliteModules(state);
  const dataDir = join(appDir(state), ".parlor", "pglite");
  mkdirSync(dirname(dataDir), { recursive: true });
  const client = new PGlite(dataDir);
  try {
    await migrate(drizzle(client), {
      migrationsFolder: join(appDir(state), "migrations"),
    });
    return await task(client);
  } finally {
    await client.close();
  }
}

async function seedAccounts(state) {
  await withDatabase(state, (client) =>
    client.transaction((tx) => tx.exec(accountsSql(state))),
  );
}

async function loadDataset(state, name) {
  const sql = readFileSync(fixturePath(name), "utf8");
  const summary = await withDatabase(state, async (client) => {
    await client.transaction(async (tx) => {
      await tx.exec(accountsSql(state));
      await tx.exec(sql);
    });
    const { rows } = await client.query(
      `select count(*)::int as tasks, count(*) filter (where done)::int as done,
              (select title from tasks order by created_at limit 1) as first,
              (select title from tasks order by created_at desc limit 1) as last
         from tasks`,
    );
    return rows[0];
  });
  state.dataset = name;
  writeState(state);
  return summary;
}

async function withStopped(state, task) {
  const wasRunning = isRunning(state);
  if (wasRunning) {
    log(`stopping ${state.id} so PGlite can be opened directly`);
    await stopProcesses(state);
  }
  try {
    return await task();
  } finally {
    if (wasRunning) await start(state);
  }
}

function busiestProcesses(limit = 5) {
  const busiest = processTable()
    .filter((p) => p.pid !== process.pid && !p.command.startsWith("ps -A"))
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, limit);
  const cwds = processCwds(busiest.map((p) => p.pid));
  return busiest.map((p) => ({ ...p, cwd: cwds.get(p.pid) }));
}

function isHarnessLeftover(p) {
  return p.ppid === 1 && (isUnder(p.cwd, HOME) || p.command.includes(`${HOME}/`));
}

function describeBusiest() {
  const busiest = busiestProcesses();
  const lines = busiest.map(
    (p) =>
      `  ${p.cpu.toFixed(1)}% ${describeProcess(p)}${isHarnessLeftover(p) ? "  <- LEFTOVER of this harness" : ""}`,
  );
  return (
    `\nbusiest processes:\n${lines.join("\n")}` +
    (busiest.some(isHarnessLeftover)
      ? "\nrun reap --kill to remove the leftovers, then retry."
      : "")
  );
}

const LOAD_PER_CORE = 0.7;

function checkCapacity(target) {
  const [load] = loadavg();
  const cores = cpus().length;
  const maxLoad = positiveNumber("HELLO_MAX_LOAD", LOAD_PER_CORE * cores);
  const maxInstances = positiveNumber("HELLO_MAX_INSTANCES", Infinity);
  const active = allStates().filter((s) => !s.pid || isRunning(s));
  const reasons = [];
  if (load >= maxLoad)
    reasons.push(
      `load rule: 1-minute load is at or above the limit of ${maxLoad.toFixed(2)}`,
    );
  const startingNative = active.filter((s) => s.target !== "web" && !s.readyAt);
  if (target !== "web" && startingNative.length > 0)
    reasons.push(
      `native rule: ${startingNative.map((s) => s.id).join(", ")} is still starting, one native build at a time`,
    );
  if (active.length >= maxInstances)
    reasons.push(`instance cap rule: HELLO_MAX_INSTANCES of ${maxInstances} reached`);
  if (reasons.length === 0) return;
  fail(
    `refusing to start: ${reasons.join("; ")}. ` +
      `1-minute load ${load.toFixed(2)}, ${cores} cores, running instances [${active.map((s) => s.id).join(", ") || "none"}]. ` +
      "Wait for the load to drop or for the native instance to be ready, or down one, or pass --force." +
      (load >= maxLoad ? describeBusiest() : ""),
  );
}

function newId(target) {
  return `${target}-${randomBytes(2).toString("hex")}`;
}

async function cmdUp(args) {
  const { values } = parseArgs({
    args,
    options: {
      id: { type: "string" },
      target: { type: "string", default: "web" },
      seed: { type: "string" },
      device: { type: "string", default: DEFAULT_DEVICE },
      source: { type: "string" },
      "keep-on-failure": { type: "boolean" },
      force: { type: "boolean" },
      "no-auth": { type: "boolean" },
      home: { type: "string" },
    },
  });
  if (values["no-auth"] && !values.home)
    fail(
      "--no-auth needs --home: the dev host it spawns must not touch the developer's ~/.parlor",
    );
  if (values.home && values.target !== "web") fail("--home is for the web target");
  if (!TARGETS.includes(values.target))
    fail(`--target must be one of ${TARGETS.join(", ")}`);
  if (values.seed) fixturePath(values.seed);
  const id = values.id ?? newId(values.target);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id))
    fail("--id must be lowercase letters, digits, and dashes");
  const source = sourceRoot(values.source);
  const sim = values.target === "ios" ? simulator(values.device) : undefined;

  const state = await withLock(() => {
    if (existsSync(instanceDir(id))) fail(`instance "${id}" already exists`);
    if (!values.force) checkCapacity(values.target);
    if (sim) {
      const clash = allStates().find((s) => s.simulator?.udid === sim.udid);
      if (clash)
        fail(
          `instance ${clash.id} already drives ${sim.name}; one iOS instance per simulator`,
        );
    }
    const created = {
      id,
      target: values.target,
      source,
      ...sourceRevision(source),
      ports: allocatePorts(),
      cdpPort: allocateCdpPort(),
      noAuth: values["no-auth"] ? true : undefined,
      home: values.home ? resolve(values.home) : undefined,
      simulator: sim ? { ...sim, bootedBefore: sim.booted } : undefined,
      createdAt: new Date().toISOString(),
    };
    mkdirSync(instanceDir(id), { recursive: true });
    writeState(created);
    return created;
  });

  try {
    log(
      `snapshot ${source} (${state.head.slice(0, 12)}, fingerprint ${state.fingerprint}) into ${instanceDir(id)}`,
    );
    snapshot(state);
    if (state.home) prepareHome(state.home);
    if (values.seed)
      log(
        `seeded ${values.seed}: ${JSON.stringify(await loadDataset(state, values.seed))}`,
      );
    else if (!state.noAuth) await seedAccounts(state);
    if (!state.noAuth)
      log(`seeded users ${Object.keys(USERS).join(", ")} (password ${PASSWORD})`);
    await start(state);
  } catch (error) {
    log(error instanceof CliError ? error.message : String(error?.stack ?? error));
    if (values["keep-on-failure"]) {
      await stopProcesses(state);
      throw new CliError(
        `up ${id} failed; snapshot kept in ${instanceDir(id)}, remove it with down ${id}`,
      );
    }
    log(`launch failed, cleaning up ${id}`);
    await teardown(state, {});
    throw new CliError(`up ${id} failed`);
  }
  printInfo(state);
}

function printInfo(state) {
  const running = isRunning(state);
  process.stdout.write(
    `${JSON.stringify(
      {
        id: state.id,
        target: state.target,
        running,
        urls: urls(state),
        dataset: state.dataset ?? null,
        source: state.source,
        head: state.head,
        fingerprint: state.fingerprint,
        appDir: appDir(state),
        dataDir: join(appDir(state), ".parlor", "pglite"),
        log: logPath(state),
        browserSession: browserSession(state),
        browserCdpPort: state.cdpPort ?? null,
        noAuth: state.noAuth ?? false,
        home: state.home ?? null,
        simulator: state.simulator ?? null,
      },
      null,
      2,
    )}\n`,
  );
}

async function cmdDoctor([id]) {
  const state = readState(id);
  const u = urls(state);
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });
  const table = processTable();
  const owned = ownedProcesses(state, table);
  const ownedPids = new Set(owned.map((p) => p.pid));

  check("processes", owned.length > 0, `${owned.length} owned, root pid ${state.pid}`);
  const current = sourceRevision(state.source);
  check(
    "build",
    current.fingerprint === state.fingerprint,
    current.fingerprint === state.fingerprint
      ? `snapshot matches ${state.source} at ${state.head.slice(0, 12)}`
      : `source changed since the snapshot (${state.fingerprint} -> ${current.fingerprint}); run sync`,
  );
  for (const [role, port] of Object.entries(state.ports)) {
    const pids = listenerPids(port);
    check(
      `${role} port ${port}`,
      pids.length > 0 && pids.every((pid) => ownedPids.has(pid)),
      pids.length === 0 ? "nothing listening" : `listeners ${pids.join(" ")}`,
    );
  }
  const page = await probe(`${u.web}/`);
  check(
    "web page",
    page.ok && page.text.includes("<title>Hello</title>"),
    `${u.web}/ -> ${page.status}`,
  );
  const manifest = await authedGet(state, `${u.server}/_parlor/manifest`).catch(
    (error) => ({ ok: false, json: undefined, status: String(error?.message ?? error) }),
  );
  const names = (manifest.json?.actions ?? []).map((a) => a.name).sort();
  check(
    "manifest",
    manifest.ok && manifest.json?.protocol === 1,
    `actions ${names.join(", ")}`,
  );
  const negotiation = await authedPost(state, `${u.server}/_parlor/sync/token`, {}).catch(
    (error) => ({ ok: false, json: undefined, text: String(error?.message ?? error) }),
  );
  check("sync", negotiation.ok, `transport ${negotiation.json?.transport}`);
  const list = await authedPost(state, `${u.web}/_parlor/actions/listTasks`, {}).catch(
    (error) => ({ ok: false, json: undefined, text: String(error?.message ?? error) }),
  );
  const tasks = Array.isArray(list.json?.data) ? list.json.data : undefined;
  check(
    "listTasks as alice via proxy",
    Boolean(tasks),
    tasks
      ? `${tasks.length} tasks, first ${JSON.stringify(tasks.slice(0, 3).map((t) => t.title))}`
      : list.text.slice(0, 120),
  );
  try {
    const tools = await withMcp(state, (client) => client.listTools());
    check(
      "mcp",
      tools.tools.length > 0,
      `tools ${tools.tools
        .map((t) => t.name)
        .sort()
        .join(", ")}`,
    );
  } catch (error) {
    check("mcp", false, String(error?.message ?? error));
  }
  const serverPid = listenerPids(state.ports.server)[0];
  if (serverPid) {
    const cwd = run("lsof", ["-a", "-p", String(serverPid), "-d", "cwd", "-Fn"], {
      allowFailure: true,
    })
      .stdout.split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1);
    check(
      "data dir",
      cwd === appDir(state),
      `server cwd ${cwd}, PGlite at ${cwd}/.parlor/pglite`,
    );
  }
  if (state.target === "mac") {
    const app = shellProcess(state, table);
    check(
      "desktop app",
      Boolean(app),
      app ? `parlor_app pid ${app.pid}` : "parlor_app not running",
    );
  }
  if (state.target === "ios") {
    check(
      "iOS app",
      iosAppRunning(state.simulator.udid),
      `${BUNDLE_ID} on ${state.simulator.name}`,
    );
  }
  if (state.target !== "web") {
    const clients = externalClients(state, table);
    check(
      "shell reaches server",
      clients.length > 0,
      clients.length
        ? clients.map((c) => `${c.command}(${c.pid})`).join(" ")
        : "no connection from outside the dev tree",
    );
  }
  const anonymous = await postJson(`${u.web}/_parlor/actions/listTasks`, {});
  check(
    "auth",
    anonymous.status === 401,
    `anonymous listTasks -> ${anonymous.status}; users ${Object.keys(USERS).join(", ")}`,
  );

  for (const r of results)
    process.stdout.write(`${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.detail}\n`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

async function withMcp(state, task, user = "alice") {
  const require = createRequire(
    join(instanceDir(state.id), "repo", "packages", "server", "package.json"),
  );
  const {
    Client,
    StreamableHTTPClientTransport,
  } = require("@modelcontextprotocol/client");
  const token = await accessToken(state, user);
  const client = new Client({ name: "verify-hello", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(urls(state).mcp), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  try {
    return await task(client);
  } finally {
    await client.close();
  }
}

function writeJsonAtomic(file, value) {
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(partial, path);
}

async function callTool(client, tool, input, out) {
  const startedAt = Date.now();
  const record = (outcome) => {
    const endedAt = Date.now();
    if (out)
      writeJsonAtomic(out, {
        tool,
        input,
        startedAt,
        endedAt,
        ms: endedAt - startedAt,
        ...outcome,
      });
  };
  let result;
  try {
    result = await client.callTool(
      { name: tool, arguments: input },
      {
        timeout: MCP_CALL_TIMEOUT_MS,
        maxTotalTimeout: MCP_CALL_MAX_TOTAL_MS,
        resetTimeoutOnProgress: true,
        onprogress: () => {},
      },
    );
  } catch (error) {
    record({ isError: true, result: { error: String(error?.message ?? error) } });
    throw error;
  }
  record({ isError: Boolean(result.isError), result });
  return result;
}

async function cmdMcp(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { out: { type: "string" }, as: { type: "string" } },
  });
  const [id, mode, subject, input] = positionals;
  userOf(values.as);
  const usage =
    "usage: mcp ID tools | resources | resource URI | call TOOL [JSON] [--out FILE]";
  const state = readState(id);
  if (values.out && mode !== "call") fail("--out applies to mcp ID call only");
  let result;
  try {
    result = await withMcp(
      state,
      (client) => {
        if (mode === "tools") return client.listTools();
        if (mode === "resources") return client.listResources();
        if (mode === "resource" && subject) return client.readResource({ uri: subject });
        if (mode === "call" && subject)
          return callTool(client, subject, input ? JSON.parse(input) : {}, values.out);
        return fail(usage);
      },
      values.as,
    );
  } catch (error) {
    if (error instanceof CliError) throw error;
    return fail(`mcp ${mode} failed: ${error?.message ?? error}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.isError) process.exitCode = 1;
}

function agentEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|AI_AGENT)/.test(key),
    ),
  );
}

async function cmdAgent(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      model: { type: "string" },
      as: { type: "string" },
    },
  });
  const [id, ...words] = positionals;
  userOf(values.as);
  const state = readState(id);
  const prompt = words.join(" ");
  if (!values.out || !prompt) fail("usage: agent ID --out DIR [--model M] PROMPT");
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const config = join(out, "agent-mcp-config.json");
  const token = await accessToken(state, values.as);
  const server = {
    type: "http",
    url: urls(state).mcp,
    headers: { Authorization: `Bearer ${token}` },
  };
  writeFileSync(
    config,
    `${JSON.stringify({ mcpServers: { hello: server } }, null, 2)}\n`,
  );
  const cwd = join(instanceDir(state.id), "agent-cwd");
  mkdirSync(cwd, { recursive: true });
  const claudeArgs = [
    "-p",
    prompt,
    "--mcp-config",
    config,
    "--strict-mcp-config",
    "--tools",
    "",
    "--allowedTools",
    "mcp__hello",
    "--setting-sources",
    "project",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(values.model ? ["--model", values.model] : []),
  ];
  writeFileSync(
    join(out, "agent-command.json"),
    `${JSON.stringify(["claude", ...claudeArgs])}\n`,
  );
  log(`running claude -p against ${urls(state).mcp}`);
  const result = run("claude", claudeArgs, {
    cwd,
    env: agentEnv(),
    allowFailure: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const transcript = join(out, "agent-transcript.jsonl");
  writeFileSync(transcript, result.stdout);
  const events = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const calls = events
    .filter((e) => e.type === "assistant")
    .flatMap((e) => e.message.content.filter((c) => c.type === "tool_use"))
    .map((c) => ({ tool: c.name, input: c.input }));
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const final = events.findLast((e) => e.type === "result");
  const summary = {
    exitCode: result.status,
    mcpServers: init?.mcp_servers ?? [],
    toolCalls: calls,
    result: final?.result ?? null,
    isError: final?.is_error ?? true,
    transcript,
  };
  writeFileSync(join(out, "agent-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (result.status !== 0 || summary.isError) process.exitCode = 1;
}

function macWindowId(pid) {
  const script = `ObjC.import("CoreGraphics");
const windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0)));
const match = windows
  .filter((w) => w.kCGWindowOwnerPID === ${pid} && w.kCGWindowLayer === 0 && w.kCGWindowIsOnscreen)
  .sort((a, b) => b.kCGWindowBounds.Width * b.kCGWindowBounds.Height - a.kCGWindowBounds.Width * a.kCGWindowBounds.Height)[0];
match ? String(match.kCGWindowNumber) : "";`;
  return run("osascript", ["-l", "JavaScript", "-e", script]).stdout.trim();
}

// macOS cannot capture a hidden, minimized, or other-Space window, so bring the app forward first.
async function revealMacApp(pid) {
  run("osascript", [
    "-e",
    `tell application "System Events" to tell (first process whose unix id is ${pid}) to set {visible, frontmost} to {true, true}`,
  ]);
  for (let attempt = 0; attempt < 20; attempt++) {
    const window = macWindowId(pid);
    if (window) return window;
    await new Promise((settle) => setTimeout(settle, 100));
  }
  return "";
}

async function cmdScreenshot([id, file]) {
  const state = readState(id);
  if (!file) fail("usage: screenshot ID FILE");
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  if (state.target === "ios") {
    xcrun(["simctl", "io", state.simulator.udid, "screenshot", path]);
  } else if (state.target === "mac") {
    const app = shellProcess(state, processTable());
    if (!app) fail("parlor_app is not running");
    const window = macWindowId(app.pid) || (await revealMacApp(app.pid));
    if (!window) fail(`no on-screen window for parlor_app pid ${app.pid}`);
    run("screencapture", ["-x", "-o", `-l${window}`, path]);
  } else {
    fail(`web instances are captured with: hello.mjs browser ${id} screenshot FILE`);
  }
  process.stdout.write(`${path}\n`);
}

function axiEnv(state) {
  const chromeArgs = [
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS,
    state.cdpPort && !browserProfile() && `--remote-debugging-port=${state.cdpPort}`,
  ].filter(Boolean);
  return {
    ...process.env,
    CHROME_DEVTOOLS_AXI_SESSION: browserSession(state),
    CHROME_DEVTOOLS_AXI_CHROME_ARGS: chromeArgs.join(" "),
  };
}

function axi(state, args, options = {}) {
  return run("npx", ["-y", "chrome-devtools-axi", ...args], {
    env: axiEnv(state),
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function axiAsync(state, args) {
  return new Promise((settle, abort) => {
    const child = spawn("npx", ["-y", "chrome-devtools-axi", ...args], {
      env: axiEnv(state),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => abort(new CliError(`npx failed: ${error.message}`)));
    child.on("close", (status) => {
      if (status !== 0) {
        abort(
          new CliError(
            `chrome-devtools-axi ${args.join(" ")} exited ${status}\n${stderr}${stdout}`,
          ),
        );
      } else {
        settle({ status, stdout, stderr });
      }
    });
  });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function browserRef(state, role, name) {
  const aria = axi(state, ["snapshot", "--full"]).stdout;
  const pattern = new RegExp(`uid=(\\S+) ${role} "${escapeRegExp(name)}"(\\s|$)`);
  const matches = aria.split("\n").filter((line) => pattern.test(line));
  if (matches.length !== 1) {
    fail(`expected one ${role} "${name}", found ${matches.length}\n${aria}`);
  }
  return `@${matches[0].match(pattern)[1]}`;
}

function axiOnElement(state, command, role, name, ...rest) {
  const attempt = () => axi(state, [command, browserRef(state, role, name), ...rest]);
  try {
    return attempt();
  } catch (error) {
    if (!String(error.message).includes("STALE_REF")) throw error;
    return attempt();
  }
}

async function signInBrowser(state, name) {
  const user = userOf(name);
  axi(state, ["open", `${urls(state).web}/sign-in`]);
  axi(state, ["wait", "Sign"]);
  if (/button "Sign out"/.test(axi(state, ["snapshot", "--full"]).stdout)) {
    axi(state, ["click", browserRef(state, "button", "Sign out")]);
    axi(state, ["wait", "Sign in to Hello"]);
  }
  axi(state, ["fill", browserRef(state, "textbox", "Email"), user.email]);
  axi(state, ["fill", browserRef(state, "textbox", "Password"), PASSWORD]);
  axi(state, ["click", browserRef(state, "button", "Sign in")]);
  return axi(state, ["wait", "Sign out"]);
}

async function browserSignIn(state, name) {
  const result = await signInBrowser(state, name);
  process.stdout.write(`signed in as ${name}\n${result.stdout}`);
}

async function cmdBrowser([id, action, ...args]) {
  const state = readState(id);
  const print = (result) => process.stdout.write(result.stdout);
  if (action === "signin") return browserSignIn(state, args[0]);
  if (action === "open")
    return print(axi(state, ["open", `${urls(state).web}${args[0] ?? "/"}`]));
  if (action === "click") return print(axiOnElement(state, "click", args[0], args[1]));
  if (action === "fill")
    return print(axiOnElement(state, "fill", args[0], args[1], args[2] ?? ""));
  if (action === "focus") return setBrowserFocus(state, args[0]);
  if (action === "snapshot") {
    const result = axi(state, ["snapshot", "--full"]);
    if (args[0]) writeFileSync(resolve(args[0]), result.stdout);
    return print(result);
  }
  if (!action)
    fail(
      "usage: browser ID signin [USER] | open [PATH] | click ROLE NAME | fill ROLE NAME TEXT | snapshot [FILE] | focus on|off | <axi command>",
    );
  return print(axi(state, [action, ...args]));
}

function browserProfile() {
  return process.env.HELLO_BROWSER_PROFILE || undefined;
}

function browserSession(state) {
  const profile = browserProfile();
  return profile ? `hello-${state.id}-${profile}` : `hello-${state.id}`;
}

async function cdpConnect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  const closed = new Promise((done) => {
    socket.onclose = done;
  });
  await new Promise((open, reject) => {
    socket.onopen = open;
    socket.onerror = () => reject(new Error(`cannot open ${url}`));
  });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  };
  const send = (method, params = {}) =>
    new Promise((settle, abort) => {
      nextId += 1;
      pending.set(nextId, { resolve: settle, reject: abort });
      socket.send(JSON.stringify({ id: nextId, method, params }));
    });
  return {
    closed,
    send,
    close: () => socket.close(),
    evaluate: async (expression) =>
      (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value,
  };
}

async function cdpPageTargets(state) {
  if (!state.cdpPort) fail(`instance ${state.id} has no CDP port; recreate it with up`);
  try {
    const targets = await (
      await fetch(`http://127.0.0.1:${state.cdpPort}/json/list`)
    ).json();
    return targets.filter((target) => target.type === "page");
  } catch {
    return fail(
      `no browser on CDP port ${state.cdpPort}; run: hello.mjs browser ${state.id} stop, then browser ${state.id} open /`,
    );
  }
}

async function selectedPageTarget(state) {
  const nonce = randomBytes(8).toString("hex");
  axi(state, ["eval", `(window.${FOCUS_PROBE} = "${nonce}")`]);
  for (const target of await cdpPageTargets(state)) {
    const session = await cdpConnect(target.webSocketDebuggerUrl);
    const found = await session.evaluate(`window.${FOCUS_PROBE}`);
    if (found === nonce) {
      await session.evaluate(`delete window.${FOCUS_PROBE}`);
      session.close();
      return target;
    }
    session.close();
  }
  return fail("could not find the selected page among the browser's targets");
}

async function pageFocusReport(page) {
  return JSON.parse(
    await page.evaluate(
      "JSON.stringify({ hasFocus: document.hasFocus(), visibilityState: document.visibilityState })",
    ),
  );
}

async function setBrowserFocus(state, mode) {
  if (mode !== "on" && mode !== "off") fail("usage: browser ID focus on|off");
  const wanted = mode === "on";
  const target = await selectedPageTarget(state);
  const page = await cdpConnect(target.webSocketDebuggerUrl);
  if ((await pageFocusReport(page)).hasFocus !== wanted) {
    const { webSocketDebuggerUrl } = await (
      await fetch(`http://127.0.0.1:${state.cdpPort}/json/version`)
    ).json();
    const browser = await cdpConnect(webSocketDebuggerUrl);
    let frontId = target.id;
    if (!wanted) {
      // Enabling then disabling from this session drops the emulation axi applies to every page.
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      const other = (await cdpPageTargets(state)).find(({ id }) => id !== target.id);
      frontId =
        other?.id ??
        (await browser.send("Target.createTarget", { url: "about:blank" })).targetId;
    }
    await browser.send("Target.activateTarget", { targetId: frontId });
    browser.close();
  }
  const deadline = Date.now() + FOCUS_SETTLE_MS;
  let report = await pageFocusReport(page);
  while (report.hasFocus !== wanted && Date.now() < deadline) {
    await sleep(100);
    report = await pageFocusReport(page);
  }
  page.close();
  process.stdout.write(
    `${JSON.stringify({ url: target.url, focus: mode, ...report })}\n`,
  );
  if (report.hasFocus !== wanted)
    fail(
      `page still reports hasFocus ${report.hasFocus} after focus ${mode}; a click or fill gives a tab real input focus that only a fresh tab sheds: hello.mjs browser ${state.id} closepage <id>, then newpage <url>, then focus ${mode}`,
    );
}

async function cmdToken(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { as: { type: "string" }, kind: { type: "string", default: "session" } },
  });
  const state = readState(positionals[0]);
  userOf(values.as);
  if (values.kind === "session") {
    process.stdout.write(`${await sessionToken(state, values.as, { fresh: true })}\n`);
  } else if (values.kind === "mcp") {
    process.stdout.write(`${await accessToken(state, values.as)}\n`);
  } else {
    fail("--kind must be session or mcp");
  }
}

async function cmdSeed([id, name]) {
  const state = readState(id);
  fixturePath(name);
  await withStopped(state, async () => {
    const summary = await loadDataset(state, name);
    process.stdout.write(`${JSON.stringify({ dataset: name, ...summary })}\n`);
  });
}

async function cmdSql([id, query]) {
  const state = readState(id);
  if (!query) fail("usage: sql ID QUERY");
  await withStopped(state, async () => {
    const rows = await withDatabase(state, (client) =>
      client.transaction(async (tx) => {
        await tx.exec("set transaction read only");
        return (await tx.query(query)).rows;
      }),
    );
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  });
}

async function cmdStop([id]) {
  const state = readState(id);
  await stopProcesses(state);
  log(`stopped ${id}; snapshot and data kept in ${instanceDir(id)}`);
}

async function cmdStart([id]) {
  const state = readState(id);
  await start(state);
  printInfo(state);
}

async function cmdSync([id]) {
  const state = readState(id);
  Object.assign(state, sourceRevision(state.source));
  snapshot(state);
  writeState(state);
  log(
    `synced ${state.source} (${state.head.slice(0, 12)}, fingerprint ${state.fingerprint}); tsx restarts the server, Vite reloads the page`,
  );
}

async function teardown(state, { saveLog }) {
  axi(state, ["stop"], { allowFailure: true });
  await stopProcesses(state);
  if (state.simulator && !state.simulator.bootedBefore) {
    xcrun(["simctl", "shutdown", state.simulator.udid], { allowFailure: true });
  }
  if (saveLog && existsSync(logPath(state))) {
    mkdirSync(dirname(resolve(saveLog)), { recursive: true });
    copyFileSync(logPath(state), resolve(saveLog));
    log(`saved log to ${resolve(saveLog)}`);
  }
  rmSync(instanceDir(state.id), { recursive: true, force: true });
  log(`removed ${state.id}`);
}

async function cmdDown(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { all: { type: "boolean" }, "save-log": { type: "string" } },
  });
  const states = values.all ? allStates() : positionals.map(readState);
  if (states.length === 0) fail("usage: down ID... | --all");
  if (values["save-log"] && states.length > 1) fail("--save-log takes one instance");
  const failed = [];
  for (const state of states) {
    try {
      await teardown(state, { saveLog: values["save-log"] });
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      log(error.message);
      failed.push(state.id);
    }
  }
  if (failed.length > 0) fail(`down failed for ${failed.join(", ")}`);
}

function strayProcesses() {
  const table = processTable();
  const tracked = new Set(
    allStates().flatMap((state) => ownedProcesses(state, table).map((p) => p.pid)),
  );
  return processesUnder(INSTANCES_DIR, table).filter((p) => !tracked.has(p.pid));
}

function strayRow(p) {
  return {
    stray: true,
    pid: p.pid,
    ppid: p.ppid,
    pgid: p.pgid,
    elapsed: p.elapsed,
    cwd: p.cwd ?? null,
    instance: instanceIdOf(p) ?? null,
    command: p.command,
  };
}

function cmdList() {
  const rows = allStates().map((s) => ({
    id: s.id,
    target: s.target,
    running: isRunning(s),
    web: urls(s).web,
    server: urls(s).server,
    dataset: s.dataset ?? null,
    head: s.head.slice(0, 12),
  }));
  const strays = strayProcesses();
  process.stdout.write(
    `${JSON.stringify([...rows, ...strays.map(strayRow)], null, 2)}\n`,
  );
  if (strays.length > 0)
    log(
      `${strays.length} stray process(es) under ${INSTANCES_DIR} belong to no running instance; run reap --kill`,
    );
}

async function cmdReap(args) {
  const { values } = parseArgs({ args, options: { kill: { type: "boolean" } } });
  let found = processesUnder(INSTANCES_DIR);
  if (values.kill && found.length > 0) {
    log(`terminating ${found.length} process(es) under ${INSTANCES_DIR}`);
    for (const p of found) signal(p.pid, "SIGTERM");
    await waitUntil(() => processesUnder(INSTANCES_DIR).length === 0, STOP_GRACE_MS);
    for (let round = 0; round < 3; round += 1) {
      found = processesUnder(INSTANCES_DIR);
      if (found.length === 0) break;
      log(`killing ${found.map((p) => p.pid).join(" ")}`);
      for (const p of found) signal(p.pid, "SIGKILL");
      await waitUntil(() => processesUnder(INSTANCES_DIR).length === 0, 3000);
    }
  }
  const remaining = processesUnder(INSTANCES_DIR);
  process.stdout.write(`${JSON.stringify(remaining.map(strayRow), null, 2)}\n`);
  if (remaining.length > 0)
    fail(
      values.kill
        ? `${remaining.length} process(es) under ${INSTANCES_DIR} survived SIGKILL`
        : `${remaining.length} process(es) run under ${INSTANCES_DIR}; reap --kill removes them`,
    );
}

function cmdEvidence() {
  const script = [
    join(homedir(), ".claude", "skills", "verify", "scripts", "verify.py"),
    join(homedir(), ".agents", "skills", "verify", "scripts", "verify.py"),
  ].find((path) => existsSync(path));
  if (!script)
    fail(
      "the verify skill is not installed; pick an evidence directory outside the repo",
    );
  const dir = run("python3", [script, "where"], { cwd: sourceRoot() }).stdout.trim();
  mkdirSync(dir, { recursive: true });
  process.stdout.write(`${dir}\n`);
}

const cmdHost = createHostCommand({
  fail,
  log,
  readState,
  urls,
  instanceDir,
  userOf,
  asUser,
  writeJsonAtomic,
  axiAsync,
  browserRef,
  signInBrowser,
});

function cmdAgentHome([home]) {
  if (!home) fail("usage: agent-home HOME");
  process.stdout.write(`${JSON.stringify(prepareHome(home), null, 2)}\n`);
  const login = agentLoginStatus(home);
  process.stdout.write(`${JSON.stringify(login, null, 2)}\n`);
}

function cmdParlorHost([id, home, ...args]) {
  if (!id || !home) fail("usage: parlor-host ID HOME [ARGS...]");
  const state = readState(id);
  prepareHome(home);
  const bin = hostBin(join(instanceDir(state.id), "repo"));
  if (!existsSync(bin))
    fail(`instance ${id} has no ${bin}; its snapshot predates the host`);
  const result = spawnSync("node", [bin, ...args], {
    cwd: join(instanceDir(state.id), "repo"),
    env: hostEnv(home),
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
}

const COMMANDS = {
  "agent-home": cmdAgentHome,
  "parlor-host": cmdParlorHost,
  up: cmdUp,
  doctor: cmdDoctor,
  seed: cmdSeed,
  sql: cmdSql,
  stop: cmdStop,
  start: cmdStart,
  sync: cmdSync,
  mcp: cmdMcp,
  agent: cmdAgent,
  token: cmdToken,
  browser: cmdBrowser,
  host: cmdHost,
  screenshot: cmdScreenshot,
  info: ([id]) => printInfo(readState(id)),
  list: cmdList,
  reap: cmdReap,
  down: cmdDown,
  evidence: cmdEvidence,
};

const [command, ...rest] = process.argv.slice(2);
const handler = COMMANDS[command];
if (!handler) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(command && command !== "help" && command !== "--help" ? 1 : 0);
}
try {
  await handler(rest);
} catch (error) {
  if (!(error instanceof CliError)) throw error;
  log(error.message);
  process.exitCode = 1;
}
