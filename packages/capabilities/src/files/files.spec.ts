import { afterEach, describe, expect, it, vi } from "vitest";

import { webFiles } from "./web.js";

afterEach(() => {
  document.body.replaceChildren();
});

/** The hidden input `pick` adds, answered as the user would. */
async function answerInput(files: File[] | "cancel") {
  await vi.waitFor(() =>
    expect(document.querySelector("input[type=file]")).not.toBeNull(),
  );
  const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
  if (files === "cancel") {
    input.dispatchEvent(new Event("cancel"));
  } else {
    Object.defineProperty(input, "files", { value: files });
    input.dispatchEvent(new Event("change"));
  }
  return input;
}

describe("webFiles", () => {
  it("is unavailable without a document", () => {
    expect(webFiles(() => ({ document: undefined })).available()).toBe(false);
  });

  it("picks through a hidden file input with the accept and multiple asked for, then removes it", async () => {
    const files = webFiles(() => ({ document })).create();
    const picking = files.pick({ accept: ["image/*", ".pdf"], multiple: true });
    const input = await answerInput([
      new File(["hello"], "a.txt", { type: "text/plain" }),
      new File([new Uint8Array([1, 2, 3])], "b.png", { type: "image/png" }),
    ]);
    expect([input.accept, input.multiple]).toEqual(["image/*,.pdf", true]);
    const picked = await picking;
    expect(picked.map((file) => [file.name, file.type, file.size])).toEqual([
      ["a.txt", "text/plain", 5],
      ["b.png", "image/png", 3],
    ]);
    expect(await picked[0]!.text()).toBe("hello");
    expect([...(await picked[1]!.bytes())]).toEqual([1, 2, 3]);
    expect(document.querySelector("input[type=file]")).toBeNull();
  });

  it("gives an empty list when the user cancels", async () => {
    const files = webFiles(() => ({ document })).create();
    const picking = files.pick();
    await answerInput("cancel");
    await expect(picking).resolves.toEqual([]);
  });

  it("saves through the save dialog where there is one, and says when it was dismissed", async () => {
    const written: Blob[] = [];
    let dismiss = false;
    const showSaveFilePicker = vi.fn(async () => {
      if (dismiss) throw new DOMException("closed", "AbortError");
      return {
        createWritable: async () => ({
          write: async (data: Blob) => void written.push(data),
          close: async () => undefined,
        }),
      };
    });
    const files = webFiles(() => ({ document, showSaveFilePicker })).create();
    await expect(
      files.save("a,b\n", { name: "out.csv", type: "text/csv" }),
    ).resolves.toBe("saved");
    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: "out.csv" });
    expect(await written[0]!.text()).toBe("a,b\n");
    dismiss = true;
    await expect(files.save("x", { name: "x.txt" })).resolves.toBe("cancelled");
  });

  it("calls the browser's own save dialog on window, as the browser requires", async () => {
    const global = globalThis as { showSaveFilePicker?: unknown };
    global.showSaveFilePicker = function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.reject(new DOMException("closed", "AbortError"));
    };
    try {
      const files = webFiles().create();
      await expect(files.save("x", { name: "x.txt" })).resolves.toBe("cancelled");
    } finally {
      delete global.showSaveFilePicker;
    }
  });

  it("downloads where the browser has no save dialog", async () => {
    const clicks: { download: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push({ download: this.download, href: this.href });
    });
    const files = webFiles(() => ({ document })).create();
    await expect(files.save(new Uint8Array([1]), { name: "a.bin" })).resolves.toBe(
      "saved",
    );
    expect(clicks).toEqual([
      { download: "a.bin", href: expect.stringMatching(/^blob:/) },
    ]);
    expect(document.querySelector("a")).toBeNull();
  });
});
