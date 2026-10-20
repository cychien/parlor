import { describe, expect, it } from "vitest";

import { readBoundedText } from "./body.js";

function streamed(chunks: number, chunkBytes: number, headers: HeadersInit = {}) {
  const pulled = { count: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled.count === chunks) {
          controller.close();
          return;
        }
        pulled.count += 1;
        controller.enqueue(new Uint8Array(chunkBytes).fill(97));
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request("http://app.test/upload", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
  return { request, pulled };
}

describe("readBoundedText", () => {
  it("returns a body at the limit whole", async () => {
    const { request } = streamed(4, 1024);
    expect(await readBoundedText(request, 4096)).toBe("a".repeat(4096));
  });

  it("stops pulling once the bytes read pass the limit", async () => {
    const { request, pulled } = streamed(100, 4096);
    expect(await readBoundedText(request, 16 * 1024)).toBeUndefined();
    expect(pulled.count).toBeLessThanOrEqual(6);
  });

  it("refuses a declared length over the limit without reading", async () => {
    const { request, pulled } = streamed(100, 4096, { "content-length": "999999" });
    expect(await readBoundedText(request, 16 * 1024)).toBeUndefined();
    expect(pulled.count).toBe(0);
  });

  it("counts bytes, not characters", async () => {
    const request = new Request("http://app.test/upload", {
      method: "POST",
      body: "€".repeat(6000),
    });
    expect(await readBoundedText(request, 16 * 1024)).toBeUndefined();
  });

  it("reads an empty body as empty text", async () => {
    expect(await readBoundedText(new Request("http://app.test/"), 10)).toBe("");
  });
});
