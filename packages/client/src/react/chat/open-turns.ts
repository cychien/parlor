import type { ChatFrame, LoggedItem, OpenItem, OpenTurn, TurnStatus } from "@parlor/chat";
import type { ItemId, TurnId } from "@parlor/core";

/** What streams now, per turn; deltas apply in place and anything else is replaced. */
export interface OpenTurns {
  readonly turns: ReadonlyMap<TurnId, OpenTurn>;
  /** Items whose stream has a hole; they wait for their durable twin. */
  readonly gapped: ReadonlySet<ItemId>;
}

export const NO_OPEN_TURNS: OpenTurns = { turns: new Map(), gapped: new Set() };

function withItem(
  turn: OpenTurn | undefined,
  frame: ChatFrame,
  item: OpenItem,
): OpenTurn {
  const base = turn ?? { turnId: frame.turnId, threadId: frame.threadId, items: [] };
  const at = base.items.findIndex((existing) => existing.id === item.id);
  return {
    ...base,
    items:
      at === -1
        ? [...base.items, item]
        : base.items.map((existing, index) => (index === at ? item : existing)),
  };
}

const replaced = (open: OpenTurns, turn: OpenTurn): OpenTurns => ({
  ...open,
  turns: new Map(open.turns).set(turn.turnId, turn),
});

const gapAt = (open: OpenTurns, id: ItemId): OpenTurns => ({
  ...open,
  gapped: new Set(open.gapped).add(id),
});

/**
 * A delta carries the text length it starts at: bytes already shown are skipped, a hole
 * freezes the item until its durable twin arrives, so a reload mid-stream neither repeats
 * nor loses text.
 */
export function applyFrame(open: OpenTurns, frame: ChatFrame): OpenTurns {
  if (frame.type === "settled") {
    const turns = new Map(open.turns);
    turns.delete(frame.turnId);
    return { ...open, turns };
  }
  const turn = open.turns.get(frame.turnId);
  if (frame.type === "item") return replaced(open, withItem(turn, frame, frame.item));
  if (open.gapped.has(frame.itemId)) return open;
  const existing = turn?.items.find((item) => item.id === frame.itemId);
  if (!existing) {
    if (frame.offset !== 0) return gapAt(open, frame.itemId);
    return replaced(
      open,
      withItem(turn, frame, { id: frame.itemId, kind: frame.kind, text: frame.text }),
    );
  }
  if (existing.kind !== "reply" && existing.kind !== "reasoning") return open;
  const shown = existing.text.length;
  if (frame.offset > shown) return gapAt(open, frame.itemId);
  const tail = frame.text.slice(shown - frame.offset);
  if (tail === "") return open;
  return replaced(
    open,
    withItem(turn, frame, { ...existing, text: existing.text + tail }),
  );
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
  return { ...open, turns };
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
  return {
    turns,
    gapped: new Set([...open.gapped].filter((id) => !durable.has(id))),
  };
}
