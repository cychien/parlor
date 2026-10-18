import { Window } from "happy-dom";

import type {
  BrowserEnvironment,
  IntersectionEntryLike,
  RectLike,
} from "./environment.js";

export interface FakeBrowser {
  readonly env: BrowserEnvironment;
  readonly document: Document;
  readonly window: Window & typeof globalThis;
  setRect(element: Element, top: number, height: number): void;
  intersect(element: Element, isIntersecting: boolean): void;
  observed(): readonly Element[];
  scrolled(): readonly Element[];
  onScroll(handler: (element: Element) => void | Promise<void>): void;
  tick(ms: number): void;
}

export function fakeBrowser(viewport = { width: 800, height: 600 }): FakeBrowser {
  const window = new Window({ width: viewport.width, height: viewport.height });
  const document = window.document as unknown as Document;
  const rects = new Map<Element, RectLike>();
  const observed = new Set<Element>();
  const scrolled: Element[] = [];
  let scrollHandler: ((element: Element) => void | Promise<void>) | undefined;
  let callback: ((entries: readonly IntersectionEntryLike[]) => void) | undefined;
  let now = 10_000;
  const env: BrowserEnvironment = {
    document,
    window: window as unknown as Window & typeof globalThis,
    observeIntersections: (cb) => {
      callback = cb;
      return {
        observe: (element) => observed.add(element),
        unobserve: (element) => observed.delete(element),
        disconnect: () => observed.clear(),
      };
    },
    rect: (element) =>
      rects.get(element) ?? { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 },
    viewport: () => viewport,
    now: () => now,
    nextTask: () => new Promise((resolve) => setTimeout(resolve, 0)),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    scrollIntoView: async (element) => {
      scrolled.push(element);
      await scrollHandler?.(element);
    },
  };
  return {
    env,
    document,
    window: window as unknown as Window & typeof globalThis,
    setRect(element, top, height) {
      rects.set(element, {
        top,
        bottom: top + height,
        left: 0,
        right: viewport.width,
        width: viewport.width,
        height,
      });
    },
    intersect(element, isIntersecting) {
      callback?.([{ target: element, isIntersecting }]);
    },
    observed: () => [...observed],
    scrolled: () => [...scrolled],
    onScroll(handler) {
      scrollHandler = handler;
    },
    tick(ms) {
      now += ms;
    },
  };
}
