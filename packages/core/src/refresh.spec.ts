import { describe, expect, it } from "vitest";

import {
  decodeReadRequests,
  encodeReadRequests,
  MAX_REFRESHED_READS,
} from "./refresh.js";

describe("the reads a write names in its header", () => {
  it("survive a header, any text in their inputs included", () => {
    const reads = [
      ["listStudents", { q: "王小明", page: 2 }],
      ["getSchool", {}],
    ] as const;
    const header = encodeReadRequests(reads);
    expect(header).toMatch(/^[\x21-\x7e]+$/);
    expect(decodeReadRequests(header)).toEqual(reads);
  });

  it("are none for a header that is missing, malformed or names too many", () => {
    expect(decodeReadRequests(null)).toBeUndefined();
    expect(decodeReadRequests("%E0%A4%A")).toBeUndefined();
    expect(decodeReadRequests(encodeURIComponent('{"not":"a list"}'))).toBeUndefined();
    expect(decodeReadRequests(encodeReadRequests([[1, {}] as never]))).toBeUndefined();
    const many = Array.from(
      { length: MAX_REFRESHED_READS + 1 },
      () => ["getSchool", {}] as const,
    );
    expect(decodeReadRequests(encodeReadRequests(many))).toBeUndefined();
  });
});
