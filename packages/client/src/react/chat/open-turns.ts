import {
  applyFrame as applyToItems,
  type ChatFrame,
  type LoggedItem,
  type OpenItem,
  type OpenTurn,
  type TurnStatus,
} from "@parlor/chat";
import type { TurnId } from "@parlor/core";

/** What streams now, per turn. */
export interface OpenTurns {
  readonly turns: ReadonlyMap<TurnId, OpenTurn>;
}

export const NO_OPEN_TURNS: OpenTurns = { turns: new Map() };

/**
 * A delta carries the text length it starts at: text already shown is skipped and a hole
 * freezes the item until its durable twin arrives, so a reload mid-stream neither repeats
 * nor loses text. `settled` changes nothing: the final durable item can trail it, so an
 * open item leaves only with its twin or with its turn's end.
 */
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

/** A snapshot read late may trail the frames already applied: keep the longer text. */
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

/** Drops what is durable by now and what belongs to a turn that is over. */
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
