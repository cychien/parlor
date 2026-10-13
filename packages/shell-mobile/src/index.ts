export { buildMobile } from "./build.js";
export {
  CapacitorCliError,
  runCapacitor,
  type RunCapacitorOptions,
} from "./capacitor-cli.js";
export { CAPACITOR_CONDITION, type MobileDevOptions, startMobileDev } from "./dev.js";
export { withUrlScheme } from "./ios-plist.js";
export {
  type IosSimulator,
  listIosSimulators,
  parseSimctlList,
  pickIosSimulator,
} from "./simulators.js";
export { applyIosScheme, ensurePlatform, IOS_INFO_PLIST } from "./platforms.js";
export {
  assertMobileToolchain,
  hasAndroidSdk,
  hasXcode,
  type MobilePlatform,
} from "./prerequisites.js";
export {
  CAPACITOR_PLUGINS,
  capacitorConfig,
  capacitorProjectDir,
  capacitorProjectFiles,
  ensureCapacitorProject,
} from "./project.js";
