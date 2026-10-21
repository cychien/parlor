import { spawn } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProtocolRange } from "@parlor/chat";

import { connectControl } from "./control.js";
import { withFileLock } from "./lock.js";
import type { HostPaths } from "./paths.js";
import {
  compareVersions,
  RELEASE_KEY,
  type ReleaseSignature,
  sha256File,
  signedRelease,
} from "./release.js";
import { selfInvocation } from "./self.js";

export interface HostRelease {
  readonly version: string;
  /** Host protocols it speaks with app backends. */
  readonly protocols: ProtocolRange;
  /** The control protocol it speaks with CLIs and desktop sidecars. */
  readonly control: number;
}

export type ServiceClient =
  | { readonly kind: "cli"; readonly release: HostRelease }
  | {
      readonly kind: "desktop-sidecar";
      readonly app: string;
      readonly release: HostRelease;
      /** The bundled binary, copied in when newer than what is installed. */
      readonly binary: string;
      /** Its `.sig`, `<binary>.sig` when the bundle keeps them together. */
      readonly signature?: string;
    };

export type AdoptOutcome =
  | { readonly kind: "using"; readonly running: HostRelease }
  | { readonly kind: "installed"; readonly release: HostRelease }
  /** The old service handed its links over; its running turns finish under it. */
  | { readonly kind: "upgraded"; readonly from: HostRelease; readonly to: HostRelease }
  | {
      readonly kind: "refused";
      readonly reason: "unsigned" | "downgrade" | "legacy_service";
      readonly running?: HostRelease;
    };

export type Situation =
  | { readonly service: "absent"; readonly installed: boolean }
  | { readonly service: "legacy" }
  | { readonly service: "running"; readonly running: HostRelease };

type Sidecar = Extract<ServiceClient, { readonly kind: "desktop-sidecar" }>;

export type Action =
  | { readonly do: "start_installed" }
  | { readonly do: "spawn_self" }
  | { readonly do: "install_bundled"; readonly client: Sidecar }
  | { readonly do: "refuse_legacy" }
  | { readonly do: "use"; readonly running: HostRelease }
  | { readonly do: "refuse_downgrade"; readonly running: HostRelease }
  | { readonly do: "hand_over"; readonly client: Sidecar; readonly running: HostRelease };

export function actionFor(situation: Situation, client: ServiceClient): Action {
  switch (situation.service) {
    case "legacy":
      return { do: "refuse_legacy" };
    case "absent":
      if (situation.installed) return { do: "start_installed" };
      return client.kind === "cli"
        ? { do: "spawn_self" }
        : { do: "install_bundled", client };
    case "running": {
      const { running } = situation;
      if (client.kind === "cli") return { do: "use", running };
      const order = compareVersions(client.release.version, running.version);
      if (order > 0) return { do: "hand_over", client, running };
      return order === 0 ? { do: "use", running } : { do: "refuse_downgrade", running };
    }
  }
}

export interface ServiceDeps {
  readonly releaseKey: string | undefined;
  readonly readyMs: number;
  readonly pollMs: number;
  readonly start?:
    | ((paths: HostPaths, command: string, args: readonly string[]) => Promise<void>)
    | undefined;
}

const DEFAULTS: ServiceDeps = { releaseKey: RELEASE_KEY, readyMs: 15_000, pollMs: 100 };

const startWith = (deps: ServiceDeps) => deps.start ?? spawnService;
const SERVICE_BINARY = "parlor-host";
const SIGNATURE_FILE = "parlor-host.sig";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function observe(paths: HostPaths, client: ServiceClient): Promise<Situation> {
  const control = await connectControl(paths.control);
  if (!control) {
    return {
      service: "absent",
      installed: await exists(join(paths.current, SERVICE_BINARY)),
    };
  }
  const reply = await control.send({ op: "hello", client });
  control.close();
  return reply.ok
    ? { service: "running", running: reply.release }
    : { service: "legacy" };
}

async function spawnService(
  paths: HostPaths,
  command: string,
  args: readonly string[],
): Promise<void> {
  await mkdir(paths.logs, { recursive: true, mode: 0o700 });
  const output = await open(join(paths.logs, "daemon.out"), "a", 0o600);
  const child = spawn(command, args, {
    cwd: paths.root,
    detached: true,
    stdio: ["ignore", output.fd, output.fd],
    env: process.env,
  });
  child.unref();
  await output.close();
}

async function untilRunning(
  paths: HostPaths,
  client: ServiceClient,
  deps: ServiceDeps,
  ready: (running: HostRelease) => boolean = () => true,
): Promise<HostRelease> {
  for (const deadline = Date.now() + deps.readyMs; Date.now() < deadline;) {
    const situation = await observe(paths, client);
    if (situation.service === "running" && ready(situation.running)) {
      return situation.running;
    }
    await sleep(deps.pollMs);
  }
  throw new Error(`Parlor Host did not start; see ${join(paths.logs, "daemon.out")}.`);
}

/**
 * Copies a verified binary into `versions/<version>/` and repoints `current`, each step
 * atomic and repeatable; false when the copy is not the binary the signature describes.
 */
