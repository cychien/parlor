import { useCallback, useMemo, useRef, useState } from "react";

import { appOrigin } from "../action-client.js";
import type { PendingLink } from "../session.js";
import { useFramework } from "./provider.js";

/**
 * Linking another device from this one: `check` the code it shows, `confirm` with Face ID or
 * Touch ID. A device without a presence key gets the command that links from the computer.
 */
export type LinkDeviceState =
  | { readonly step: "idle" }
  | { readonly step: "checking" }
  | {
      readonly step: "confirm";
      readonly device: { readonly name: string; readonly platform: string };
    }
  | { readonly step: "linking" }
  | { readonly step: "linked"; readonly name: string }
  | {
      readonly step: "on-computer";
      readonly device: { readonly name: string; readonly platform: string };
      readonly command: string;
    }
  | { readonly step: "error"; readonly message: string };

const IDLE: LinkDeviceState = { step: "idle" };

const messageOf = (error: unknown): string => {
  if (error instanceof Error && error.name === "NotAllowedError") {
    return "Face ID or Touch ID was cancelled, so nothing was linked.";
  }
  return error instanceof Error && error.message
    ? error.message
    : "That did not work. Try again.";
};

export function useLinkDevice(): {
  readonly available: boolean;
  readonly state: LinkDeviceState;
  check(code: string): Promise<void>;
  confirm(): Promise<void>;
  reset(): void;
} {
  const { auth } = useFramework();
  const [state, setState] = useState<LinkDeviceState>(IDLE);
  const pending = useRef<PendingLink | undefined>(undefined);
  const available = Boolean(auth?.resolveLink && auth.vouch && auth.canVouch);

  const check = useCallback(
    async (code: string) => {
      if (!auth?.resolveLink || !auth.canVouch) return;
      setState({ step: "checking" });
      try {
        const link = await auth.resolveLink(code);
        pending.current = link;
        const device = { name: link.name, platform: link.platform };
        setState(
          (await auth.canVouch())
            ? { step: "confirm", device }
            : {
                step: "on-computer",
                device,
                command: `npx @parlor/agent-host link ${appOrigin()} ${code.toUpperCase().replace(/[\s-]/g, "")}`,
              },
        );
      } catch (error) {
        setState({ step: "error", message: messageOf(error) });
      }
    },
    [auth],
  );

  const confirm = useCallback(async () => {
    const link = pending.current;
    if (!auth?.vouch || !link) return;
    setState({ step: "linking" });
    try {
      await auth.vouch(link);
      pending.current = undefined;
      setState({ step: "linked", name: link.name });
    } catch (error) {
      setState({ step: "error", message: messageOf(error) });
    }
  }, [auth]);

  const reset = useCallback(() => {
    pending.current = undefined;
    setState(IDLE);
  }, []);

  return useMemo(
    () => ({ available, state, check, confirm, reset }),
    [available, state, check, confirm, reset],
  );
}
