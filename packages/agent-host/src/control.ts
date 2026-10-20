import { connect } from "node:net";
import { createInterface } from "node:readline";

import type { LocalHostStatus } from "@parlor/capabilities";

export const CONTROL_PROTOCOL = 1;

/**
 * Newline-delimited JSON on a 0600 Unix socket (a named pipe on Windows), spoken by the
 * `parlor-host` CLI and the desktop shell's Rust side. No TCP listener exists.
 */
export type ControlRequest =
  | { readonly op: "status" }
  | { readonly op: "connect"; readonly appOrigin: string }
  | { readonly op: "disconnect"; readonly appOrigin: string }
  | { readonly op: "dev_attach"; readonly appOrigin: string; readonly hostToken: string }
  | { readonly op: "dev_detach"; readonly appOrigin: string };

export type ControlOp = ControlRequest["op"];

export type ControlFailure = { readonly ok: false; readonly error: string };

interface ControlReplies {
  readonly status: { readonly ok: true; readonly status: LocalHostStatus };
  readonly connect: { readonly ok: true };
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
  createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) =>
    waiting.shift()?.(line),
  );
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
