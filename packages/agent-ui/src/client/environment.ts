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
  readonly hasFinePointer: () => boolean;
}

export const SCROLL_SETTLE_CAP_MS = 900;

const NO_SCROLL_FRAMES = 6;
const STILL_FRAMES = 2;

export function scrollIntoCenter(
  window: (Window & typeof globalThis) | undefined,
  element: Element,
): Promise<void> {
  if (!window) return Promise.resolve();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const started = window.performance.now();
  let last = element.getBoundingClientRect().top;
  element.scrollIntoView({
    block: "center",
    inline: "nearest",
    behavior: reduced ? "instant" : "smooth",
  });
  return new Promise((resolve) => {
    let moved = false;
    let still = 0;
    let frames = 0;
    const step = () => {
      const { top } = element.getBoundingClientRect();
      frames++;
      if (top === last) still++;
      else {
        moved = true;
        still = 0;
        last = top;
      }
      const settled = moved ? still >= STILL_FRAMES : frames >= NO_SCROLL_FRAMES;
      if (settled || window.performance.now() - started >= SCROLL_SETTLE_CAP_MS) {
        resolve();
        return;
      }
      window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
  });
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
    hasFinePointer: () => true,
  };
}
