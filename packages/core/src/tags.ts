import type { AnyAction, Tag, TagSource } from "./action.js";

export function tableName(source: TagSource): string {
  return typeof source === "string" ? source : source._.name;
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

export function writeTagsFor(action: AnyAction): Tag[] {
  return (action.writes ?? []).map((source) => [tableName(source)]);
}
