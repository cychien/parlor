import { useLinkDevice, useSession } from "@parlor/client/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/link")({
  staticData: {
    description:
      "Link a new device to the user's agents: the page a linked phone opens from the new device's QR code.",
  },
  component: LinkDevice,
});

const BUTTON =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm enabled:hover:bg-zinc-100";
const PRIMARY = "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white";

/** The device id and commitment the QR put in the fragment, which never reaches a server. */
function scanned():
  | { readonly deviceId: string; readonly commitment: string }
  | undefined {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const deviceId = fragment.get("d");
  const commitment = fragment.get("c");
  return deviceId && commitment ? { deviceId, commitment } : undefined;
}

function LinkDevice() {
  const { available, state, check, confirm } = useLinkDevice();
  const session = useSession();
  const [target] = useState(scanned);
  useEffect(() => {
    if (available && target) void check(target);
  }, [available, target, check]);
  const account = session.status === "signed-in" ? session.user.email : "your account";

  return (
    <section aria-label="Link a device" className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Link a device</h1>
      {!target ? (
        <p>This link is missing the new device's code. Scan its QR code again.</p>
      ) : !available ? (
        <p>Linking needs sign-in on this device.</p>
      ) : state.step === "confirm" ? (
        <>
          <p className="text-lg">Link {state.device.name}?</p>
          <p className="text-zinc-600">
            It will be able to send requests to the agents on your computer, signed in as{" "}
            {account}. Only link a device you have with you.
          </p>
          <div className="flex gap-2">
            <Link to="/" className={BUTTON}>
              Cancel
            </Link>
            <button type="button" onClick={() => void confirm()} className={PRIMARY}>
              Link with Face ID or Touch ID
            </button>
          </div>
        </>
      ) : state.step === "linking" ? (
        <p className="text-zinc-600">Confirm with Face ID or Touch ID…</p>
      ) : state.step === "linked" ? (
        <>
          <p className="text-lg">{state.name} is linked</p>
          <p className="text-zinc-600">It can use your agents now.</p>
          <Link to="/" className={PRIMARY}>
            Done
          </Link>
        </>
      ) : state.step === "on-computer" ? (
        <>
          <p>
            This browser cannot confirm with Face ID or Touch ID. On your computer, run:
          </p>
          <code className="block rounded bg-zinc-100 p-2 text-sm wrap-anywhere">
            {state.command}
          </code>
        </>
      ) : state.step === "error" ? (
        <>
          <p role="alert" className="text-red-600">
            {state.message}
          </p>
          <button type="button" onClick={() => void check(target)} className={BUTTON}>
            Try again
          </button>
        </>
      ) : (
        <p className="text-zinc-600">Checking the new device…</p>
      )}
    </section>
  );
}
