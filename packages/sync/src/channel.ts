export interface ServerChannel {
  readonly event: string;
  connect(connection: ChannelConnection): () => void;
}

export interface ChannelConnection {
  readonly clientId: string | undefined;
  readonly scope: string;
  send(data: string): void;
}

export interface ClientChannel {
  readonly event: string;
  opened(): void;
  receive(data: string): void;
  closed(): void;
}
