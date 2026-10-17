import type {
  AgentOrigin,
  UiError,
  UiOp,
  UiOpInput,
  UiOpResults,
  UiReply,
} from "../protocol.js";
import type { ClientTarget } from "./directory.js";

export class UiFailure extends Error {
  constructor(readonly error: UiError) {
    super(error.message);
  }
}

export interface BrokerOptions {
  readonly timeoutMs: number;
  readonly maxPendingPerClient?: number | undefined;
  readonly maxPending?: number | undefined;
  readonly newId?: (() => string) | undefined;
  readonly now?: (() => number) | undefined;
  readonly setTimeout?: typeof globalThis.setTimeout | undefined;
  readonly clearTimeout?: typeof globalThis.clearTimeout | undefined;
}

export interface UiReceipt {
  readonly accepted: boolean;
  readonly next?: string | undefined;
}

export class UiBroker {
  constructor(options: BrokerOptions) {
    void options;
    throw new Error("not implemented");
  }

  request<O extends UiOp>(
    target: ClientTarget,
    op: O,
    input: UiOpInput<O>,
    origin: AgentOrigin,
    signal?: AbortSignal,
  ): Promise<UiOpResults[O]> {
    void target;
    void op;
    void input;
    void origin;
    void signal;
    throw new Error("not implemented");
  }

  reply(clientId: string, reply: UiReply): UiReceipt {
    void clientId;
    void reply;
    throw new Error("not implemented");
  }

  reconnected(target: ClientTarget): void {
    void target;
    throw new Error("not implemented");
  }

  abandon(clientId: string): void {
    void clientId;
    throw new Error("not implemented");
  }

  close(): void {
    throw new Error("not implemented");
  }
}
