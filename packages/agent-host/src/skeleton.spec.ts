import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compact, differences, type Difference } from "./skeleton-kit.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY = join(PACKAGE, "..", "..");
const SDK_IMPORT =
  /from\s+["']@agentclientprotocol\/sdk["']|import\(\s*["']@agentclientprotocol\/sdk["']/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mts|mjs|js)$/.test(name) ? [path] : [];
  });
}

describe("the phase 4 skeleton contract", () => {
  it("K4: acp.ts is the only file that imports the ACP SDK", () => {
    const importers = ["packages", "examples"]
      .flatMap((root) => sources(join(REPOSITORY, root)))
      .filter((file) => SDK_IMPORT.test(readFileSync(file, "utf8")))
      .map((file) => relative(REPOSITORY, file));
    expect(importers).toEqual(["packages/agent-host/src/acp.ts"]);
  });

  it("K4: policy.spec-d.ts holds under the type checker", () => {
    const tsc = join(PACKAGE, "node_modules", ".bin", "tsc");
    expect(() =>
      execFileSync(tsc, ["-p", "tsconfig.spec.json", "--noEmit"], {
        cwd: PACKAGE,
        stdio: "pipe",
      }),
    ).not.toThrow();
  }, 60_000);
});

const SKELETON: Readonly<Record<string, string>> = JSON.parse(
  readFileSync(join(PACKAGE, "src", "testing", "skeleton-phase5.json"), "utf8"),
);

const skeleton = (file: string) => {
  const text = SKELETON[file];
  if (text === undefined) throw new Error(`The skeleton fixture has no ${file}.`);
  return text;
};

const source = (file: string) => readFileSync(join(REPOSITORY, file), "utf8");

function drift(file: string, only?: readonly string[]): Difference[] {
  return differences(file, skeleton(file), source(file), only);
}

const DIFFERENCES: Readonly<
  Record<string, { readonly agreed: boolean; readonly why: string }>
> = {
  "chat/src/model.ts TurnStatus changed": {
    agreed: true,
    why: "addendum D9: the failure the sidebar shows",
  },
  "auth/src/client/index.ts AuthClientOptions changed": {
    agreed: true,
    why: "`deviceKey` injects the keys, as `session` injects the session store",
  },
  "agent-host/src/policy.ts changePolicy added": {
    agreed: true,
    why: "addendum D7: `parlor-host config` writes policy.json",
  },
  "agent-host/src/policy.ts loadPolicy added": {
    agreed: true,
    why: "addendum D7: the overlay read at the start of each turn",
  },
  "agent-host/src/prompter.ts LocalPrompter changed": {
    agreed: true,
    why: "addendum D8: `signal` closes a dialog whose turn ended",
  },
};

describe("the phase 5 skeleton contract", () => {
  it("K5: every file this phase implements keeps the skeleton's exported signatures, but for the differences listed here", () => {
    const found = [
      ...drift("packages/auth/src/statements.ts"),
      ...drift("packages/auth/src/devices.ts"),
      ...drift("packages/auth/src/client/index.ts", [
        "DeviceHandle",
        "AuthClient",
        "AuthClientOptions",
      ]),
      ...drift("packages/capabilities/src/device-key/interface.ts"),
      ...drift("packages/capabilities/src/device-key/index.ts"),
      ...drift("packages/capabilities/src/device-key/web.ts"),
      ...drift("packages/capabilities/src/device-key/tauri.ts"),
      ...drift("packages/capabilities/src/device-key/capacitor.ts"),
      ...drift("packages/server/src/auth.ts", [
        "DeviceKeys",
        "PresenceKey",
        "AccountProfile",
      ]),
      ...drift("packages/client/src/session.ts", [
        "SessionDevice",
        "DeviceSource",
        "HostAuthorizer",
        "FrameworkAuth",
      ]),
      ...drift("packages/agent-host/src/trust.ts"),
      ...drift("packages/agent-host/src/policy.ts"),
      ...drift("packages/agent-host/src/prompter.ts", [
        "LocalPrompter",
        "terminalPrompter",
        "macDialogPrompter",
      ]),
      ...drift("packages/agent-host/src/turn.ts", [
        "PROMPT_MAX_AGE_MS",
        "TurnDeps",
        "runTurn",
      ]),
      ...drift("packages/agent-host/src/daemon.ts", ["DaemonDeps"]),
      ...drift("packages/chat/src/model.ts", ["TurnStatus"]),
    ].map(
      ({ file, symbol, kind }) =>
        `${file.split("/").slice(1).join("/")} ${symbol} ${kind}`,
    );
    expect(found.sort()).toEqual(Object.keys(DIFFERENCES).sort());
  });

  it("K5: device-key.spec-d.ts is the skeleton's, unchanged, and holds under the type checker", () => {
    const file = "packages/capabilities/src/device-key/device-key.spec-d.ts";
    expect(compact(source(file))).toBe(compact(skeleton(file)));
    const capabilities = join(REPOSITORY, "packages", "capabilities");
    expect(() =>
      execFileSync(
        join(capabilities, "node_modules", ".bin", "tsc"),
        ["-p", "tsconfig.spec.json", "--noEmit"],
        {
          cwd: capabilities,
          stdio: "pipe",
        },
      ),
    ).not.toThrow();
  }, 60_000);
});

