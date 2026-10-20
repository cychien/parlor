import { asId, type DeviceId, type ItemId, type TurnId } from "@parlor/core";

import type { ChatEvent } from "./events.js";
import type { ChatItemBody, ChatItemKind, LoggedItem } from "./items.js";
import type {
  AgentRef,
  OpenItem,
  OpenTurn,
  TurnFailure,
  TurnState,
  TurnStatus,
} from "./model.js";

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
      readonly failure: TurnFailure | undefined;
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

const TERMINAL: ReadonlySet<TurnState> = new Set(["done", "failed", "cancelled"]);

/**
 * Pure and O(items + open): the same input gives the same list with stable ids, so a
 * durable item replacing its open twin keeps its React row.
 */
export function foldThread<C extends ThreadConfirmation>(
  input: FoldInput<C>,
): readonly ChatItem<C>[] {
  const states = new Map<TurnId, TurnState>();
  for (const turn of input.turns) states.set(turn.turnId, turn.state);
  const stateOf = (turnId: TurnId): TurnState => states.get(turnId) ?? "done";
  const failures = new Map<TurnId, TurnFailure>();
  for (const turn of input.turns) {
    if (turn.failure) failures.set(turn.turnId, turn.failure);
  }
  const rejected = new Set<ItemId>();
  for (const item of input.items) {
    if (
      item.kind === "event" &&
      item.body.event === "answer_rejected" &&
      item.body.itemId
    ) {
      rejected.add(item.body.itemId);
    }
  }

  const rows: ChatItem<C>[] = [];
  const durable = new Set<ItemId>();
  const asks = new Map<ItemId, number>();
  const prompts = new Map<TurnId, number>();
  const cancelled = new Set<TurnId>();

  const push = (row: ChatItem<C>) => {
    rows.push(row);
    return rows.length - 1;
  };

  const folders: ItemFolders = {
    prompt: (item) => {
      prompts.set(
        item.turnId,
        push({
          kind: "prompt",
          id: item.id,
          turnId: item.turnId,
          text: item.body.text,
          agent: item.body.agent,
          state: stateOf(item.turnId),
          failure: failures.get(item.turnId),
          mine:
            input.deviceId !== undefined && item.body.signed?.deviceId === input.deviceId,
        }),
      );
    },
    answer: (item) => {
      const at = asks.get(item.body.askId);
      if (at === undefined || rejected.has(item.id)) return;
      const row = rows[at];
      if (row?.kind === "ask" && row.answer.state === "open") {
        rows[at] = {
          ...row,
          answer: { state: "answered", choice: item.body.choice },
        };
      }
    },
    cancel: (item) => {
      cancelled.add(item.turnId);
    },
    reply: (item) => {
      push({
        kind: "reply",
        id: item.id,
        turnId: item.turnId,
        text: item.body.text,
        streaming: false,
        interrupted: item.body.interrupted === true,
      });
    },
    reasoning: (item) => {
      push({
        kind: "reasoning",
        id: item.id,
        turnId: item.turnId,
        text: item.body.text,
        streaming: false,
        interrupted: false,
      });
    },
    tool: (item) => {
      push({
        kind: "tool",
        id: item.id,
        turnId: item.turnId,
        title: item.body.title,
        tool: item.body.tool,
        status: item.body.status,
        detail: item.body.detail,
      });
    },
    plan: (item) => {
      push({
        kind: "plan",
        id: item.id,
        turnId: item.turnId,
        entries: item.body.entries,
        streaming: false,
      });
    },
    ask: (item) => {
      asks.set(
        item.id,
        push({
          kind: "ask",
          id: item.id,
          turnId: item.turnId,
          question: item.body.question,
          choices: item.body.choices,
          form: item.body.form,
          approval: item.body.approval,
          answer: { state: "open" },
        }),
      );
    },
    event: (item) => {
      push({
        kind: "event",
        id: item.id,
        turnId: item.turnId,
        event: item.body.event,
        detail: item.body.detail,
      });
    },
  };

  for (const item of input.items) {
    durable.add(item.id);
    fold(folders, item);
  }

  for (const [turnId, at] of prompts) {
    const row = rows[at];
    if (row?.kind === "prompt" && cancelled.has(turnId) && !TERMINAL.has(row.state)) {
      rows[at] = { ...row, state: "cancelled" };
    }
  }
  for (const at of asks.values()) {
    const row = rows[at];
    if (row?.kind === "ask" && row.answer.state === "open") {
      if (TERMINAL.has(stateOf(row.turnId)) || cancelled.has(row.turnId)) {
        rows[at] = { ...row, answer: { state: "closed" } };
      }
    }
  }

  for (const turn of input.open) {
    if (TERMINAL.has(stateOf(turn.turnId))) continue;
    for (const open of turn.items) {
      if (durable.has(open.id)) continue;
      rows.push(openRow(open, turn.turnId));
    }
  }

  const threadId = input.items[0]?.threadId ?? input.open[0]?.threadId;
  if (threadId !== undefined) {
    const running = input.turns.find((turn) => turn.state === "running")?.turnId;
    const turnId = running ?? input.items.at(-1)?.turnId ?? input.open[0]?.turnId;
    if (turnId !== undefined) {
      for (const confirmation of input.confirmations) {
        if (confirmation.threadId !== threadId) continue;
        rows.push({
          kind: "confirm",
          id: asId("item", confirmation.id),
          turnId,
          confirmation,
        });
      }
    }
  }
  return rows;
}

function fold(folders: ItemFolders, item: LoggedItem): void {
  switch (item.kind) {
    case "prompt":
      return folders.prompt(item);
    case "answer":
      return folders.answer(item);
    case "cancel":
      return folders.cancel(item);
    case "reply":
      return folders.reply(item);
    case "reasoning":
      return folders.reasoning(item);
    case "tool":
      return folders.tool(item);
    case "plan":
      return folders.plan(item);
    case "ask":
      return folders.ask(item);
    case "event":
      return folders.event(item);
  }
}

function openRow<C>(open: OpenItem, turnId: TurnId): ChatItem<C> {
  switch (open.kind) {
    case "reply":
    case "reasoning":
      return {
        kind: open.kind,
        id: open.id,
        turnId,
        text: open.text,
        streaming: true,
        interrupted: false,
      };
    case "tool":
      return {
        kind: "tool",
        id: open.id,
        turnId,
        title: open.title,
        tool: undefined,
        status: open.status,
        detail: undefined,
      };
    case "plan":
      return {
        kind: "plan",
        id: open.id,
        turnId,
        entries: open.entries,
        streaming: true,
      };
  }
}
