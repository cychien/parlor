import { createInterface } from "node:readline";

import type { AccountSummary } from "@parlor/auth";

/**
 * The computer's own surface, which no app, backend or web page can draw. Every decision
 * that gives a remote party power over this computer lands here.
 */
export interface LocalPrompter {
  confirmPairing(input: {
    readonly appName: string;
    readonly appOrigin: string;
    readonly account: AccountSummary;
    readonly matchingCode: string;
  }): Promise<boolean>;
  approveDevice(input: {
    readonly appName: string;
    readonly account: AccountSummary;
    readonly device: { readonly name: string; readonly platform: string };
  }): Promise<boolean>;
  /** The chosen option id, or undefined when dismissed. */
  answerHere(input: {
    readonly appName: string;
    readonly agent: string;
    readonly question: string;
    readonly choices: readonly { readonly id: string; readonly label: string }[];
  }): Promise<string | undefined>;
  /** Passive: a remote turn started here. */
  turnStarted(input: {
    readonly appName: string;
    readonly device: string;
    readonly agent: string;
    readonly preview: string;
  }): void;
}

/** One line from the terminal; `undefined` once its input has ended. */
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

/** Interactive `connect`: asks on the TTY that ran it. */
export function terminalPrompter(): LocalPrompter {
  return {
    confirmPairing: async ({ appName, account, matchingCode }) =>
      yes(
        await ask(
          `Connect this computer to ${appName} as ${account.email ?? account.name}? Code ${matchingCode} [y/N] `,
        ),
      ),
    approveDevice: async ({ appName, account, device }) =>
      yes(
        await ask(
          `Let ${device.name} (${device.platform}) run agents here for ${appName} as ${account.email ?? account.name}? [y/N] `,
        ),
      ),
    answerHere: async ({ appName, agent, question, choices }) => {
      const menu = choices.map((choice, at) => `  ${at + 1}. ${choice.label}`).join("\n");
      const answer = await ask(
        `${agent} for ${appName} asks: ${question}\n${menu}\nChoice: `,
      );
      return choices[Number(answer?.trim()) - 1]?.id;
    },
    turnStarted: ({ appName, device, agent, preview }) => {
      process.stdout.write(
        `${agent} is working for ${appName} from ${device}: ${preview}\n`,
      );
    },
  };
}
