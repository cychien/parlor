export interface IntersectionObserverLike {
  observe(element: Element): void;
  unobserve(element: Element): void;
  disconnect(): void;
}

export interface IntersectionEntryLike {
  readonly target: Element;
  readonly isIntersecting: boolean;
}

export interface RectLike {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserEnvironment {
  readonly document: Document | undefined;
  readonly window: (Window & typeof globalThis) | undefined;
  readonly observeIntersections: (
    callback: (entries: readonly IntersectionEntryLike[]) => void,
  ) => IntersectionObserverLike | undefined;
  readonly rect: (element: Element) => RectLike;
  readonly viewport: () => { readonly width: number; readonly height: number };
  readonly now: () => number;
  readonly nextTask: () => Promise<void>;
  readonly setTimeout: typeof globalThis.setTimeout;
  readonly clearTimeout: typeof globalThis.clearTimeout;
  readonly scrollIntoView: (element: Element) => Promise<void>;
}

export const SCROLL_SETTLE_CAP_MS = 900;

export function scrollIntoCenter(
  _window: (Window & typeof globalThis) | undefined,
  _element: Element,
): Promise<void> {
  throw new Error("not implemented");
}

export function browserEnvironment(): BrowserEnvironment {
  const window = typeof globalThis.window === "undefined" ? undefined : globalThis.window;
  return {
    document: window?.document,
    window,
    observeIntersections: (callback) =>
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver((entries) => callback(entries)),
    rect: (element) => element.getBoundingClientRect(),
    viewport: () => ({
      width: window?.innerWidth ?? 0,
      height: window?.innerHeight ?? 0,
    }),
    now: () => Date.now(),
    nextTask: () =>
      new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          resolve();
        };
        channel.port2.postMessage(undefined);
      }),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    scrollIntoView: (element) => scrollIntoCenter(window, element),
  };
}
