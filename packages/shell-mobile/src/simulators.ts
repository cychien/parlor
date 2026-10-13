import { spawnSync } from "node:child_process";

import { CapacitorCliError } from "./capacitor-cli.js";

export interface IosSimulator {
  readonly udid: string;
  readonly name: string;
  readonly runtime: string;
  readonly state: string;
}

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
}

export function parseSimctlList(json: string): IosSimulator[] {
  const parsed = JSON.parse(json) as { devices: Record<string, SimctlDevice[]> };
  return Object.entries(parsed.devices)
    .filter(([runtime]) => runtime.includes("iOS"))
    .flatMap(([runtime, devices]) =>
      devices
        .filter((device) => device.isAvailable !== false)
        .map((device) => ({
          udid: device.udid,
          name: device.name,
          runtime,
          state: device.state,
        })),
    );
}

export function listIosSimulators(run: typeof spawnSync = spawnSync): IosSimulator[] {
  const result = run("xcrun", ["simctl", "list", "devices", "available", "-j"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new CapacitorCliError("Could not list iOS simulators with `xcrun simctl`.");
  }
  return parseSimctlList(String(result.stdout));
}

function runtimeVersion(runtime: string): number {
  const match = runtime.match(/iOS-(\d+)-(\d+)/);
  return match ? Number(match[1]) * 100 + Number(match[2]) : 0;
}

export function pickIosSimulator(
  simulators: readonly IosSimulator[],
  preferred?: string | undefined,
): IosSimulator {
  if (preferred) {
    const match = simulators.find((s) => s.udid === preferred || s.name === preferred);
    if (!match) {
      throw new CapacitorCliError(
        `No iOS simulator named "${preferred}". Available: ${simulators.map((s) => s.name).join(", ")}`,
      );
    }
    return match;
  }
  const booted = simulators.find((s) => s.state === "Booted");
  if (booted) return booted;
  const iphones = simulators
    .filter((s) => s.name.startsWith("iPhone"))
    .sort(
      (a, b) =>
        runtimeVersion(b.runtime) - runtimeVersion(a.runtime) ||
        a.name.localeCompare(b.name),
    );
  const pick = iphones[0] ?? simulators[0];
  if (!pick)
    throw new CapacitorCliError("No iOS simulators are installed. Add one in Xcode.");
  return pick;
}
