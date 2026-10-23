import { parse } from "@babel/parser";
import type { File } from "@babel/types";

/** A parsed TypeScript or TSX module. Edits never reprint it; they splice `text`. */
export interface SourceFile {
  /** Project-relative, with `/` separators. */
  readonly path: string;
  readonly text: string;
  readonly ast: File;
}

export class SourceSyntaxError extends Error {
  override readonly name = "SourceSyntaxError";
  constructor(
    readonly path: string,
    readonly line: number,
    message: string,
  ) {
    super(`${path}:${line}: ${message}`);
  }
}

export function parseSource(path: string, text: string): SourceFile {
  try {
    const ast = parse(text, {
      sourceType: "module",
      plugins: path.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
    });
    return { path, text, ast };
  } catch (error) {
    const line = (error as { loc?: { line?: number } }).loc?.line ?? 0;
    throw new SourceSyntaxError(path, line, (error as Error).message);
  }
}

/** Offsets index the text before any splice of the same batch. */
export interface Splice {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Splices must not overlap; two inserts at one offset keep their order. */
export function applySplices(text: string, splices: readonly Splice[]): string {
  const ordered = splices
    .map((splice, index) => ({ splice, index }))
    .sort((a, b) => b.splice.start - a.splice.start || b.index - a.index);
  let result = text;
  for (const { splice } of ordered) {
    result = result.slice(0, splice.start) + splice.text + result.slice(splice.end);
  }
  return result;
}
