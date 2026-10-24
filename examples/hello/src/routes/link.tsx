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
    <section aria-label="Link a device" className="stack">
      <h1>Link a device</h1>
      {!target ? (
        <p>This link is missing the new device's code. Scan its QR code again.</p>
      ) : !available ? (
        <p>Linking needs sign-in on this device.</p>
      ) : state.step === "confirm" ? (
        <>
          <p>
            <strong>Link {state.device.name}?</strong>
          </p>
          <p>
            It will be able to send requests to the agents on your computer, signed in as{" "}
            {account}. Only link a device you have with you.
          </p>
          <p>
            <Link to="/">Cancel</Link>{" "}
            <button type="button" className="primary" onClick={() => void confirm()}>
              Link with Face ID or Touch ID
            </button>
          </p>
        </>
      ) : state.step === "linking" ? (
        <p>Confirm with Face ID or Touch ID…</p>
      ) : state.step === "linked" ? (
        <>
          <p>
            <strong>{state.name} is linked</strong>
          </p>
          <p>It can use your agents now.</p>
          <Link to="/">Done</Link>
        </>
      ) : state.step === "on-computer" ? (
        <>
          <p>
            This browser cannot confirm with Face ID or Touch ID. On your computer, run:
          </p>
          <code className="connect-command">{state.command}</code>
        </>
      ) : state.step === "error" ? (
        <>
          <p className="problem" role="alert">
            {state.message}
          </p>
          <button type="button" onClick={() => void check(target)}>
            Try again
          </button>
        </>
      ) : (
        <p>Checking the new device…</p>
      )}
    </section>
  );
}
