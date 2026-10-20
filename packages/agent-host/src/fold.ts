import type { ChatItemBody, HostFrame, HostItemDraft } from "@parlor/chat";
import { asId, type ItemId, type TurnId } from "@parlor/core";

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

const MAX_DETAIL_CHARS = 4_000;

type ToolFrameStatus = "pending" | "running";

const itemId = (id: string): ItemId => asId("item", id);

const entriesOf = (
  entries: Extract<AgentUpdate, { kind: "plan" }>["entries"],
): ChatItemBody<"plan">["entries"] => entries.map((entry) => ({ ...entry }));

const unchanged = (fold: TurnFold): FoldStep => ({ fold, frames: [], closed: [] });

const planItemOf = (fold: TurnFold) => itemId(`${fold.turnId}.0`);

function allocate(fold: TurnFold): { readonly id: string; readonly fold: TurnFold } {
  return {
    id: `${fold.turnId}.${fold.nextId}`,
    fold: { ...fold, nextId: fold.nextId + 1 },
  };
}

function closeText(fold: TurnFold, interrupted = false): FoldStep {
  const open = fold.open;
  if (!open) return unchanged(fold);
  const closed: HostItemDraft =
    open.kind === "reply"
      ? {
          id: itemId(open.id),
          kind: "reply",
          body: {
            text: open.text,
            ...(interrupted ? { interrupted: true as const } : {}),
          },
        }
      : { id: itemId(open.id), kind: "reasoning", body: { text: open.text } };
  return { fold: { ...fold, open: undefined }, frames: [], closed: [closed] };
}

function toolFrame(tool: OpenTool, status: ToolFrameStatus): HostFrame {
  return {
    type: "item",
    item: { id: itemId(tool.id), kind: "tool", title: tool.title, status },
  };
}

function toolDraft(
  tool: OpenTool,
  status: ChatItemBody<"tool">["status"],
  detail: string | undefined,
): HostItemDraft {
  return {
    id: itemId(tool.id),
    kind: "tool",
    body: {
      title: tool.title,
      tool: { kind: tool.app ? "app" : "local", name: tool.name },
      status,
      ...(detail ? { detail: detail.slice(0, MAX_DETAIL_CHARS) } : {}),
    },
  };
}

function withTool(fold: TurnFold, toolCallId: string, tool: OpenTool | undefined) {
  const tools = new Map(fold.tools);
  if (tool) tools.set(toolCallId, tool);
  else tools.delete(toolCallId);
  return { ...fold, tools };
}

function appendText(fold: TurnFold, kind: OpenText["kind"], text: string): FoldStep {
  if (text === "") return unchanged(fold);
  const switched =
    fold.open && fold.open.kind !== kind ? closeText(fold) : unchanged(fold);
  let current = switched.fold;
  let open = current.open;
  if (!open) {
    const next = allocate(current);
    current = next.fold;
    open = { id: next.id, kind, text: "" };
  }
  return {
    fold: { ...current, open: { ...open, text: open.text + text } },
    frames: [
      { type: "delta", itemId: itemId(open.id), kind, offset: open.text.length, text },
    ],
    closed: switched.closed,
  };
}

function startTool(
  fold: TurnFold,
  update: Extract<AgentUpdate, { kind: "tool_start" }>,
  appServer: string,
): FoldStep {
  const known = fold.tools.get(update.toolCallId);
  if (known) {
    const tool = { ...known, title: update.title || known.title };
    return {
      fold: withTool(fold, update.toolCallId, tool),
      frames: [toolFrame(tool, "pending")],
      closed: [],
    };
  }
  const text = closeText(fold);
  const next = allocate(text.fold);
  const tool: OpenTool = {
    id: next.id,
    title: update.title,
    app: update.mcp !== undefined && update.mcp.server === appServer,
    name: update.mcp?.tool ?? update.toolKind,
  };
  return {
    fold: withTool(next.fold, update.toolCallId, tool),
    frames: [toolFrame(tool, "pending")],
    closed: text.closed,
  };
}

function updateTool(
  fold: TurnFold,
  update: Extract<AgentUpdate, { kind: "tool_update" }>,
): FoldStep {
  const known = fold.tools.get(update.toolCallId);
  if (!known) return unchanged(fold);
  const tool = { ...known, title: update.title || known.title };
  if (update.status === "completed" || update.status === "failed") {
    return {
      fold: withTool(fold, update.toolCallId, undefined),
      frames: [],
      closed: [
        toolDraft(tool, update.status === "completed" ? "done" : "failed", update.detail),
      ],
    };
  }
  return {
    fold: withTool(fold, update.toolCallId, tool),
    frames: [toolFrame(tool, update.status === "in_progress" ? "running" : "pending")],
    closed: [],
  };
}

/** Pure: knows no ACP, HTTP or time. Item ids are `<turnId>.<n>`. */
export function startFold(turnId: TurnId): TurnFold {
  return { turnId, open: undefined, tools: new Map(), plan: undefined, nextId: 1 };
}

/** `appServer` is the MCP server name the host gave the agent for this app. */
export function foldUpdate(
  fold: TurnFold,
  update: AgentUpdate,
  appServer: string,
): FoldStep {
  switch (update.kind) {
    case "text":
      return appendText(fold, "reply", update.text);
    case "thought":
      return appendText(fold, "reasoning", update.text);
    case "tool_start":
      return startTool(fold, update, appServer);
    case "tool_update":
      return updateTool(fold, update);
    case "plan":
      return {
        fold: { ...fold, plan: update.entries },
        frames: [
          {
            type: "item",
            item: {
              id: planItemOf(fold),
              kind: "plan",
              entries: entriesOf(update.entries),
            },
          },
        ],
        closed: [],
      };
    case "mode":
      return unchanged(fold);
  }
}

/** Closes what is open; `interrupted` marks the last reply when the user stopped the turn. */
export function finishFold(fold: TurnFold, interrupted: boolean): FoldStep {
  const text = closeText(fold, interrupted);
  const tools = [...fold.tools.values()].map((tool) =>
    toolDraft(tool, interrupted ? "cancelled" : "done", undefined),
  );
  const plan: HostItemDraft[] = fold.plan
    ? [{ id: planItemOf(fold), kind: "plan", body: { entries: entriesOf(fold.plan) } }]
    : [];
  return {
    fold: { ...text.fold, tools: new Map(), plan: undefined },
    frames: [],
    closed: [...text.closed, ...tools, ...plan],
  };
}
