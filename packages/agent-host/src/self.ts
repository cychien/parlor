import { isSea } from "node:sea";

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

export const selfEntry = (): string | undefined =>
  isSea() ? process.execPath : process.argv[1];
