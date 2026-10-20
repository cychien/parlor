export const MAX_PROMPT_CHARS = 32_000;

export const PROMPT_LIMIT_MESSAGE = `Messages can be at most ${MAX_PROMPT_CHARS.toLocaleString("en-US")} characters.`;

export const isPromptTooLong = (text: string): boolean =>
  text.trim().length > MAX_PROMPT_CHARS;