export async function installRelease(
  paths: HostPaths,
  source: { readonly binary: string; readonly signature: string },
  release: ReleaseSignature,
): Promise<boolean> {
  const target = join(paths.versions, release.version);
  const installed = join(target, SERVICE_BINARY);
  const present = (await sha256File(installed).catch(() => undefined)) === release.sha256;
  if (!present) {
    const staged = join(paths.versions, `.${release.version}.tmp-${process.pid}`);
    await rm(staged, { recursive: true, force: true });
    await mkdir(staged, { recursive: true, mode: 0o700 });
    await copyFile(source.binary, join(staged, SERVICE_BINARY));
    await chmod(join(staged, SERVICE_BINARY), 0o755);
    await copyFile(source.signature, join(staged, SIGNATURE_FILE));
    if ((await sha256File(join(staged, SERVICE_BINARY))) !== release.sha256) {
      await rm(staged, { recursive: true, force: true });
      return false;
    }
    await rm(target, { recursive: true, force: true });
    await rename(staged, target);
  }
  const link = `${paths.current}.tmp-${process.pid}`;
  await rm(link, { force: true });
  await symlink(join("versions", release.version), link);
  await rename(link, paths.current);
  return true;
}

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** LaunchAgent, systemd user unit or Task Scheduler, pointing at `paths.current`. */
export async function installLoginItem(paths: HostPaths): Promise<void> {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.parlor.host</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(join(paths.current, SERVICE_BINARY))}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(paths.logs, "daemon.out"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(paths.logs, "daemon.out"))}</string>
</dict>
</plist>
`;
  await mkdir(dirname(paths.launchAgent), { recursive: true });
  const staged = `${paths.launchAgent}.${process.pid}.tmp`;
  await writeFile(staged, plist, { mode: 0o644 });
  await rename(staged, paths.launchAgent);
}

async function installBundled(
  paths: HostPaths,
  client: Sidecar,
  deps: ServiceDeps,
): Promise<AdoptOutcome> {
  const source = {
    binary: client.binary,
    signature: client.signature ?? `${client.binary}.sig`,
  };
  const release = await signedRelease(source.binary, source.signature, deps.releaseKey);
  if (
    !release ||
    release.version !== client.release.version ||
    !(await installRelease(paths, source, release))
  ) {
    return { kind: "refused", reason: "unsigned" };
  }
  await installLoginItem(paths);
  await startWith(deps)(paths, join(paths.current, SERVICE_BINARY), ["daemon"]);
  return { kind: "installed", release: await untilRunning(paths, client, deps) };
}

async function handOver(
  paths: HostPaths,
  client: Sidecar,
  running: HostRelease,
  deps: ServiceDeps,
): Promise<AdoptOutcome> {
  const control = await connectControl(paths.control);
  if (!control) throw new Error("Parlor Host stopped answering during the upgrade.");
  const reply = await control.send({
    op: "handover",
    binary: client.binary,
    signature: client.signature ?? `${client.binary}.sig`,
  });
  control.close();
  if (!reply.ok) {
    return reply.error === "unsigned" || reply.error === "downgrade"
      ? { kind: "refused", reason: reply.error, running }
      : (() => {
          throw new Error(reply.error);
        })();
  }
  await startWith(deps)(paths, join(paths.current, SERVICE_BINARY), ["daemon"]);
  const to = await untilRunning(
    paths,
    client,
    deps,
    (release) => compareVersions(release.version, running.version) > 0,
  );
  return { kind: "upgraded", from: running, to };
}

/**
 * Leaves exactly one per-user service running, the newest: adopt, install or upgrade.
 * Only binaries signed by the Parlor release key, never a downgrade; installs hold a lock
 * under `paths.root`, so two apps can run it at once.
 */
export async function ensureServiceWith(
  deps: ServiceDeps,
  paths: HostPaths,
  client: ServiceClient,
): Promise<AdoptOutcome> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  return withFileLock(paths.lock, async () => {
    for (;;) {
      const action = actionFor(await observe(paths, client), client);
      switch (action.do) {
        case "refuse_legacy":
          return { kind: "refused", reason: "legacy_service" };
        case "use":
          return { kind: "using", running: action.running };
        case "refuse_downgrade":
          return { kind: "refused", reason: "downgrade", running: action.running };
        case "hand_over":
          return handOver(paths, action.client, action.running, deps);
        case "install_bundled":
          return installBundled(paths, action.client, deps);
        case "start_installed":
          await startWith(deps)(paths, join(paths.current, SERVICE_BINARY), ["daemon"]);
          await untilRunning(paths, client, deps);
          continue;
        case "spawn_self": {
          const self = selfInvocation(["daemon"]);
          await startWith(deps)(paths, self.command, self.args);
          return { kind: "installed", release: await untilRunning(paths, client, deps) };
        }
      }
    }
  });
}

export function ensureService(
  paths: HostPaths,
  client: ServiceClient,
): Promise<AdoptOutcome> {
  return ensureServiceWith(DEFAULTS, paths, client);
}
