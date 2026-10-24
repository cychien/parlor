import type { CapabilityAdapter } from "../capability.js";
import { detectPlatform } from "../runtime.js";
import type { Files } from "./interface.js";
import { bytesOf } from "./mime.js";
import { pickWithInput } from "./web.js";

/** `@capacitor/filesystem`, narrowed to writing base64 into the app's cache. */
export interface CapacitorCacheWriter {
  writeToCache(path: string, base64: string): Promise<{ uri: string }>;
}

const filesystemCache = async (): Promise<CapacitorCacheWriter> => {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  return {
    writeToCache: (path, data) =>
      Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true }),
  };
};

export interface CapacitorShareModule {
  Share: { share(options: { title?: string; files: string[] }): Promise<unknown> };
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

/** The share sheet reports a dismissal as an error whose message says it was canceled. */
const wasCancelled = (error: unknown) =>
  error instanceof Error && /cancel/i.test(error.message);

/** Picks with the webview's own file input; saves through the share sheet ("Save to Files"). */
export function capacitorFiles(
  loadCache: () => Promise<CapacitorCacheWriter> = filesystemCache,
  loadShare: () => Promise<CapacitorShareModule> = () => import("@capacitor/share"),
  getDocument: () => Document | undefined = () => globalThis.document,
): CapabilityAdapter<Files> {
  return {
    platform: "capacitor",
    available: () => detectPlatform() === "capacitor" && getDocument() !== undefined,
    create: async () => {
      const document = getDocument();
      if (!document) throw new Error("Files need a document");
      const [cache, { Share }] = await Promise.all([loadCache(), loadShare()]);
      return {
        pick: (options) => pickWithInput(document, options),
        save: async (data, options) => {
          const { uri } = await cache.writeToCache(
            `parlor-save/${options.name}`,
            base64Of(await bytesOf(data)),
          );
          try {
            await Share.share({ title: options.name, files: [uri] });
            return "saved";
          } catch (error) {
            if (wasCancelled(error)) return "cancelled";
            throw error;
          }
        },
      };
    },
  };
}
