import type { AgentInfo, AgentOption, AgentUsage } from "@parlor/chat";

import { mergeUsage } from "./agent-options.js";
import { jsonFile } from "./json-file.js";

export interface Learned {
  readonly options?: readonly AgentOption[] | undefined;
  readonly usage?: AgentUsage | undefined;
}

export type LearnedNews =
  | { readonly options: readonly AgentOption[] }
  | { readonly usage: AgentUsage };

/**
 * What each agent last said about itself, kept across restarts: the allowance only arrives
 * on a turn, and a computer that forgot it would show nothing until the next one.
 */
export interface LearnedStore {
  load(): Promise<void>;
  /** Whether it changed what `describe` returns. */
  learn(agentId: string, news: LearnedNews): Promise<boolean>;
  /** Whether the agent has said which options it offers. */
  knows(agentId: string): boolean;
  /** `agents` with what each said about itself, minus usage windows that rolled over. */
  describe(agents: readonly AgentInfo[], now: number): AgentInfo[];
}

export function learnedStore(file: string): LearnedStore {
  const stored = jsonFile<Record<string, Learned>>(file);
  let known: Record<string, Learned> = {};
  return {
    load: async () => {
      known = await stored.read().catch(() => ({}));
    },
    learn: async (agentId, news) => {
      const held = known[agentId] ?? {};
      const next: Learned =
        "options" in news
          ? { ...held, options: news.options }
          : { ...held, usage: mergeUsage(held.usage, news.usage) };
      if (JSON.stringify(next) === JSON.stringify(held)) return false;
      known = { ...known, [agentId]: next };
      await stored.change((all) => {
        all[agentId] = next;
      });
      return true;
    },
    knows: (agentId) => (known[agentId]?.options?.length ?? 0) > 0,
    describe: (agents, now) =>
      agents.map((agent) => {
        const { options, usage } = known[agent.id] ?? {};
        const windows = usage?.windows.filter(
          (window) => window.resetsAt === undefined || window.resetsAt > now,
        );
        return {
          ...agent,
          ...(options && options.length > 0 ? { options } : {}),
          ...(usage && windows && windows.length > 0
            ? { usage: { ...usage, windows } }
            : {}),
        };
      }),
  };
}
