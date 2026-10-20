import {
  applyFrame as applyToItems,
  type ChatFrame,
  type LoggedItem,
  type OpenItem,
  type OpenTurn,
  type TurnStatus,
} from "@parlor/chat";
import type { TurnId } from "@parlor/core";

export interface OpenTurns {
  readonly turns: ReadonlyMap<TurnId, OpenTurn>;
}

export const NO_OPEN_TURNS: OpenTurns = { turns: new Map() };

export function applyFrame(open: OpenTurns, frame: ChatFrame): OpenTurns {
  if (frame.type === "settled") return open;
  const turn = open.turns.get(frame.turnId);
  const applied = applyToItems(turn?.items ?? [], frame);
  if (!applied) return open;
  const next = new Map(open.turns);
  next.set(frame.turnId, {
    turnId: frame.turnId,
    threadId: frame.threadId,
    items: [...applied.items],
  });
  return { turns: next };
}

export function mergeSnapshot(open: OpenTurns, snapshot: readonly OpenTurn[]): OpenTurns {
  const turns = new Map<TurnId, OpenTurn>(snapshot.map((turn) => [turn.turnId, turn]));
  for (const [turnId, local] of open.turns) {
    const remote = turns.get(turnId);
    if (!remote) {
      turns.set(turnId, local);
      continue;
    }
    const longer = (item: OpenItem): OpenItem => {
      const mine = local.items.find((candidate) => candidate.id === item.id);
      return mine &&
        "text" in mine &&
        "text" in item &&
        mine.text.length > item.text.length
        ? mine
        : item;
    };
    const known = new Set(remote.items.map((item) => item.id));
    turns.set(turnId, {
      ...remote,
      items: [
        ...remote.items.map(longer),
        ...local.items.filter((i) => !known.has(i.id)),
      ],
    });
  }
  return { turns };
}

export function pruneOpen(
  open: OpenTurns,
  durable: ReadonlyMap<string, LoggedItem>,
  statuses: readonly TurnStatus[],
): OpenTurns {
  const over = new Set(
    statuses
      .filter((s) => s.state !== "queued" && s.state !== "running")
      .map((s) => s.turnId),
  );
  const turns = new Map<TurnId, OpenTurn>();
  for (const [turnId, turn] of open.turns) {
    if (over.has(turnId)) continue;
    const items = turn.items.filter((item) => !durable.has(item.id));
    if (items.length > 0) turns.set(turnId, { ...turn, items });
  }
  return { turns };
}
