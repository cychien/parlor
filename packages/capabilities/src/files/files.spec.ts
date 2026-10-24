import { afterEach, describe, expect, it, vi } from "vitest";

import { capacitorFiles } from "./capacitor.js";
import { extensionsOf, nameOf, typeOf } from "./mime.js";
import { tauriFiles } from "./tauri.js";
import { webFiles } from "./web.js";

const globals = globalThis as {
  __TAURI_INTERNALS__?: unknown;
  Capacitor?: { isNativePlatform?: () => boolean };
};

afterEach(() => {
  delete globals.__TAURI_INTERNALS__;
  delete globals.Capacitor;
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

describe("file types and dialog filters", () => {
  it("names a type by extension, a file by its last path segment", () => {
    expect([typeOf("Notes.PDF"), typeOf("photo.jpeg"), typeOf("data.bin")]).toEqual([
      "application/pdf",
      "image/jpeg",
      "",
    ]);
    expect([nameOf("/Users/a/Report.txt"), nameOf("C:\\docs\\a.csv")]).toEqual([
      "Report.txt",
      "a.csv",
    ]);
  });

  it("turns accept into extensions, and gives none rather than hide a file it cannot name", () => {
    expect(extensionsOf([".pdf", "text/csv"])).toEqual(["pdf", "csv"]);
    expect(extensionsOf(["image/*"])).toEqual(
      expect.arrayContaining(["png", "jpg", "jpeg", "gif", "webp", "heic", "svg"]),
    );
    expect(extensionsOf(["application/x-custom"])).toBeUndefined();
    expect(extensionsOf(undefined)).toBeUndefined();
  });
});

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

describe("tauriFiles", () => {
  function fakeTauri(answer: string | string[] | null, saveTo: string | null = null) {
    const disk = new Map<string, Uint8Array>([
      ["/Users/a/notes.txt", new TextEncoder().encode("note")],
      ["/Users/a/b.png", new Uint8Array([9, 9])],
    ]);
    const dialog = {
      open: vi.fn(async () => answer),
      save: vi.fn(async () => saveTo),
    };
    const fs = {
      readFile: vi.fn(async (path: string) => disk.get(path)!),
      writeFile: vi.fn(
        async (path: string, data: Uint8Array) => void disk.set(path, data),
      ),
      stat: vi.fn(async (path: string) => ({ size: disk.get(path)!.length })),
    };
    return {
      adapter: tauriFiles(
        async () => dialog,
        async () => fs,
      ),
      dialog,
      disk,
    };
  }

  it("is available only inside Tauri", () => {
    expect(fakeTauri(null).adapter.available()).toBe(false);
    globals.__TAURI_INTERNALS__ = {};
    expect(fakeTauri(null).adapter.available()).toBe(true);
  });

  it("picks with the native open dialog, filtered by extension, and reads the files it chose", async () => {
    const { adapter, dialog } = fakeTauri(["/Users/a/notes.txt", "/Users/a/b.png"]);
    const files = await adapter.create();
    const picked = await files.pick({ accept: [".txt", "image/png"], multiple: true });
    expect(dialog.open).toHaveBeenCalledWith({
      multiple: true,
      directory: false,
      filters: [{ name: "Files", extensions: ["txt", "png"] }],
    });
    expect(picked.map((file) => [file.name, file.type, file.size])).toEqual([
      ["notes.txt", "text/plain", 4],
      ["b.png", "image/png", 2],
    ]);
    expect(await picked[0]!.text()).toBe("note");
  });

  it("gives an empty list when the dialog is dismissed", async () => {
    const files = await fakeTauri(null).adapter.create();
    await expect(files.pick()).resolves.toEqual([]);
  });

  it("saves where the native save dialog says, or reports it was dismissed", async () => {
    const saving = fakeTauri(null, "/Users/a/out.csv");
    const files = await saving.adapter.create();
    await expect(files.save("a,b", { name: "out.csv", type: "text/csv" })).resolves.toBe(
      "saved",
    );
    expect(saving.dialog.save).toHaveBeenCalledWith({
      defaultPath: "out.csv",
      filters: [{ name: "Files", extensions: ["csv"] }],
    });
    expect(new TextDecoder().decode(saving.disk.get("/Users/a/out.csv"))).toBe("a,b");
    const dismissed = await fakeTauri(null, null).adapter.create();
    await expect(dismissed.save("x", { name: "x.txt" })).resolves.toBe("cancelled");
  });
});

describe("capacitorFiles", () => {
  function fakeCapacitor(shareFails?: Error) {
    const cached = new Map<string, string>();
    const share = vi.fn(async () => {
      if (shareFails) throw shareFails;
    });
    const adapter = capacitorFiles(
      async () => ({
        writeToCache: async (path, base64) => {
          cached.set(path, base64);
          return { uri: `file:///cache/${path}` };
        },
      }),
      async () => ({ Share: { share } }),
      () => document,
    );
    return { adapter, cached, share };
  }

  it("is available only in a native Capacitor app", () => {
    expect(fakeCapacitor().adapter.available()).toBe(false);
    globals.Capacitor = { isNativePlatform: () => true };
    expect(fakeCapacitor().adapter.available()).toBe(true);
  });

  it("picks with the webview's own file input", async () => {
    const files = await fakeCapacitor().adapter.create();
    const picking = files.pick({ accept: ["image/*"] });
    await answerInput([new File(["x"], "photo.heic", { type: "image/heic" })]);
    expect((await picking).map((file) => file.name)).toEqual(["photo.heic"]);
  });

  it("saves through the share sheet from the app's cache, and reports a dismissed sheet", async () => {
    const shared = fakeCapacitor();
    const files = await shared.adapter.create();
    await expect(files.save("hi", { name: "note.txt" })).resolves.toBe("saved");
    expect(shared.cached.get("parlor-save/note.txt")).toBe(btoa("hi"));
    expect(shared.share).toHaveBeenCalledWith({
      title: "note.txt",
      files: ["file:///cache/parlor-save/note.txt"],
    });
    const dismissed = await fakeCapacitor(new Error("Share canceled")).adapter.create();
    await expect(dismissed.save("hi", { name: "note.txt" })).resolves.toBe("cancelled");
    const broken = await fakeCapacitor(new Error("No space left")).adapter.create();
    await expect(broken.save("hi", { name: "note.txt" })).rejects.toThrow(
      "No space left",
    );
  });
});
