import { connect } from "node:net";

import type { HostPairing, LocalHostStatus, PairingDevice } from "@parlor/capabilities";

import { onLines } from "./lines.js";
import type { HostRelease, ServiceClient } from "./service.js";

export const CONTROL_PROTOCOL = 1;

/**
 * Newline-delimited JSON on a 0600 Unix socket (a named pipe on Windows), spoken by the
 * `parlor-host` CLI and the desktop shell's Rust side. No TCP listener exists.
 */
export type ControlRequest =
  | { readonly op: "hello"; readonly client: ServiceClient }
  | { readonly op: "handover"; readonly binary: string; readonly signature: string }
  | { readonly op: "status" }
  | { readonly op: "connect"; readonly appOrigin: string }
  | { readonly op: "begin_local_pairing"; readonly appOrigin: string }
  | {
      readonly op: "finish_local_pairing";
      readonly appOrigin: string;
      readonly code: string;
    }
  | {
      readonly op: "confirm_local_pairing";
      readonly appOrigin: string;
      readonly connect: boolean;
      readonly device?: PairingDevice;
    }
  | { readonly op: "disconnect"; readonly appOrigin: string }
  | { readonly op: "dev_attach"; readonly appOrigin: string; readonly hostToken: string }
  | { readonly op: "dev_detach"; readonly appOrigin: string };

export type ControlOp = ControlRequest["op"];

/** One app the service holds a grant for, which `status` lists so two apps stay apart. */
export interface GrantSummary {
  readonly appOrigin: string;
  readonly appName: string;
  readonly grantId: string;
}

export type ControlFailure = { readonly ok: false; readonly error: string };

interface ControlReplies {
  readonly hello: { readonly ok: true; readonly release: HostRelease };
  readonly handover:
    | { readonly ok: true }
    | { readonly ok: false; readonly error: "unsigned" | "downgrade" };
  readonly status: {
    readonly ok: true;
    readonly status: LocalHostStatus;
    readonly grants: readonly GrantSummary[];
  };
  readonly connect: { readonly ok: true };
  readonly begin_local_pairing: { readonly ok: true; readonly pairing: HostPairing };
  readonly finish_local_pairing: {
    readonly ok: true;
    readonly account: string;
    readonly appName: string;
    readonly matchingCode: string;
  };
  readonly confirm_local_pairing:
    | { readonly ok: true }
    | { readonly ok: false; readonly error: "declined_locally" };
  readonly disconnect: { readonly ok: true };
  readonly dev_attach: { readonly ok: true };
  readonly dev_detach: { readonly ok: true };
}

export type ControlResponse<O extends ControlOp> = ControlReplies[O] | ControlFailure;

export interface ControlClient {
  send<R extends ControlRequest>(request: R): Promise<ControlResponse<R["op"]>>;
  close(): void;
}

/** `undefined` when no daemon answers on the socket. */
export async function connectControl(
  socketPath: string,
): Promise<ControlClient | undefined> {
  const socket = connect(socketPath);
  const connected = await new Promise<boolean>((resolve) => {
    socket.once("connect", () => resolve(true));
    socket.once("error", () => resolve(false));
  });
  if (!connected) {
    socket.destroy();
    return undefined;
  }
  const waiting: ((line: string | undefined) => void)[] = [];
  onLines(socket, (line) => waiting.shift()?.(line));
  socket.on("close", () => {
    for (const reply of waiting.splice(0)) reply(undefined);
  });
  socket.on("error", () => socket.destroy());
  return {
    send: (request) =>
      new Promise((resolve) => {
        waiting.push((line) =>
          resolve(
            line === undefined
              ? { ok: false, error: "Parlor Host closed the connection." }
              : JSON.parse(line),
          ),
        );
        socket.write(`${JSON.stringify(request)}\n`);
      }),
    close: () => socket.end(),
  };
}
