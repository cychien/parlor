import type { Tag } from "./action.js";
import type { ActionErrorBody } from "./errors.js";

/**
 * Names the reads a page shows on a write it sends, so the answer brings back the ones the
 * write changed and the page needs no second round trip. A header, not part of the body, so
 * a server that does not know it answers the write as always.
 */
export const REFRESH_HEADER = "x-parlor-refresh";

/** More is a client gone wrong: each one is a read run with the write. */
export const MAX_REFRESHED_READS = 32;

/** An action query the page shows: its action and input. */
export type ReadRequest = readonly [name: string, input: unknown];

/** A read the write changed, run again after it, or why it could not be; null when the write did not touch it. */
export type RefreshedRead =
  | { readonly data: unknown; readonly tags: readonly Tag[]; readonly cursor?: string }
  | ActionErrorBody
  | null;

export function encodeReadRequests(reads: readonly ReadRequest[]): string {
  return encodeURIComponent(JSON.stringify(reads));
}

/** The reads a header names, or undefined for one that is missing or malformed. */
export function decodeReadRequests(
  header: string | null | undefined,
): ReadRequest[] | undefined {
  if (!header) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(decodeURIComponent(header));
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MAX_REFRESHED_READS) return undefined;
  const valid = value.every(
    (entry): entry is ReadRequest =>
      Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string",
  );
  return valid ? value : undefined;
}
