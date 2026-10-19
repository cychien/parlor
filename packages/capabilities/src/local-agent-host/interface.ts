/**
 * Parlor Host on this very computer, reachable without the network. Available only in a
 * desktop shell built with `desktop.agentHost`; elsewhere the chat shows the install
 * command instead.
 */
export interface LocalAgentHost {
  status(): Promise<LocalHostStatus>;
  /**
   * Pairs this computer's host with the signed-in account: the host starts the pairing,
   * `authorize` gets the code from the backend with the page's session, and the host
   * confirms the account and matching code in a native dialog the page cannot skip.
   */
  connect(input: LocalConnectInput): Promise<LocalConnectResult>;
}

export type LocalHostStatus =
  | { readonly state: "stopped" }
  | {
      readonly state: "running";
      readonly version: string;
      /** App origins this host holds a grant for. */
      readonly apps: readonly string[];
    };

export interface LocalConnectInput {
  readonly appOrigin: string;
  authorize(pairing: HostPairing): Promise<string>;
}

/** What the backend's host authorize endpoint needs from the host, and shows on consent. */
export interface HostPairing {
  readonly hostName: string;
  readonly platform: string;
  readonly codeChallenge: string;
  readonly state: string;
  readonly matchingCode: string;
  readonly keyThumbprint: string;
}

export type LocalConnectResult =
  | { readonly connected: true }
  | { readonly connected: false; readonly reason: "declined_locally" | "failed" };
