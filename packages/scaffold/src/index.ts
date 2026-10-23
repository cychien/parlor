export type { ProjectLayout } from "./add/addon.js";
export {
  type AddRequest,
  type AddResult,
  addAddons,
  type AddTools,
  formatAddResult,
} from "./add/run.js";
export { ADDON_NAMES, type AddonName, isAddonName } from "./addons/index.js";
export { type CreatedProject, type CreateOptions, createProject } from "./create.js";
export { inspectServerEntry, type Presence, type ServerShape } from "./edit/inspect.js";
export { CreateError } from "./errors.js";
export {
  commandsFor,
  detectProjectPackageManager,
  formatCommand,
  fromUserAgent,
  PACKAGE_MANAGERS,
  type PackageManager,
  type PackageManagerCommands,
  type PackageManagerName,
} from "./package-manager.js";
export { DOCS_URL, FRAMEWORK_VERSION } from "./version.js";
