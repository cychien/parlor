import type { AgentAsk } from "./acp.js";

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
  void ask;
  void appServer;
  throw new Error("not implemented");
}

/** The ask item's `approval`; `undefined` lets any trusted device answer without presence. */
export function approvalFor(
  policy: RemotePolicy,
  ask: AgentAsk,
): "presence" | "computer" | undefined {
  // TODO: a question or answers "off" -> undefined; else policy.answers.
  void policy;
  void ask;
  throw new Error("not implemented");
}
