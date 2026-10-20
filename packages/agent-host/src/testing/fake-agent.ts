import type { AcpStdio, StopReason, ToolKind } from "../acp.js";
import type { AgentProfile } from "../agents.js";

/**
 * A scripted agent on the real ACP transport (through `serveAcpAgent`), so the adapter,
 * fold, permission, cancel and MCP proxy paths are tested as Claude Code and Codex drive
 * them. A prompt's text names the step list to play.
 */
export interface FakeAgentScript {
  readonly advertise?:
    | { readonly resume?: boolean | undefined; readonly mcpHttp?: boolean | undefined }
    | undefined;
  readonly steps: Readonly<Record<string, readonly FakeStep[]>>;
  /** For a prompt no step names: reply with it. */
  readonly fallback?: "echo" | undefined;
}

export type FakeStep =
  | {
      readonly kind: "reply";
      readonly chunks: readonly string[];
      readonly perSecond?: number;
    }
  | { readonly kind: "thought"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly title: string;
      readonly toolKind: ToolKind;
      readonly mcp?: { readonly server: string; readonly tool: string } | undefined;
      readonly askPermission: boolean;
    }
  /** Calls an app tool through the MCP server the host passed in `session/new`. */
  | { readonly kind: "call_app"; readonly tool: string; readonly input: unknown }
  | { readonly kind: "plan"; readonly entries: readonly string[] }
  | { readonly kind: "wait_for_cancel" }
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "stop"; readonly reason: Exclude<StopReason, "cancelled"> };

/** The fixture's entry point: serves `script` on `io` (the process's stdio). */
export function serveFakeAgent(script: FakeAgentScript, io: AcpStdio): Promise<void> {
  // TODO: serveAcpAgent(handlers built from script, io).
  void script;
  void io;
  throw new Error("not implemented");
}

/** A profile that launches the fixture at `entry` with `scriptFile`. */
export function fakeAgentProfile(entry: string, scriptFile: string): AgentProfile {
  void entry;
  void scriptFile;
  throw new Error("not implemented");
}
