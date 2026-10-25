import type { AgentAsk } from "./acp.js";
import { jsonFile } from "./json-file.js";
import type { TrustedDevice } from "./trust.js";

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
  /**
   * How long a linked device with Face ID or Touch ID sends before its next prompt needs them
   * again. Absent: never.
   */
  readonly promptPresence?: { readonly maxAgeHours: number } | "off" | undefined;
  /**
   * `auto`: the agent's own safety review decides, asking only for what it flags, where the
   * agent has one. `ask`: it asks before every action. Absent: `auto`.
   */
  readonly agentMode?: "auto" | "ask" | undefined;
}

export const DEFAULT_POLICY: RemotePolicy = {
  deviceApproval: "local",
  answers: "presence",
  promptPresence: { maxAgeHours: 18 },
  agentMode: "auto",
};

export const DEV_POLICY: RemotePolicy = {
  deviceApproval: "off",
  answers: "off",
  promptPresence: "off",
  agentMode: "auto",
};

/** When `device`'s prompts need Face ID or Touch ID again; undefined when they never do. */
export function presenceDueAt(
  policy: RemotePolicy,
  device: TrustedDevice,
): number | undefined {
  const setting = policy.promptPresence;
  if (setting === undefined || setting === "off" || !device.presenceKey) return undefined;
  return (device.presenceAt ?? device.approvedAt) + setting.maxAgeHours * 3_600_000;
}

/**
 * The app's own tools are allowed once without asking: the server already enforces the
 * app's `confirm: true`, and asking twice only teaches users to click through.
 */
export function isAppTool(ask: AgentAsk, appServer: string): boolean {
  return ask.kind === "permission" && ask.mcp?.server === appServer;
}

/**
 * The ask item's `approval`; `undefined` lets any trusted device answer without presence.
 * Where presence is wanted, the browser that approved `connect` here answers its own turn's
 * asks in the chat, since the loopback redirect put it on this computer; any other device
 * without presence leaves them to this computer.
 */
export function approvalFor(
  policy: RemotePolicy,
  ask: AgentAsk,
  device?: Pick<TrustedDevice, "presenceKey" | "via">,
): "presence" | "computer" | "device" | undefined {
  if (ask.kind === "question" || policy.answers === "off") return undefined;
  if (policy.answers === "computer" || !device || device.presenceKey)
    return policy.answers;
  return device.via === "pairing" ? "device" : "computer";
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
    promptPresence: promptPresenceOf(overlay.promptPresence, base.promptPresence),
    agentMode: choose(
      ["auto", "ask"] as const,
      overlay.agentMode,
      base.agentMode ?? "auto",
    ),
  };
}

function promptPresenceOf(
  value: unknown,
  base: RemotePolicy["promptPresence"],
): RemotePolicy["promptPresence"] {
  if (value === "off") return "off";
  const hours = (value as { readonly maxAgeHours?: unknown } | null)?.maxAgeHours;
  return typeof hours === "number" && Number.isFinite(hours) && hours > 0
    ? { maxAgeHours: hours }
    : base;
}

export async function changePolicy(
  file: string,
  base: RemotePolicy,
  change: Partial<RemotePolicy>,
): Promise<RemotePolicy> {
  await jsonFile<Overlay>(file).change((overlay) => Object.assign(overlay, change));
  return loadPolicy(file, base);
}
