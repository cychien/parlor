export function selfInvocation(args: readonly string[]): {
  readonly command: string;
  readonly args: readonly string[];
} {
  const entry = process.argv[1];
  return entry === undefined
    ? { command: process.execPath, args }
    : { command: process.execPath, args: [entry, ...args] };
}

export const selfEntry = (): string | undefined => process.argv[1];
