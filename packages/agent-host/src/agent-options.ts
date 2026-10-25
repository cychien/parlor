import type { AgentOption, AgentUsage, AgentUsageWindow } from "@parlor/chat";

/** The values `chosen` names that `options` offers and does not already run with. */
export function optionChanges(
  options: readonly AgentOption[],
  chosen: Readonly<Record<string, string>> | undefined,
): { readonly id: string; readonly value: string }[] {
  return Object.entries(chosen ?? {}).flatMap(([id, value]) => {
    const option = options.find((candidate) => candidate.id === id);
    if (!option || option.current === value) return [];
    return option.values.some((candidate) => candidate.id === value)
      ? [{ id, value }]
      : [];
  });
}

const RATE_LIMIT_META = "_claude/rateLimit";
const WINDOW_MINUTES: Readonly<Record<string, number>> = {
  five_hour: 5 * 60,
  seven_day: 7 * 24 * 60,
  seven_day_opus: 7 * 24 * 60,
  seven_day_sonnet: 7 * 24 * 60,
};

interface RateLimitSlot {
  readonly utilization?: unknown;
  readonly resetsAt?: unknown;
}

function windowOf(id: string, slot: RateLimitSlot): AgentUsageWindow | undefined {
  const minutes = WINDOW_MINUTES[id];
  const used = slot.utilization;
  if (minutes === undefined || typeof used !== "number" || !Number.isFinite(used)) {
    return undefined;
  }
  const resetsAt =
    typeof slot.resetsAt === "number" && Number.isFinite(slot.resetsAt)
      ? slot.resetsAt * 1000
      : undefined;
  return {
    id,
    minutes,
    used: Math.min(1, Math.max(0, used)),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/**
 * Claude Code's rate limit, which rides on a `usage_update`'s `_meta`: every window a newer
 * CLI names under `unifiedWindows`, or the one window an event is about.
 */
export function agentUsageOf(
  meta: Readonly<Record<string, unknown>> | null | undefined,
  at: number,
): AgentUsage | undefined {
  const info = meta?.[RATE_LIMIT_META] as
    | (RateLimitSlot & {
        readonly rateLimitType?: unknown;
        readonly unifiedWindows?: Readonly<Record<string, RateLimitSlot>>;
      })
    | undefined;
  if (!info || typeof info !== "object") return undefined;
  const slots: [string, RateLimitSlot][] =
    info.unifiedWindows && typeof info.unifiedWindows === "object"
      ? Object.entries(info.unifiedWindows)
      : typeof info.rateLimitType === "string"
        ? [[info.rateLimitType, info]]
        : [];
  const windows = slots.flatMap(([id, slot]) => {
    const window = windowOf(id, slot);
    return window ? [window] : [];
  });
  return windows.length === 0 ? undefined : { windows: ordered(windows), at };
}

/**
 * `next` laid over `held` window by window: an event names one window, and the others it
 * leaves out still stand until they roll over.
 */
export function mergeUsage(held: AgentUsage | undefined, next: AgentUsage): AgentUsage {
  const named = new Set(next.windows.map((window) => window.id));
  const kept = (held?.windows ?? []).filter(
    (window) =>
      !named.has(window.id) &&
      (window.resetsAt === undefined || window.resetsAt > next.at),
  );
  return { windows: ordered([...next.windows, ...kept]), at: next.at };
}

/** The account's own windows before a model's, each set shortest first. */
function ordered(windows: readonly AgentUsageWindow[]): AgentUsageWindow[] {
  const perModel = (window: AgentUsageWindow) => (window.id in ACCOUNT_WINDOWS ? 0 : 1);
  return [...windows].sort(
    (a, b) =>
      perModel(a) - perModel(b) || a.minutes - b.minutes || a.id.localeCompare(b.id),
  );
}

const ACCOUNT_WINDOWS: Readonly<Record<string, true>> = {
  five_hour: true,
  seven_day: true,
};
