import type { ItemId, ThreadId, TurnId } from "@parlor/core";

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
export const HOST_PROTOCOL = 1;

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
    }
  | {
      readonly accepted: false;
      readonly reason: "host_too_old" | "app_too_old";
      readonly protocols: ProtocolRange;
    };

/** Hand-written so the browser's chat chunk carries no zod. */
export function parseChatFrame(data: string): ChatFrame | undefined {
  // TODO: JSON.parse; check `type` and every field's type per variant; anything else -> undefined.
  void data;
  throw new Error("not implemented");
}
