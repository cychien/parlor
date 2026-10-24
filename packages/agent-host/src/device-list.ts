import { printable } from "./prompter.js";
import type { TrustedDevice, TrustStore } from "./trust.js";

const day = (at: number) => new Date(at).toLocaleDateString("en-CA");

function how(device: TrustedDevice, all: readonly TrustedDevice[]): string {
  if (device.via === "pairing") return "approved connect on this computer";
  if (device.via === "local") return "linked on this computer";
  const voucher = all.find((candidate) => candidate.deviceId === device.voucher);
  return `linked from ${voucher ? printable(voucher.name) : "a removed device"}`;
}

/** The devices that can use this computer's agents for one app, one per line. */
export function describeDevices(
  appName: string,
  devices: readonly TrustedDevice[],
): string {
  if (devices.length === 0) {
    return `No device can use your agents for ${printable(appName)} yet. Open the app's Agent sidebar on one to link it.\n`;
  }
  const lines = [...devices]
    .sort((a, b) => a.approvedAt - b.approvedAt)
    .map(
      (device) =>
        `  ${device.deviceId}  ${printable(device.name)}, ${day(device.approvedAt)}, ${how(device, devices)}`,
    );
  return `Devices that can use your agents for ${printable(appName)}:\n${lines.join("\n")}\n`;
}

/** Unlinks a device from this computer's agents; it must be linked again to use them. */
export async function removeDevice(
  trust: TrustStore,
  appOrigin: string,
  deviceId: string,
): Promise<TrustedDevice> {
  const device = await trust.get(appOrigin, deviceId);
  if (!device) {
    throw new Error(
      `No linked device ${deviceId}. Run \`npx @parlor/agent-host devices ${appOrigin}\` to list them.`,
    );
  }
  await trust.forget(appOrigin, deviceId);
  return device;
}
