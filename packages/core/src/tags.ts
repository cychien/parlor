import type { AnyAction, Tag, TagSource } from "./action.js";

const DRIZZLE_NAME: unique symbol = Symbol.for("drizzle:Name") as never;

export function tableName(source: TagSource): string {
  if (typeof source === "string") return source;
  const named = source as { [DRIZZLE_NAME]?: string; _?: { name?: string } };
  const name = named[DRIZZLE_NAME] ?? named._?.name;
  if (!name)
    throw new Error("Write and read targets must be table names or Drizzle tables");
  return name;
}

export function tagsOverlap(a: Tag, b: Tag): boolean {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function readTagsFor(action: AnyAction, input: unknown): Tag[] {
  const reads = action.reads;
  if (!reads) return [];
  if (typeof reads === "function") return [...reads(input)];
  return reads.map((source) => [tableName(source)]);
}

function rowIds(result: unknown): (string | number)[] {
  const rows = Array.isArray(result) ? result : [result];
  const ids: (string | number)[] = [];
  for (const row of rows) {
    if (row && typeof row === "object" && "id" in row) {
      const id = (row as { id: unknown }).id;
      if (typeof id === "string" || typeof id === "number") ids.push(id);
    }
  }
  return ids;
}

export function writeTagsFor(action: AnyAction, result?: unknown): Tag[] {
  const tables = (action.writes ?? []).map(tableName);
  const ids = rowIds(result);
  if (ids.length === 0) return tables.map((table) => [table]);
  return tables.flatMap((table) => ids.map((id) => [table, id]));
}
