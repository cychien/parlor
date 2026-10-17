import type { z } from "zod";

import type { AgentOrigin, ClientSummary, ScreenSnapshot } from "../protocol.js";
import type { UiBroker } from "./broker.js";
import type { ClientDirectory } from "./directory.js";

export const UI_TOOLS = ["ui_screen"] as const;
export type UiToolName = (typeof UI_TOOLS)[number];

export interface AgentToolContext {
  readonly scope: string;
  readonly clientId?: string | undefined;
  readonly origin: AgentOrigin;
  readonly signal?: AbortSignal | undefined;
  readonly webOrigin?: string | undefined;
}

export interface AgentTool<I extends z.ZodObject = z.ZodObject> {
  readonly name: UiToolName;
  readonly description: string;
  readonly input: I;
  readonly readOnly: boolean;
  run(input: z.output<I>, ctx: AgentToolContext): Promise<unknown>;
}

export interface ScreenToolResult extends ScreenSnapshot {
  readonly client: ClientSummary;
  readonly otherClients: readonly ClientSummary[];
  readonly tiedWith?: readonly string[] | undefined;
}

export interface UnreachableResult {
  readonly reachable: false;
  readonly reason: "no_client";
  readonly href?: string | undefined;
}

export interface UiToolDeps {
  readonly directory: ClientDirectory;
  readonly broker: UiBroker;
}

export function createUiTools(deps: UiToolDeps): readonly AgentTool[] {
  void deps;
  throw new Error("not implemented");
}

export function uiInstructions(): string {
  throw new Error("not implemented");
}
