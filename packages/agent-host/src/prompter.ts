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

/** Interactive `connect`: asks on the TTY that ran it. */
export function terminalPrompter(): LocalPrompter {
  throw new Error("not implemented");
}