const SKELETON_6: Readonly<Record<string, string>> = JSON.parse(
  readFileSync(join(PACKAGE, "src", "testing", "skeleton-phase6.json"), "utf8"),
);

function drift6(file: string, only?: readonly string[]): Difference[] {
  const text = SKELETON_6[file];
  if (text === undefined) throw new Error(`The skeleton fixture has no ${file}.`);
  return differences(file, text, source(file), only);
}

const DIFFERENCES_6: Readonly<
  Record<string, { readonly agreed: boolean; readonly why: string }>
> = {
  "agent-host/src/service.ts AdoptOutcome changed": {
    agreed: true,
    why: "spec 8.6: a signature mismatch, a downgrade and a daemon without `hello` are outcomes, not throws",
  },
  "agent-host/src/control.ts ControlRequest changed": {
    agreed: true,
    why: "spec 8.6: `handover` carries the binary and signature, `confirm_local_pairing` is new",
  },
  "capabilities/src/local-agent-host/interface.ts LocalConnectInput changed": {
    agreed: true,
    why: "spec 8.6: the optional `device` is pinned at pairing",
  },
  "capabilities/src/local-agent-host/interface.ts PairingDevice added": {
    agreed: true,
    why: "spec 8.6: the app's own device keys, carried by `LocalConnectInput` and the control protocol",
  },
  "capabilities/src/local-agent-host/interface.ts PairingPresenceKey added": {
    agreed: true,
    why: "spec 8.6: the registered presence key shape, so the capability needs no server import",
  },
};

describe("the phase 6 skeleton contract", () => {
  it("K6: every file this phase implements keeps the skeleton's exported signatures, but for the differences listed here", () => {
    const found = [
      ...drift6("packages/agent-host/src/service.ts"),
      ...drift6("packages/agent-host/src/control.ts"),
      ...drift6("packages/agent-host/src/pairing.ts", ["PairingChannel"]),
      ...drift6("packages/agent-host/src/daemon.ts", ["DaemonDeps", "HostDaemon"]),
      ...drift6("packages/capabilities/src/device-key/capacitor.ts"),
      ...drift6("packages/capabilities/src/device-key/tauri.ts"),
      ...drift6("packages/capabilities/src/local-agent-host/capacitor.ts"),
      ...drift6("packages/capabilities/src/local-agent-host/index.ts"),
      ...drift6("packages/capabilities/src/local-agent-host/interface.ts"),
      ...drift6("packages/capabilities/src/local-agent-host/tauri.ts"),
      ...drift6("packages/capabilities/src/local-agent-host/web.ts"),
      ...drift6("packages/shell-desktop/src/project.ts", [
        "AGENT_HOST_SIDECAR",
        "libRs",
        "stageAgentHost",
      ]),
      ...drift6("packages/shell-mobile/src/project.ts", ["DEVICE_KEY_PLUGIN"]),
      ...drift6("packages/client/src/react/chat/runtime.ts", ["ConnectOption"]),
    ].map(
      ({ file, symbol, kind }) =>
        `${file.split("/").slice(1).join("/")} ${symbol} ${kind}`,
    );
    expect(found.sort()).toEqual(Object.keys(DIFFERENCES_6).sort());
  });

  it("K6: use-chat.spec-d.ts still pins ConnectOption to command and here, under the type checker", () => {
    const client = join(REPOSITORY, "packages", "client");
    expect(() =>
      execFileSync(
        join(client, "node_modules", ".bin", "tsc"),
        ["-p", "tsconfig.spec.json", "--noEmit"],
        { cwd: client, stdio: "pipe" },
      ),
    ).not.toThrow();
  }, 120_000);
});
