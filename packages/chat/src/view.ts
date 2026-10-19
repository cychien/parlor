import type { DeviceId, ItemId, TurnId } from "@parlor/core";

import type { ChatEvent } from "./events.js";
import type { ChatItemBody, ChatItemKind, LoggedItem } from "./items.js";
import type { AgentRef, OpenTurn, TurnState, TurnStatus } from "./model.js";

export type AskState =
  | { readonly state: "open" }
  | { readonly state: "answered"; readonly choice: string }
  | { readonly state: "closed" };

/** What a chat renders. `confirm` is the app's own `confirm: true` card, placed in its turn. */
export type ChatItem<C = unknown> =
  | {
      readonly kind: "prompt";
      readonly id: ItemId;
      readonly turnId: TurnId;
      readonly text: string;
      readonly agent: AgentRef;
      readonly state: TurnState;
      readonly mine: boolean;
    }
  | {
      readonly kind: "reply" | "reasoning";
      readonly id: ItemId;
      readonly turnId: TurnId;
      readonly text: string;
      readonly streaming: boolean;
      readonly interrupted: boolean;
    }
  | {
      readonly kind: "tool";
      readonly id: ItemId;
      readonly turnId: TurnId;
      readonly title: string;
      readonly tool: ChatItemBody<"tool">["tool"] | undefined;
      readonly status: "pending" | "running" | ChatItemBody<"tool">["status"];
      readonly detail: string | undefined;
    }
  | {
      readonly kind: "plan";
      readonly id: ItemId;
      readonly turnId: TurnId;
      readonly entries: ChatItemBody<"plan">["entries"];
      readonly streaming: boolean;
    }
  | {
      readonly kind: "ask";
      readonly id: ItemId;
      readonly turnId: TurnId;
      readonly question: string;
      readonly choices: ChatItemBody<"ask">["choices"];
      readonly form: ChatItemBody<"ask">["form"];
      readonly approval: ChatItemBody<"ask">["approval"];
      readonly answer: AskState;
    }
  | {
      readonly kind: "confirm";
      readonly id: ItemId;
      readonly turnId: TurnId;
      readonly confirmation: C;
    }
  | {
      readonly kind: "event";
      readonly id: ItemId;
      readonly turnId: TurnId;
      readonly event: ChatEvent;
      readonly detail: string | undefined;
    };

/** Log kinds that settle another item instead of rendering on their own. */
export type FoldedKind = Extract<ChatItemKind, "answer" | "cancel">;

export interface ThreadConfirmation {
  readonly id: string;
  readonly threadId?: string | undefined;
}

export interface FoldInput<C extends ThreadConfirmation> {
  readonly items: readonly LoggedItem[];
  readonly open: readonly OpenTurn[];
  readonly turns: readonly TurnStatus[];
  readonly confirmations: readonly C[];
  readonly deviceId: DeviceId | undefined;
}

/** How each log kind enters the fold; keyed by every kind, so a new kind fails to build here. */
export type ItemFolders = {
  readonly [K in ChatItemKind]: (item: LoggedItem<K>) => void;
};

/**
 * Pure and O(items + open): the same input gives the same list with stable ids, so a
 * durable item replacing its open twin keeps its React row.
 */
export function foldThread<C extends ThreadConfirmation>(
  input: FoldInput<C>,
): readonly ChatItem<C>[] {
  // TODO: walk items by seq through an `ItemFolders` table: answer settles its ask, cancel
  //   its turn's prompt; then each turn's open items whose id is not durable yet (streaming);
  //   then confirmations with this thread's id after the running turn's items.
  void input;
  throw new Error("not implemented");
}
