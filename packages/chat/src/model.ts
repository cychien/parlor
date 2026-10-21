import type { HostId, ItemId, ThreadId, TurnId, UserId } from "@parlor/core";
import type { Delegation, DeviceKeys } from "@parlor/server";

import type { ChatItemBody, LoggedItem, UserItemKind } from "./items.js";

export interface AgentRef {
  readonly hostId: HostId;
  /** A profile id on that host (`claude`, `codex`), not an entity. */
  readonly agentId: string;
}

/**
 * Whose chat a row is. Every thread, turn and host row carries both and every chat query
 * filters by both, so members of one organization scope never see each other's chats.
 */
export interface ChatOwner {
  readonly scope: string;
  readonly userId: UserId;
}

export interface HostSummary {
  readonly id: HostId;
  readonly name: string;
  readonly platform: string;
  readonly online: boolean;
  readonly agents: readonly AgentInfo[];
}

export interface AgentInfo {
  readonly id: string;
  readonly name: string;
  readonly version?: string | undefined;
  readonly ready: boolean;
  /** Why a not-ready agent cannot run yet ("run `claude` to log in"). */
  readonly problem?: string | undefined;
}

export interface ThreadSummary {
  readonly id: ThreadId;
  readonly title: string;
  readonly agent: AgentRef | undefined;
  readonly updatedAt: number;
  readonly lastSeq: number;
}

export type TurnState = "queued" | "running" | "done" | "failed" | "cancelled";

export type TurnFailure =
  | "agent_exited"
  | "agent_unavailable"
  | "device_rejected"
  | "signature_invalid"
  | "prompt_expired"
  | "host_lost";

export type TurnOutcome =
  | { readonly state: "done"; readonly stopReason: string }
  | { readonly state: "cancelled" }
  | { readonly state: "failed"; readonly reason: TurnFailure };

/** Still being produced: only in memory, on the instance the host posts to. */
export type OpenItem =
  | { readonly id: ItemId; readonly kind: "reply" | "reasoning"; readonly text: string }
  | {
      readonly id: ItemId;
      readonly kind: "tool";
      readonly title: string;
      readonly status: "pending" | "running";
    }
  | {
      readonly id: ItemId;
      readonly kind: "plan";
      readonly entries: ChatItemBody<"plan">["entries"];
    };

export interface OpenTurn {
  readonly turnId: TurnId;
  readonly threadId: ThreadId;
  readonly items: readonly OpenItem[];
}

export interface TurnStatus {
  readonly turnId: TurnId;
  readonly state: TurnState;
  readonly agent: AgentRef;
  readonly failure?: TurnFailure | undefined;
}

export interface ThreadPage {
  readonly thread: ThreadSummary | undefined;
  readonly items: readonly LoggedItem[];
  readonly open: readonly OpenTurn[];
  readonly turns: readonly TurnStatus[];
  readonly hasMore: boolean;
}

export interface ChatSnapshot {
  readonly threads: readonly ThreadSummary[];
  readonly hosts: readonly HostSummary[];
  readonly page: ThreadPage;
}

/** The device's keys as the account has them; the host compares them with its own pins. */
export type ClaimedDevice = DeviceKeys;

export interface ClaimedTurn {
  /** The thread id; every chat write returns it as `id`, which becomes its sync tag. */
  readonly id: ThreadId;
  readonly turnId: TurnId;
  readonly agent: AgentRef;
  /** The client the prompt came from; the turn token binds `ui_*` to it. */
  readonly clientId: string;
  readonly prompt: LoggedItem<"prompt">;
  readonly device: ClaimedDevice | undefined;
  /** The `<parlor-context>` block for a fresh agent session. */
  readonly context: string;
  readonly token: Delegation;
  readonly leaseUntil: number;
}

export interface TurnSignals {
  readonly turnId: TurnId;
  readonly items: readonly LoggedItem<Exclude<UserItemKind, "prompt">>[];
}

/** What a device signs for a prompt; the host rebuilds the same statement from the item. */
export interface PromptToSign {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly agent: AgentRef;
  readonly text: string;
}

export interface AnswerToSign {
  readonly threadId: ThreadId;
  readonly askId: ItemId;
  readonly choice: string;
  readonly values?: ChatItemBody<"answer">["values"];
}
