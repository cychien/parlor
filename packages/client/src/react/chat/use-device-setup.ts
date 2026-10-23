import { useEffect, useMemo } from "react";

import { useChatRuntime, useChatState } from "./context.js";
import type { DeviceSetup, DeviceSetupCommands } from "./runtime.js";

/**
 * For a UI that explains setting this device up: while it is mounted, the first prompt on a
 * browser that would create a passkey waits in `setup` until the user picks.
 */
export function useDeviceSetup(): DeviceSetupCommands & {
  readonly setup: DeviceSetup | undefined;
} {
  const runtime = useChatRuntime("useDeviceSetup");
  const { setup } = useChatState("useDeviceSetup");
  useEffect(() => runtime.explainSetup(), [runtime]);
  return useMemo(
    () => ({
      setup,
      setUpDevice: runtime.setUpDevice,
      dismissSetup: runtime.dismissSetup,
    }),
    [setup, runtime],
  );
}
