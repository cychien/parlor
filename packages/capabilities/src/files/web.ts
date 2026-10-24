import type { CapabilityAdapter } from "../capability.js";
import type {
  Files,
  PickedFile,
  PickOptions,
  SaveOptions,
  SaveOutcome,
} from "./interface.js";
import { bytesOf } from "./mime.js";

interface SaveFilePicker {
  (options: { suggestedName: string }): Promise<{
    createWritable(): Promise<{
      write(data: Blob): Promise<void>;
      close(): Promise<void>;
    }>;
  }>;
}

export interface WebFilesApis {
  readonly document: Document | undefined;
  readonly showSaveFilePicker?: SaveFilePicker | undefined;
}

const browserApis = (): WebFilesApis => ({
  document: globalThis.document,
  showSaveFilePicker: (
    globalThis as { showSaveFilePicker?: SaveFilePicker }
  ).showSaveFilePicker?.bind(globalThis),
});

const pickedFrom = (file: File): PickedFile => ({
  name: file.name,
  type: file.type,
  size: file.size,
  bytes: async () => new Uint8Array(await file.arrayBuffer()),
  text: () => file.text(),
});

/** An `<input type="file">` the user answers or cancels; also what a phone's webview shows. */
export function pickWithInput(
  document: Document,
  options: PickOptions = {},
): Promise<readonly PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.hidden = true;
    if (options.accept?.length) input.accept = options.accept.join(",");
    input.multiple = options.multiple === true;
    const done = (files: readonly PickedFile[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () =>
      done([...(input.files ?? [])].map(pickedFrom)),
    );
    input.addEventListener("cancel", () => done([]));
    document.body.append(input);
    input.click();
  });
}

function download(document: Document, blob: Blob, name: string): SaveOutcome {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "saved";
}

async function saveInBrowser(
  apis: WebFilesApis,
  document: Document,
  data: Blob | Uint8Array | string,
  options: SaveOptions,
): Promise<SaveOutcome> {
  const blob = new Blob([new Uint8Array(await bytesOf(data))], {
    type: options.type ?? "",
  });
  if (!apis.showSaveFilePicker) return download(document, blob, options.name);
  try {
    const handle = await apis.showSaveFilePicker({ suggestedName: options.name });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return "saved";
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return "cancelled";
    if (error instanceof Error && error.name === "SecurityError") {
      return download(document, blob, options.name);
    }
    throw error;
  }
}

export function webFiles(
  getApis: () => WebFilesApis = browserApis,
): CapabilityAdapter<Files> {
  return {
    platform: "web",
    available: () => getApis().document !== undefined,
    create: () => {
      const apis = getApis();
      const { document } = apis;
      if (!document) throw new Error("Files need a document");
      return {
        pick: (options) => pickWithInput(document, options),
        save: (data, options) => saveInBrowser(apis, document, data, options),
      };
    },
  };
}
