import { connect } from "node:net";

import { onLines } from "./lines.js";
import type { HostRelease, ServiceClient } from "./service.js";

export const CONTROL_PROTOCOL = 1;

/**
 * Newline-delimited JSON on a 0600 Unix socket (a named pipe on Windows), spoken by the
 * `parlor-host` CLI. No TCP listener exists.
 */
export type ControlRequest =
  | { readonly op: "hello"; readonly client: ServiceClient }
  /** A newer CLI asks the service to hand over to it. */
  | { readonly op: "step_aside"; readonly release: HostRelease }
  | { readonly op: "status" }
  | { readonly op: "connect"; readonly appOrigin: string }
  | { readonly op: "disconnect"; readonly appOrigin: string }
  | { readonly op: "agent_tools"; readonly appOrigin: string; readonly on: boolean }
  | { readonly op: "dev_attach"; readonly appOrigin: string; readonly hostToken: string }
  | { readonly op: "dev_detach"; readonly appOrigin: string };

export type ControlOp = ControlRequest["op"];

export interface GrantSummary {
  readonly appOrigin: string;
  readonly appName: string;
  readonly grantId: string;
}

/** The app's MCP server name in the coding agents on this computer, and which have it. */
export interface AgentToolsSummary {
  readonly name: string;
  readonly agents: string;
}

export type LocalHostStatus =
  | { readonly state: "stopped" }
  | {
      readonly state: "running";
      readonly version: string;
      /** App origins this host holds a grant for. */
      readonly apps: readonly string[];
    };

export type ControlFailure = { readonly ok: false; readonly error: string };

interface ControlReplies {
  readonly hello: { readonly ok: true; readonly release: HostRelease };
  readonly step_aside:
    | { readonly ok: true }
    | { readonly ok: false; readonly error: "downgrade" };
  readonly status: {
    readonly ok: true;
    readonly status: LocalHostStatus;
    readonly grants: readonly GrantSummary[];
  };
  readonly connect: { readonly ok: true; readonly agentTools?: AgentToolsSummary };
  readonly disconnect: { readonly ok: true; readonly agentTools?: AgentToolsSummary };
  readonly agent_tools: { readonly ok: true; readonly agentTools?: AgentToolsSummary };
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
