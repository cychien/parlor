import { describe, expect, it } from "vitest";

import { readUnreadBody } from "./unread-body.js";

function streamed(chunks: number, chunkBytes: number) {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === chunks) return controller.close();
      pulled++;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://app.test/", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);
  return { request, pulled: () => pulled, cancelled: () => cancelled };
}

describe("readUnreadBody", () => {
  it("reads a body the server left unread to its end", async () => {
    const body = streamed(3, 10);
    await readUnreadBody(body.request, 100);
    expect(body.pulled()).toBe(3);
    expect(body.cancelled()).toBe(false);
    expect(body.request.bodyUsed).toBe(true);
  });

  it("leaves a body the server read alone", async () => {
    const request = new Request("http://app.test/", { method: "POST", body: "{}" });
    expect(await request.text()).toBe("{}");
    await expect(readUnreadBody(request, 100)).resolves.toBeUndefined();
  });

  it("cancels a body once it passes the limit instead of reading the rest", async () => {
    const body = streamed(1000, 10);
    await readUnreadBody(body.request, 25);
    expect(body.pulled()).toBeLessThan(10);
    expect(body.cancelled()).toBe(true);
  });

  it("has nothing to read on a request without a body", async () => {
    await expect(
      readUnreadBody(new Request("http://app.test/"), 100),
    ).resolves.toBeUndefined();
  });
});
