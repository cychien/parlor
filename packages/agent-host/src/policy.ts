import type { AgentAsk } from "./acp.js";
import { jsonFile } from "./json-file.js";

/**
 * What this computer enforces on remote turns, whatever the app or its backend says. Set
 * only on this computer (`parlor-host config` or the Mac app's settings).
 */
export interface RemotePolicy {
  /** `local`: an untrusted device is approved in a dialog here before its first prompt runs. */
  readonly deviceApproval: "local" | "off";
  /**
   * Where an answer to the agent's own permission prompts counts: on any trusted device
   * with presence, only on this computer, or (`parlor dev` only) anywhere.
   */
  readonly answers: "presence" | "computer" | "off";
}

export const DEFAULT_POLICY: RemotePolicy = {
  deviceApproval: "local",
  answers: "presence",
};

export const DEV_POLICY: RemotePolicy = { deviceApproval: "off", answers: "off" };

/**
 * The app's own tools are allowed once without asking: the server already enforces the
 * app's `confirm: true`, and asking twice only teaches users to click through.
 */
export function isAppTool(ask: AgentAsk, appServer: string): boolean {
  return ask.kind === "permission" && ask.mcp?.server === appServer;
}

/** The ask item's `approval`; `undefined` lets any trusted device answer without presence. */
export function approvalFor(
  policy: RemotePolicy,
  ask: AgentAsk,
): "presence" | "computer" | undefined {
  if (ask.kind === "question" || policy.answers === "off") return undefined;
  return policy.answers;
}

type Overlay = { readonly [K in keyof RemotePolicy]?: unknown };

const choose = <T extends string>(allowed: readonly T[], value: unknown, base: T): T =>
  allowed.find((candidate) => candidate === value) ?? base;

/** `base` with the settings `parlor-host config` wrote to `file`; read afresh on every call. */
export async function loadPolicy(
  file: string,
  base: RemotePolicy,
): Promise<RemotePolicy> {
  let overlay: Overlay;
  try {
    overlay = await jsonFile<Overlay>(file).read();
  } catch {
    return base;
  }
  return {
    deviceApproval: choose(["local", "off"], overlay.deviceApproval, base.deviceApproval),
    answers: choose(["presence", "computer", "off"], overlay.answers, base.answers),
  };
}

export async function changePolicy(
  file: string,
  base: RemotePolicy,
  change: Partial<RemotePolicy>,
): Promise<RemotePolicy> {
  await jsonFile<Overlay>(file).change((overlay) => Object.assign(overlay, change));
  return loadPolicy(file, base);
}
