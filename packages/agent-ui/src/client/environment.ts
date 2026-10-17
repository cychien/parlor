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
}

export function browserEnvironment(): BrowserEnvironment {
  throw new Error("not implemented");
}
