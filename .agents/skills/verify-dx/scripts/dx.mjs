#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(SKILL_DIR, "../../..");
const HOME = process.env.PARLOR_DX_HOME ?? join(homedir(), ".cache", "parlor-verify-dx");
const REGISTRY_DIR =
  process.env.PARLOR_DX_REGISTRY_DIR ??
  join(homedir(), "cychien", "parlor-dx", "registry");
const REGISTRY = "http://127.0.0.1:4873/";
const PUBLISHED = join(HOME, "published.json");
const PROJECTS = join(HOME, "projects");
const SERVER_PORT = 3000;
const DEV_TIMEOUT_MS = 120_000;

const USAGE = `dx: drive Parlor the way a developer outside the repo does

  dx registry                     start the local Verdaccio registry if it is down
  dx publish [--no-build]         build the workspace and publish every public package
                                  at a fresh version 0.0.0-dx.<stamp>
  dx version                      print the last published version
  dx new <name> [--fixture <f>]   make an empty project folder with its own HOME,
                                  optionally filled from fixtures/<f>
  dx run <name> -- <cmd...>       run a command in the project, isolated
  dx up <name> [--pm pnpm|npm]    start the dev script, wait until the page and the
                                  server answer, print JSON
  dx down <name>                  stop the dev script
  dx path <name>                  print the project and HOME folders
  dx rm <name>                    stop and delete the project

Root: ${HOME} (PARLOR_DX_HOME). Registry: ${REGISTRY} from ${REGISTRY_DIR}.`;

