import type { CapabilityAdapter } from "../capability.js";
import { detectPlatform } from "../runtime.js";
import type { Files, PickedFile } from "./interface.js";
import { bytesOf, extensionsOf, nameOf, typeOf } from "./mime.js";

type Filters = { name: string; extensions: string[] }[];

export interface TauriDialogModule {
  open(options: {
    multiple: boolean;
    directory: false;
    filters?: Filters;
  }): Promise<string | string[] | null>;
  save(options: { defaultPath: string; filters?: Filters }): Promise<string | null>;
}

export interface TauriFsModule {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  stat(path: string): Promise<{ size: number }>;
}

const filtersFor = (extensions: string[] | undefined): Filters | undefined =>
  extensions ? [{ name: "Files", extensions }] : undefined;

export function tauriFiles(
  loadDialog: () => Promise<TauriDialogModule> = () =>
    import("@tauri-apps/plugin-dialog"),
  loadFs: () => Promise<TauriFsModule> = () => import("@tauri-apps/plugin-fs"),
): CapabilityAdapter<Files> {
  return {
    platform: "tauri",
    available: () => detectPlatform() === "tauri",
    create: async () => {
      const [dialog, fs] = await Promise.all([loadDialog(), loadFs()]);
      const pickedAt = async (path: string): Promise<PickedFile> => {
        const name = nameOf(path);
        return {
          name,
          type: typeOf(name),
          size: (await fs.stat(path)).size,
          bytes: () => fs.readFile(path),
          text: async () => new TextDecoder().decode(await fs.readFile(path)),
        };
      };
      return {
        pick: async (options = {}) => {
          const filters = filtersFor(extensionsOf(options.accept));
          const chosen = await dialog.open({
            multiple: options.multiple === true,
            directory: false,
            ...(filters ? { filters } : {}),
          });
          const paths = chosen === null ? [] : Array.isArray(chosen) ? chosen : [chosen];
          return Promise.all(paths.map(pickedAt));
        },
        save: async (data, options) => {
          const filters = filtersFor(
            extensionsOf(options.type ? [options.type] : undefined),
          );
          const path = await dialog.save({
            defaultPath: options.name,
            ...(filters ? { filters } : {}),
          });
          if (path === null) return "cancelled";
          await fs.writeFile(path, await bytesOf(data));
          return "saved";
        },
      };
    },
  };
}
