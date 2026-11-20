import { SOCKET_PING, SOCKET_PONG } from "@parlor/sync";
import type { HostedSocket, SocketPlatform } from "@parlor/sync/server";

declare const WebSocketPair: new () => Record<"0" | "1", WebSocket>;
declare const WebSocketRequestResponsePair: new (
  request: string,
  response: string,
) => unknown;

/** The slice of a Durable Object's state the hibernation API needs. */
export interface HibernationState {
  acceptWebSocket(socket: WebSocket): void;
  setWebSocketAutoResponse(pair: unknown): void;
  getWebSockets(): WebSocket[];
  getWebSocketAutoResponseTimestamp(socket: WebSocket): Date | null;
  readonly storage: {
    getAlarm(): Promise<number | null>;
    setAlarm(at: number): Promise<void>;
  };
}

interface Hibernating extends WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/**
 * The sockets a Durable Object holds while it hibernates, as a `SocketPlatform`, with `of`
 * for the sockets its handlers are given. It answers `SOCKET_PING` without waking the object.
 */
export function hostedSockets(
  state: HibernationState,
): SocketPlatform & { of(socket: WebSocket): HostedSocket } {
  state.setWebSocketAutoResponse(
    new WebSocketRequestResponsePair(SOCKET_PING, SOCKET_PONG),
  );
  const wrapped = new WeakMap<WebSocket, HostedSocket>();
  const of = (socket: WebSocket) => {
    let hosted = wrapped.get(socket);
    if (!hosted) {
      const held = socket as Hibernating;
      hosted = {
        send(data: string) {
          try {
            held.send(data);
          } catch {
            // A socket that is closing drops it; its close ends the stream.
          }
        },
        close(code?: number, reason?: string) {
          try {
            held.close(code, reason);
          } catch {
            // Already closed.
          }
        },
        get attachment() {
          return held.deserializeAttachment();
        },
        attach(value: unknown) {
          held.serializeAttachment(value);
        },
        get answeredAt() {
          return state.getWebSocketAutoResponseTimestamp(held)?.getTime();
        },
      };
      wrapped.set(socket, hosted);
    }
    return hosted;
  };
  return {
    of,
    accept(_request: Request, attachment: unknown) {
      const [client, server] = Object.values(new WebSocketPair()) as [
        WebSocket,
        Hibernating,
      ];
      state.acceptWebSocket(server);
      server.serializeAttachment(attachment);
      return {
        response: new Response(null, { status: 101, webSocket: client } as ResponseInit),
        socket: of(server),
      };
    },
    sockets: () => state.getWebSockets().map(of),
    async wakeAt(at: number) {
      const due = await state.storage.getAlarm();
      if (due === null || due > at) await state.storage.setAlarm(at);
    },
  };
}
