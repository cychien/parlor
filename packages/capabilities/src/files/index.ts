import { defineCapability } from "../capability.js";
import type { Files } from "./interface.js";
import { webFiles } from "./web.js";

export type {
  Files,
  PickedFile,
  PickOptions,
  SaveOptions,
  SaveOutcome,
} from "./interface.js";
export { webFiles, type WebFilesApis } from "./web.js";

export const files = defineCapability<Files>({
  name: "files",
  adapters: [webFiles()],
});
