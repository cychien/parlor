import { isSea } from "node:sea";

/** How to run this very program again: a single executable is its own interpreter and script. */
export function selfInvocation(args: readonly string[]): {
  readonly command: string;
  readonly args: readonly string[];
} {
  const entry = process.argv[1];
  return isSea() || entry === undefined
    ? { command: process.execPath, args }
    : { command: process.execPath, args: [entry, ...args] };
}

export const runsAsSingleExecutable = (): boolean => isSea();

/** The file that is this program: the executable itself in a single-executable build, else the entry script. */
export const selfEntry = (): string | undefined =>
  isSea() ? process.execPath : process.argv[1];
