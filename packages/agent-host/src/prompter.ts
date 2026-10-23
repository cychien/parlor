import { execFile } from "node:child_process";
import { createInterface } from "node:readline";

/** The computer's own surface, which no app, backend or web page can draw. */
export interface LocalPrompter {
  /** The chosen option id, or undefined when dismissed. */
  answerHere(input: {
    readonly appName: string;
    readonly agent: string;
    readonly question: string;
    readonly choices: readonly { readonly id: string; readonly label: string }[];
    readonly signal?: AbortSignal | undefined;
  }): Promise<string | undefined>;
  /** Passive: a remote turn started here. */
  turnStarted(input: {
    readonly appName: string;
    readonly device: string;
    readonly agent: string;
    readonly preview: string;
  }): void;
}

const UNPRINTABLE = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export const printable = (text: string) => text.replace(UNPRINTABLE, "");

function ask(question: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    lines.question(question, (answer) => {
      answered = true;
      lines.close();
      resolve(answer);
    });
    lines.once("close", () => {
      if (!answered) resolve(undefined);
    });
  });
}

const yes = (answer: string | undefined) => /^y(es)?$/i.test(answer?.trim() ?? "");

/** A `[y/N]` question on the terminal that ran a command; only yes is yes. */
export const askYesNo = async (question: string): Promise<boolean> =>
  yes(await ask(`${printable(question)} [y/N] `));

/** Interactive `connect`: asks on the TTY that ran it. */
export function terminalPrompter(): LocalPrompter {
  return {
    answerHere: async ({ appName, agent, question, choices }) => {
      const menu = choices
        .map((choice, at) => `  ${at + 1}. ${printable(choice.label)}`)
        .join("\n");
      const answer = await ask(
        `${printable(agent)} for ${printable(appName)} asks: ${printable(question)}\n${menu}\nChoice: `,
      );
      return choices[Number(answer?.trim()) - 1]?.id;
    },
    turnStarted: ({ appName, device, agent, preview }) => {
      process.stdout.write(
        `${printable(agent)} is working for ${printable(appName)} from ${printable(device)}: ${printable(preview)}\n`,
      );
    },
  };
}

const DIALOG_TITLE = "Parlor Host";
const MAX_DIALOG_BUTTONS = 3;
const MAX_DIALOG_TEXT = 600;

const clipped = (text: string) =>
  printable(text).length > MAX_DIALOG_TEXT
    ? `${printable(text).slice(0, MAX_DIALOG_TEXT)}...`
    : printable(text);

function osascript(
  lines: readonly string[],
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "osascript",
      [...lines.flatMap((line) => ["-e", line]), "--", ...args],
      { signal },
      (error, stdout) => resolve(error ? undefined : stdout.trim()),
    );
  });
}

function choose(
  text: string,
  labels: readonly string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  const options = labels.map(clipped);
  return osascript(
    labels.length <= MAX_DIALOG_BUTTONS
      ? [
          "on run argv",
          `set reply to display dialog (item 1 of argv) with title "${DIALOG_TITLE}" buttons (rest of argv)`,
          "return button returned of reply",
          "end run",
        ]
      : [
          "on run argv",
          `set picked to choose from list (rest of argv) with title "${DIALOG_TITLE}" with prompt (item 1 of argv)`,
          "if picked is false then error number -128",
          "return item 1 of picked",
          "end run",
        ],
    [clipped(text), ...options],
    signal,
  );
}

export function macDialogPrompter(): LocalPrompter {
  return {
    answerHere: async ({ appName, agent, question, choices, signal }) => {
      const label = await choose(
        `${agent} for ${appName} asks: ${question}`,
        choices.map((choice) => choice.label),
        signal,
      );
      return choices.find((choice) => clipped(choice.label) === label)?.id;
    },
    turnStarted: ({ appName, device, agent, preview }) => {
      void osascript(
        [
          "on run argv",
          `display notification (item 3 of argv) with title "${DIALOG_TITLE}" subtitle (item 1 of argv & " from " & item 2 of argv)`,
          "end run",
        ],
        [
          clipped(`${agent} is working for ${appName}`),
          clipped(device),
          clipped(preview),
        ],
      );
    },
  };
}
