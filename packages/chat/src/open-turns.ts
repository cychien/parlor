import type { OpenItem } from "./model.js";
import type { ChatFrame } from "./protocol.js";

export interface AppliedFrame {
  readonly items: readonly OpenItem[];
  /** What actually changed: a delta overlapping the text already held is cut to its new part. */
  readonly frame: Exclude<ChatFrame, { type: "settled" }>;
}

/**
 * Applies a `delta` or `item` frame to one turn's open items. A delta whose text is
 * already held is skipped and one that starts past the end of the text is a gap; both
 * answer `undefined`, and after a gap every later delta is a gap too, so the item waits
 * for its durable twin instead of drawing a hole.
 */
export function applyFrame(
  items: readonly OpenItem[],
  frame: Exclude<ChatFrame, { type: "settled" }>,
): AppliedFrame | undefined {
  if (frame.type === "item") {
    const index = items.findIndex((item) => item.id === frame.item.id);
    const next =
      index < 0
        ? [...items, frame.item]
        : items.map((item, at) => (at === index ? frame.item : item));
    return { items: next, frame };
  }
  const index = items.findIndex((item) => item.id === frame.itemId);
  const held = index < 0 ? undefined : items[index];
  if (held && held.kind !== "reply" && held.kind !== "reasoning") return undefined;
  const have = held ? held.text : "";
  if (frame.offset > have.length) return undefined;
  const fresh = frame.text.slice(have.length - frame.offset);
  if (fresh.length === 0) return undefined;
  const grown: OpenItem = { id: frame.itemId, kind: frame.kind, text: have + fresh };
  const next = held
    ? items.map((item, at) => (at === index ? grown : item))
    : [...items, grown];
  return { items: next, frame: { ...frame, offset: have.length, text: fresh } };
}
