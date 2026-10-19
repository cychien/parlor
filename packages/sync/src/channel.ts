import type { Principal } from "@parlor/core";

export interface ServerChannel {
  readonly event: string;
  connect(connection: ChannelConnection): () => void;
}

export interface ChannelConnection {
  readonly clientId: string | undefined;
  readonly scope: string;
  /** Who holds the stream; absent when the server resolves no identity. */
  readonly principal?: Principal | undefined;
  send(data: string): void;
}

export interface ClientChannel {
  readonly event: string;
  opened(): void;
  receive(data: string): void;
  closed(): void;
}
