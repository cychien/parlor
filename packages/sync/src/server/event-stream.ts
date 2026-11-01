export const DEFAULT_MAX_QUEUED_BYTES = 1024 * 1024;

export class SlowConsumer extends Error {
  override readonly name = "SlowConsumer";
  constructor(readonly maxQueuedBytes: number) {
    super(`the stream's reader fell more than ${maxQueuedBytes} bytes behind`);
  }
}

export interface EventStream {
  readonly body: ReadableStream<Uint8Array>;
  push(frame: { readonly event?: string | undefined; readonly data: string }): void;
  comment(text: string): void;
  /** Resolves once the reader has taken everything queued, or the stream ended. */
  drained(): Promise<void>;
  /** Ends the stream after the reader takes what is queued. */
  close(): void;
  /** Runs once, when the stream closes, its reader cancels, or the reader falls too far behind. */
  onClosed(listener: () => void): void;
}

/**
 * A server-sent event stream that drops its connection, rather than buffering without
 * bound, when the reader falls more than `maxQueuedBytes` behind. A frame that enters an
 * empty queue is always taken, so one large frame cannot fail a reader that keeps up.
 */
export function createEventStream(
  maxQueuedBytes: number = DEFAULT_MAX_QUEUED_BYTES,
): EventStream {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  let listeners: (() => void)[] = [];
  let waiters: (() => void)[] = [];
  const queued = () => maxQueuedBytes - (controller.desiredSize ?? 0);
  const wake = () => {
    for (const resolve of waiters.splice(0)) resolve();
  };
  const end = () => {
    if (ended) return;
    ended = true;
    wake();
    for (const listener of listeners.splice(0)) listener();
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(own) {
        controller = own;
      },
      pull() {
        if (queued() === 0) wake();
      },
      cancel: end,
    },
    new ByteLengthQueuingStrategy({ highWaterMark: maxQueuedBytes }),
  );
  const write = (text: string) => {
    if (ended) return;
    const wasEmpty = queued() === 0;
    controller.enqueue(encoder.encode(text));
    if (!wasEmpty && queued() > maxQueuedBytes) {
      controller.error(new SlowConsumer(maxQueuedBytes));
      end();
    }
  };
  return {
    body,
    push({ event, data }) {
      const lines = data.split(/\r\n|\r|\n/).map((line) => `data: ${line}\n`);
      write(`${event ? `event: ${event}\n` : ""}${lines.join("")}\n`);
    },
    comment(text) {
      write(`: ${text}\n\n`);
    },
    drained() {
      if (ended || queued() === 0) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      if (ended) return;
      controller.close();
      end();
    },
    onClosed(listener) {
      if (ended) queueMicrotask(listener);
      else listeners.push(listener);
    },
  };
}
