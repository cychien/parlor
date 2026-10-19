import type { LoggedItem } from "../items.js";

export const TRANSCRIPT_BUDGET_BYTES = 8 * 1024;

export interface TurnContextInput {
  readonly appName: string;
  readonly appOrigin: string;
  readonly account?:
    | { readonly name: string; readonly email?: string | undefined }
    | undefined;
  readonly device?: { readonly name: string; readonly platform: string } | undefined;
  readonly instructions?: string | undefined;
  /** The thread before this turn, trimmed from its oldest end to the budget. */
  readonly history: readonly LoggedItem[];
}

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;
const ELLIPSIS = "...";

/**
 * The `<parlor-context>` block before a fresh agent session's first prompt. Built on the
 * backend so every host and agent gets the same words; the transcript tail is what lets a
 * switched or restarted agent continue the thread.
 */
export function turnContext(input: TurnContextInput): string {
  const app = input.appOrigin ? `${input.appName} (${input.appOrigin})` : input.appName;
  const who = input.account
    ? `${input.account.name}${input.account.email ? ` <${input.account.email}>` : ""}`
    : "the signed-in user";
  const from = input.device
    ? ` They are writing from ${input.device.name} (${input.device.platform}).`
    : "";
  const lines = [
    "<parlor-context>",
    `You are working inside ${app} for ${who}.${from}`,
    "The app's tools are its own actions plus ui_* tools that act on the screen of the chat you are in. Some actions wait for the user to approve them in the app before they run.",
  ];
  if (input.instructions) lines.push("", input.instructions.trim());
  const transcript = transcriptOf(input.history);
  if (transcript.length > 0) {
    lines.push("", "The conversation so far, oldest first:", ...transcript);
  }
  lines.push("</parlor-context>");
  return lines.join("\n");
}

function lineOf(item: LoggedItem): string | undefined {
  switch (item.kind) {
    case "prompt":
      return `user: ${item.body.text}`;
    case "reply":
      return `assistant: ${item.body.text}`;
    case "tool":
      return `tool: ${item.body.title} (${item.body.status})`;
    default:
      return undefined;
  }
}

function transcriptOf(history: readonly LoggedItem[]): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let at = history.length - 1; at >= 0; at -= 1) {
    const item = history[at];
    const line = item && lineOf(item);
    if (line === undefined) continue;
    const size = byteLength(line) + 1;
    if (used + size > TRANSCRIPT_BUDGET_BYTES) {
      if (kept.length === 0) kept.push(tailWithin(line, TRANSCRIPT_BUDGET_BYTES - 1));
      break;
    }
    used += size;
    kept.push(line);
  }
  return kept.reverse();
}

/** The end of `line` that fits `budget` UTF-8 bytes, on a character boundary. */
function tailWithin(line: string, budget: number): string {
  const room = budget - byteLength(ELLIPSIS);
  const chars = [...line];
  let size = 0;
  let from = chars.length;
  while (from > 0) {
    const next = size + byteLength(chars[from - 1] ?? "");
    if (next > room) break;
    size = next;
    from -= 1;
  }
  return ELLIPSIS + chars.slice(from).join("");
}
