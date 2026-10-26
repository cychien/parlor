type WriteCallback = (error?: Error | null) => void;

interface Socket {
  cork?: (() => void) | undefined;
  uncork?: (() => void) | undefined;
  write(data: Uint8Array | string, ...rest: unknown[]): boolean;
}

/**
 * Gives a socket without `cork` and `uncork` (workerd's, under node-postgres) both: writes
 * made while corked go out as one write on the last `uncork`. node-postgres corks around a
 * query's Parse, Bind, Describe, Execute and Sync; written apart, Nagle's algorithm holds
 * them for the server's delayed ACK, about 40 ms per query.
 */
export function corkWrites(socket: Socket): void {
  if (typeof socket.cork === "function") return;
  const write = socket.write.bind(socket);
  let depth = 0;
  let held: {
    readonly data: Uint8Array;
    readonly callback: WriteCallback | undefined;
  }[] = [];
  socket.cork = () => {
    depth += 1;
  };
  socket.uncork = () => {
    if (depth === 0) return;
    depth -= 1;
    if (depth > 0 || held.length === 0) return;
    const sending = held;
    held = [];
    const data =
      sending.length === 1 ? sending[0]!.data : Buffer.concat(sending.map((w) => w.data));
    write(data, (error?: Error | null) => {
      for (const { callback } of sending) callback?.(error);
    });
  };
  socket.write = (data, ...rest) => {
    if (depth === 0) return write(data, ...rest);
    const callback = rest.find((arg): arg is WriteCallback => typeof arg === "function");
    const encoding = typeof rest[0] === "string" ? (rest[0] as BufferEncoding) : "utf8";
    held.push({
      data: typeof data === "string" ? Buffer.from(data, encoding) : data,
      callback,
    });
    return true;
  };
}
