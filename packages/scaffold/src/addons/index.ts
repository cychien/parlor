import { agent } from "./agent.js";
import { auth } from "./auth.js";

export const ADDONS = { agent, auth } as const;

export type AddonName = keyof typeof ADDONS;

export const ADDON_NAMES = Object.keys(ADDONS) as readonly AddonName[];

export function isAddonName(name: string): name is AddonName {
  return Object.hasOwn(ADDONS, name);
}
