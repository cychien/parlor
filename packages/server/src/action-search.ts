import type { ActionDescriptor } from "@parlor/core/registry";

export const SEARCH_ACTIONS_TOOL = "search_actions";
export const CALL_ACTION_TOOL = "call_action";
export const MAX_ACTIONS_FOUND = 10;

export interface FoundAction {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly inputSchema: Record<string, unknown>;
}

export interface ActionSearchResult {
  readonly actions: readonly FoundAction[];
  /** How many more actions matched than were listed. */
  readonly more?: number;
}

/** `orders` and `order` match: a plural's trailing s is dropped. */
const stem = (word: string) =>
  word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;

/** `listCourseOrders` reads as `list course order`, so its words match a plain query. */
const wordsOf = (text: string) =>
  (
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).map(stem);

/**
 * The searchable actions that match `query` best, by how many of its words each action's name
 * and description mention; `names` gives those actions exactly. `describe` words each one as
 * its listed tool would be.
 */
export function searchActions(
  candidates: readonly ActionDescriptor[],
  input: {
    readonly query?: string | undefined;
    readonly names?: readonly string[] | undefined;
  },
  describe: (descriptor: ActionDescriptor) => string,
): ActionSearchResult {
  const found = (matches: readonly ActionDescriptor[]): ActionSearchResult => {
    const actions = matches.slice(0, MAX_ACTIONS_FOUND).map((descriptor) => ({
      name: descriptor.name,
      description: describe(descriptor),
      readOnly: !descriptor.mutating,
      inputSchema: descriptor.inputSchema,
    }));
    const more = matches.length - actions.length;
    return more > 0 ? { actions, more } : { actions };
  };
  if (input.names !== undefined) {
    const wanted = new Set(input.names);
    return found(candidates.filter((descriptor) => wanted.has(descriptor.name)));
  }
  const words = [...new Set(wordsOf(input.query ?? ""))];
  if (words.length === 0) return found(candidates);
  const scored = candidates
    .map((descriptor, order) => {
      const haystack = new Set(wordsOf(`${descriptor.name} ${descriptor.description}`));
      return {
        descriptor,
        order,
        score: words.filter((word) => haystack.has(word)).length,
      };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  return found(scored.map(({ descriptor }) => descriptor));
}
