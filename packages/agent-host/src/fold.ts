import type { HostFrame, HostItemDraft } from "@parlor/chat";
import type { TurnId } from "@parlor/core";

import type { AgentUpdate } from "./acp.js";

interface OpenText {
  readonly id: string;
  readonly kind: "reply" | "reasoning";
  readonly text: string;
}

interface OpenTool {
  readonly id: string;
  readonly title: string;
  readonly app: boolean;
  readonly name: string;
}

export interface TurnFold {
  readonly turnId: TurnId;
  readonly open: OpenText | undefined;
  readonly tools: ReadonlyMap<string, OpenTool>;
  readonly plan: Extract<AgentUpdate, { kind: "plan" }>["entries"] | undefined;
  readonly nextId: number;
}

export interface FoldStep {
  readonly fold: TurnFold;
  /** Ephemeral, streamed now. */
  readonly frames: readonly HostFrame[];
  /** Finished, appended durably. */
  readonly closed: readonly HostItemDraft[];
}

/** Pure: knows no ACP, HTTP or time. Item ids are `<turnId>.<n>`. */
export function startFold(turnId: TurnId): TurnFold {
  void turnId;
  throw new Error("not implemented");
}

/** `appServer` is the MCP server name the host gave the agent for this app. */
export function foldUpdate(
  fold: TurnFold,
  update: AgentUpdate,
  appServer: string,
): FoldStep {
  // TODO: text/thought grows the open item of its kind (delta at the old length), another
  //   kind closes it first; tool_start closes open text and opens a tool (item frame
  //   pending); tool_update completed/failed closes it (tool draft; `app` when mcp.server
  //   === appServer); plan -> item frame; mode -> nothing.
  void fold;
  void update;
  void appServer;
  throw new Error("not implemented");
}

/** Closes what is open; `interrupted` marks the last reply when the user stopped the turn. */
export function finishFold(fold: TurnFold, interrupted: boolean): FoldStep {
  void fold;
  void interrupted;
  throw new Error("not implemented");
}
