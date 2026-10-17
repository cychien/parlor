import type { ChannelConnection } from "@parlor/sync";

import type { ClientSummary, PresenceUpdate } from "../protocol.js";

export interface ConnectedClient {
  readonly id: string;
  readonly scope: string;
  readonly platform: string;
  readonly buildId: string | undefined;
  readonly focused: boolean;
  readonly visible: boolean;
  readonly seenAt: number;
}

export interface ClientTarget {
  readonly client: ConnectedClient;
  send(data: string): boolean;
}

export interface Selection {
  readonly target: ClientTarget;
  readonly tied: readonly ConnectedClient[];
}

export type PresenceOutcome = "rejected" | "updated" | "registered";

export class ClientDirectory {
  constructor(now: () => number = Date.now) {
    void now;
    throw new Error("not implemented");
  }

  connect(connection: ChannelConnection): () => void {
    void connection;
    throw new Error("not implemented");
  }

  touch(clientId: string | undefined): void {
    void clientId;
    throw new Error("not implemented");
  }

  presence(clientId: string, scope: string, update: PresenceUpdate): PresenceOutcome {
    void clientId;
    void scope;
    void update;
    throw new Error("not implemented");
  }

  leave(clientId: string, scope: string): boolean {
    void clientId;
    void scope;
    throw new Error("not implemented");
  }

  connected(scope: string, clientId: string): boolean {
    void scope;
    void clientId;
    throw new Error("not implemented");
  }

  target(clientId: string): ClientTarget | undefined {
    void clientId;
    throw new Error("not implemented");
  }

  select(scope: string, clientId?: string): Selection | undefined {
    void scope;
    void clientId;
    throw new Error("not implemented");
  }

  summaries(scope: string): ClientSummary[] {
    void scope;
    throw new Error("not implemented");
  }

  summary(client: ConnectedClient): ClientSummary {
    void client;
    throw new Error("not implemented");
  }
}
