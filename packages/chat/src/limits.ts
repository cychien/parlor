import type { AgentOption, AgentOptionValue } from "./model.js";

export const MAX_PROMPT_CHARS = 32_000;

export const PROMPT_LIMIT_MESSAGE = `Messages can be at most ${MAX_PROMPT_CHARS.toLocaleString("en-US")} characters.`;

export const isPromptTooLong = (text: string): boolean =>
  text.trim().length > MAX_PROMPT_CHARS;

/** What a computer may report of one agent's options; longer display text is cut, never refused. */
export const AGENT_OPTION_LIMITS = {
  options: 10,
  values: 50,
  id: 200,
  optionName: 100,
  category: 50,
  valueName: 200,
  description: 500,
} as const;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * An agent's options within `AGENT_OPTION_LIMITS`: names and descriptions cut to length, the
 * first values kept with the current one among them, and an option or value whose id is too
 * long to send back dropped, as choosing it could not work.
 */
export function clipAgentOptions(options: readonly AgentOption[]): AgentOption[] {
  const limits = AGENT_OPTION_LIMITS;
  return options
    .filter(
      (option) => option.id.length <= limits.id && option.current.length <= limits.id,
    )
    .slice(0, limits.options)
    .map((option) => {
      const fitting = option.values.filter((value) => value.id.length <= limits.id);
      const current = fitting.find((value) => value.id === option.current);
      const first = fitting.slice(0, limits.values);
      const kept =
        current && !first.includes(current)
          ? [...first.slice(0, limits.values - 1), current]
          : first;
      return {
        id: option.id,
        name: clip(option.name, limits.optionName),
        ...(option.category === undefined
          ? {}
          : { category: clip(option.category, limits.category) }),
        ...(option.type ? { type: option.type } : {}),
        current: option.current,
        values: kept.map((value): AgentOptionValue => ({
          id: value.id,
          name: clip(value.name, limits.valueName),
          ...(value.description === undefined
            ? {}
            : { description: clip(value.description, limits.description) }),
        })),
      };
    });
}
