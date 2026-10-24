import { platformAdapters } from "#adapters";

import { defineCapability } from "../capability.js";
import type { Files } from "./interface.js";

export type {
  Files,
  PickedFile,
  PickOptions,
  SaveOptions,
  SaveOutcome,
} from "./interface.js";
export {
  capacitorFiles,
  type CapacitorCacheWriter,
  type CapacitorShareModule,
} from "./capacitor.js";
export { tauriFiles, type TauriDialogModule, type TauriFsModule } from "./tauri.js";
export { webFiles, type WebFilesApis } from "./web.js";

export const files = defineCapability<Files>({
  name: "files",
  adapters: platformAdapters.files,
});
