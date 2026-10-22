import {
  asId,
  type Id,
  type IdKind,
  type ItemId,
  type ThreadId,
  type TurnId,
} from "@parlor/core";

import type { ChatItemBody } from "./items.js";
import type { AgentInfo, OpenItem } from "./model.js";

export const CHAT_CHANNEL = "chat";

export type StreamingKind = "reply" | "reasoning";

/**
 * Server to browser on the `chat` channel; never persisted. `offset` makes a duplicate
 * delta skippable and a gap detectable, after which the client waits for the durable
 * item. `settled` drops a turn's open items: durable now, or gone.
 */
export type ChatFrame =
  | {
      readonly type: "delta";
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly itemId: ItemId;
      readonly kind: StreamingKind;
      readonly offset: number;
      readonly text: string;
    }
  | {
      readonly type: "item";
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly item: Extract<OpenItem, { kind: "tool" | "plan" }>;
    }
  | { readonly type: "settled"; readonly threadId: ThreadId; readonly turnId: TurnId };

/** Host to server: the same frames minus what the batch's turn implies. Only the server settles. */
export type HostFrame = ChatFrame extends infer F
  ? F extends { readonly type: "delta" | "item" }
    ? Omit<F, "threadId" | "turnId">
    : never
  : never;

/** `POST /_parlor/chat/stream` */
export interface HostStreamBatch {
  readonly turnId: TurnId;
  readonly frames: readonly HostFrame[];
}

/**
 * The versioned contract between an app's backend and Parlor Host: host actions, item
 * kinds, frames and cursor rules. Bumped on any change an older peer could misread.
 */
export const HOST_PROTOCOL = 2;

export interface ProtocolRange {
  readonly min: number;
  readonly max: number;
}

export interface HostHello {
  readonly protocols: ProtocolRange;
  readonly hostVersion: string;
  readonly name: string;
  readonly platform: string;
  readonly agents: readonly AgentInfo[];
}

export type HostWelcome =
  | {
      readonly accepted: true;
      readonly protocol: number;
      readonly leaseMs: number;
      readonly heartbeatMs: number;
      readonly userActivity?: true;
    }
  | {
      readonly accepted: false;
      readonly reason: "host_too_old" | "app_too_old";
      readonly protocols: ProtocolRange;
    };

type Fields = Readonly<Record<string, unknown>>;

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((candidate) => candidate === value);
}

function idOf<K extends IdKind>(kind: K, value: unknown): Id<K> | undefined {
  return typeof value === "string" && value.length > 0 ? asId(kind, value) : undefined;
}

function openItemOf(
  value: unknown,
): Extract<OpenItem, { kind: "tool" | "plan" }> | undefined {
  if (!isFields(value)) return undefined;
  const id = idOf("item", value.id);
  if (!id) return undefined;
  if (value.kind === "tool") {
    const status = oneOf(["pending", "running"], value.status);
    if (typeof value.title !== "string" || !status) return undefined;
    return { id, kind: "tool", title: value.title, status };
  }
  if (value.kind === "plan" && Array.isArray(value.entries)) {
    const entries: ChatItemBody<"plan">["entries"][number][] = [];
    for (const entry of value.entries as unknown[]) {
      if (!isFields(entry) || typeof entry.content !== "string") return undefined;
      const status = oneOf(["pending", "in_progress", "completed"], entry.status);
      if (!status) return undefined;
      entries.push({ content: entry.content, status });
    }
    return { id, kind: "plan", entries };
  }
  return undefined;
}

export function parseChatFrame(data: string): ChatFrame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isFields(value)) return undefined;
  const threadId = idOf("thread", value.threadId);
  const turnId = idOf("turn", value.turnId);
  if (!threadId || !turnId) return undefined;
  switch (value.type) {
    case "settled":
      return { type: "settled", threadId, turnId };
    case "item": {
      const item = openItemOf(value.item);
      return item ? { type: "item", threadId, turnId, item } : undefined;
    }
    case "delta": {
      const itemId = idOf("item", value.itemId);
      const kind = oneOf(["reply", "reasoning"], value.kind);
      const { offset, text } = value;
      if (!itemId || !kind || typeof text !== "string") return undefined;
      if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
        return undefined;
      return { type: "delta", threadId, turnId, itemId, kind, offset, text };
    }
    default:
      return undefined;
  }
}