function fail(message) {
  process.stderr.write(`dx: ${message}\n`);
  process.exit(1);
}

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited ${result.status}`);
  return result;
}

async function registryUp() {
  try {
    return (await fetch(`${REGISTRY}-/ping`)).ok;
  } catch {
    return false;
  }
}

async function ensureRegistry() {
  if (await registryUp()) return;
  sh("sh", [join(REGISTRY_DIR, "start.sh")]);
  for (let i = 0; i < 60; i += 1) {
    if (await registryUp()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`the registry at ${REGISTRY} did not start; see ${REGISTRY_DIR}/verdaccio.out`);
}

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
}

function publicPackages() {
  return readdirSync(join(REPO, "packages"))
    .map((dir) => ({ dir, manifest: join(REPO, "packages", dir, "package.json") }))
    .filter(({ manifest }) => existsSync(manifest))
    .map(({ dir, manifest }) => ({
      dir,
      json: JSON.parse(readFileSync(manifest, "utf8")),
    }))
    .filter(({ json }) => !json.private);
}

async function publish(args) {
  await ensureRegistry();
  if (!args.includes("--no-build")) sh("pnpm", ["build"], { cwd: REPO });
  const version = `0.0.0-dx.${stamp()}`;
  const stage = join(HOME, "stage", version);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "packages"), { recursive: true });
  const packages = publicPackages();
  for (const { dir, json } of packages) {
    const target = join(stage, "packages", dir);
    cpSync(join(REPO, "packages", dir), target, {
      recursive: true,
      filter: (source) => !/[/\\](node_modules|\.parlor)$/.test(source),
    });
    writeFileSync(
      join(target, "package.json"),
      `${JSON.stringify({ ...json, version }, null, 2)}\n`,
    );
  }
  const workspace = readFileSync(join(REPO, "pnpm-workspace.yaml"), "utf8");
  writeFileSync(
    join(stage, "pnpm-workspace.yaml"),
    workspace.replace(/^packages:\n(?: {2}- .*\n)+/m, "packages:\n  - packages/*\n"),
  );
  writeFileSync(
    join(stage, "package.json"),
    `${JSON.stringify({ name: "parlor-dx-stage", private: true }, null, 2)}\n`,
  );
  cpSync(join(REPO, "pnpm-lock.yaml"), join(stage, "pnpm-lock.yaml"));
  sh(
    "pnpm",
    ["install", "--prefer-offline", "--ignore-scripts", "--no-frozen-lockfile"],
    {
      cwd: stage,
    },
  );
  sh(
    "pnpm",
    [
      "-r",
      "publish",
      "--registry",
      REGISTRY,
      "--no-git-checks",
      "--ignore-scripts",
      "--tag",
      "dx",
    ],
    {
      cwd: stage,
      env: { ...process.env, NPM_CONFIG_USERCONFIG: join(REGISTRY_DIR, "publish.npmrc") },
    },
  );
  const record = {
    version,
    at: new Date().toISOString(),
    commit: spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO,
      encoding: "utf8",
    }).stdout.trim(),
    dirty:
      spawnSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" })
        .stdout !== "",
    packages: packages.map(({ json }) => json.name),
  };
  writeFileSync(PUBLISHED, `${JSON.stringify(record, null, 2)}\n`);
  rmSync(stage, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

function publishedVersion() {
  if (!existsSync(PUBLISHED)) fail("nothing published yet; run dx publish");
  return JSON.parse(readFileSync(PUBLISHED, "utf8")).version;
}

function project(name) {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name))
    fail(`bad project name "${name ?? ""}"`);
  const root = join(PROJECTS, name);
  return {
    root,
    app: join(root, "app"),
    home: join(root, "home"),
    state: join(root, "dev.json"),
  };
}

function substitute(dir, version) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) substitute(path, version);
    else if (entry.name === "package.json") {
      writeFileSync(path, readFileSync(path, "utf8").replaceAll("{{VERSION}}", version));
    }
  }
}

function create(name, args) {
  const { root, app, home } = project(name);
  if (existsSync(root)) fail(`${root} exists; dx rm ${name} first`);
  mkdirSync(app, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(app, ".npmrc"), `registry=${REGISTRY}\n`);
  const fixture = flag(args, "--fixture");
  if (fixture) {
    const source = join(SKILL_DIR, "fixtures", fixture);
    if (!existsSync(source)) fail(`no fixture ${fixture}`);
    cpSync(source, app, { recursive: true });
    substitute(app, publishedVersion());
  }
  process.stdout.write(`${JSON.stringify({ app, home }, null, 2)}\n`);
}

function flag(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

const INHERITED = /^(npm_|PNPM_|pnpm_|NODE_OPTIONS$|VITEST|PARLOR_|INIT_CWD$|COREPACK_)/i;

function isolatedEnv(home) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !INHERITED.test(key)),
  );
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    npm_config_registry: REGISTRY,
    npm_config_cache: join(HOME, "npm-cache"),
    pnpm_config_store_dir: join(HOME, "pnpm-store"),
    npm_config_update_notifier: "false",
  };
}

function run(name, args) {
  const { app, home } = project(name);
  if (!existsSync(app)) fail(`no project ${name}`);
  const command = args[0] === "--" ? args.slice(1) : args;
  if (command.length === 0) fail("dx run <name> -- <cmd...>");
  const result = spawnSync(command[0], command.slice(1), {
    cwd: app,
    env: isolatedEnv(home),
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

function portFreeOn(port, host) {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen(port, host, () => server.close(() => resolvePort(true)));
  });
}

async function portFree(port) {
  for (const host of ["127.0.0.1", "::1", "::"]) {
    if (!(await portFreeOn(port, host))) return false;
  }
  return true;
}

async function freePort(from) {
  for (let port = from; port < from + 100; port += 1) {
    if (await portFree(port)) return port;
  }
  fail(`no free port from ${from}`);
}

async function answers(url, init) {
  try {
    const response = await fetch(url, init);
    return response.status < 500;
  } catch {
    return false;
  }
}

async function up(name, args) {
  const { app, home, state } = project(name);
  if (!existsSync(app)) fail(`no project ${name}`);
  if (existsSync(state)) fail(`${name} is already up; dx down ${name}`);
  if (!(await portFree(SERVER_PORT))) {
    fail(
      `port ${SERVER_PORT} is in use; a project server needs it (server.port default)`,
    );
  }
  const pm = flag(args, "--pm") ?? "pnpm";
  const webPort = await freePort(5173);
  const devArgs =
    pm === "npm"
      ? ["run", "dev", "--", "--port", String(webPort)]
      : ["dev", "--port", String(webPort)];
  const log = join(project(name).root, "dev.log");
  const out = openSync(log, "w");
  const child = spawn(pm, devArgs, {
    cwd: app,
    env: isolatedEnv(home),
    detached: true,
    stdio: ["ignore", out, out],
  });
  const web = `http://localhost:${webPort}`;
  const started = Date.now();
  let exited;
  child.once("exit", (code) => (exited = code));
  while (Date.now() - started < DEV_TIMEOUT_MS) {
    if (exited !== undefined) {
      fail(
        `${pm} ${devArgs.join(" ")} exited ${exited}:\n${readFileSync(log, "utf8").slice(-4000)}`,
      );
    }
    if (
      (await answers(`${web}/`)) &&
      (await answers(`http://localhost:${SERVER_PORT}/_parlor/manifest`))
    ) {
      const record = {
        pid: child.pid,
        pm,
        web,
        server: `http://localhost:${SERVER_PORT}`,
        log,
        readyMs: Date.now() - started,
      };
      writeFileSync(state, `${JSON.stringify(record, null, 2)}\n`);
      child.unref();
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  fail(
    `not ready after ${DEV_TIMEOUT_MS} ms:\n${readFileSync(log, "utf8").slice(-4000)}`,
  );
}

async function down(name) {
  const { state } = project(name);
  if (!existsSync(state)) return;
  const { pid } = JSON.parse(readFileSync(state, "utf8"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-pid, signal);
    } catch {
      break;
    }
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        process.kill(-pid, 0);
      } catch {
        rmSync(state);
        return;
      }
    }
  }
  rmSync(state, { force: true });
}

const [command, name, ...rest] = process.argv.slice(2);
switch (command) {
  case "registry":
    await ensureRegistry();
    process.stdout.write(`${REGISTRY}\n`);
    break;
  case "publish":
    await publish([name, ...rest].filter(Boolean));
    break;
  case "version":
    process.stdout.write(`${publishedVersion()}\n`);
    break;
  case "new":
    create(name, rest);
    break;
  case "run":
    run(name, rest);
    break;
  case "up":
    await up(name, rest);
    break;
  case "down":
    await down(name);
    break;
  case "path":
    process.stdout.write(`${JSON.stringify(project(name), null, 2)}\n`);
    break;
  case "rm":
    await down(name);
    rmSync(project(name).root, { recursive: true, force: true });
    break;
  default:
    process.stdout.write(`${USAGE}\n`);
    process.exit(command === undefined || command === "--help" ? 0 : 1);
}
