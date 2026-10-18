import type { AnyAgentView, ViewRef } from "../view.js";
import type {
  BrowserEnvironment,
  IntersectionEntryLike,
  IntersectionObserverLike,
} from "./environment.js";

export interface AnyViewBinding {
  readonly key?: string | undefined;
  get(): Readonly<Record<string, unknown>>;
}

export interface ViewSlot {
  readonly ref: (element: Element | null) => void;
  bind(binding: AnyViewBinding): void;
  mount(key: string | undefined): () => void;
}

export interface ViewRegistry {
  track(view: AnyAgentView, binding: AnyViewBinding): ViewSlot;
}

export interface MountedView {
  readonly view: AnyAgentView;
  readonly key: string | undefined;
  readonly binding: AnyViewBinding;
  readonly element: Element | undefined;
}

export interface Moment {
  readonly view: MountedView;
  readonly at: number;
}

export interface RegistryReader {
  singles(): Iterable<MountedView>;
  onScreenCandidates(): Iterable<MountedView>;
  keyedCount(viewName: string): number;
  isCurrent(mounted: MountedView): boolean;
  owner(node: Node | null): MountedView | undefined;
  lastEntered(): Moment | undefined;
  lastInteracted(): Moment | undefined;
}

export interface ViewRegistryRuntime extends ViewRegistry, RegistryReader {
  awaitingObserver(): boolean;
  observed(): Promise<void>;
  resume(): void;
  dispose(): void;
}

class Mounted implements MountedView {
  element: Element | undefined;
  key: string | undefined;
  constructor(
    readonly view: AnyAgentView,
    public binding: AnyViewBinding,
  ) {}
}

type Visibility = "pending" | "in" | "out";

export function createViewRegistry(env: BrowserEnvironment): ViewRegistryRuntime {
  const singles = new Map<string, Mounted[]>();
  const keyed = new Map<string, Map<string, Mounted[]>>();
  const live = new Set<Mounted>();
  const byElement = new WeakMap<Element, Mounted>();
  const visibility = new Map<Mounted, Visibility>();
  let observer: IntersectionObserverLike | undefined;
  let pending = 0;
  const waiting: (() => void)[] = [];
  let listening = false;
  let entered: Moment | undefined;
  let interacted: Moment | undefined;

  const settle = () => {
    if (pending > 0) return;
    for (const resolve of waiting.splice(0)) resolve();
  };

  const setVisibility = (mounted: Mounted, next: Visibility | undefined) => {
    const previous = visibility.get(mounted);
    if (previous === "pending") pending--;
    if (next === "pending") pending++;
    if (next === undefined) visibility.delete(mounted);
    else visibility.set(mounted, next);
    return previous;
  };

  const onEntries = (entries: readonly IntersectionEntryLike[]) => {
    for (const entry of entries) {
      const mounted = byElement.get(entry.target);
      if (!mounted || !visibility.has(mounted)) continue;
      const previous = setVisibility(mounted, entry.isIntersecting ? "in" : "out");
      if (entry.isIntersecting && previous === "out") {
        entered = { view: mounted, at: env.now() };
      }
    }
    settle();
  };

  const onInteraction = (event: Event) => {
    const mounted = owner(event.target as Node | null);
    if (mounted) interacted = { view: mounted, at: env.now() };
  };

  const listen = () => {
    if (listening || !env.document) return;
    listening = true;
    env.document.addEventListener("pointerdown", onInteraction, true);
    env.document.addEventListener("focusin", onInteraction, true);
  };

  const observe = (mounted: Mounted) => {
    if (!mounted.element || !live.has(mounted)) return;
    setVisibility(mounted, "pending");
    observer ??= env.observeIntersections(onEntries);
    observer?.observe(mounted.element);
  };

  const unobserve = (mounted: Mounted) => {
    if (setVisibility(mounted, undefined) === undefined) return;
    if (mounted.element) observer?.unobserve(mounted.element);
    settle();
  };

  const stackOf = (mounted: Mounted, create: boolean): Mounted[] | undefined => {
    const name = mounted.view.name;
    if (!mounted.view.keyed) {
      let stack = singles.get(name);
      if (!stack && create) singles.set(name, (stack = []));
      return stack;
    }
    let byKey = keyed.get(name);
    if (!byKey && create) keyed.set(name, (byKey = new Map()));
    const key = mounted.key ?? "";
    let stack = byKey?.get(key);
    if (!stack && byKey && create) byKey.set(key, (stack = []));
    return stack;
  };

  const removeFromStack = (mounted: Mounted) => {
    const stack = stackOf(mounted, false);
    if (!stack) return;
    stack.splice(stack.indexOf(mounted), 1);
    if (stack.length > 0) return;
    const name = mounted.view.name;
    if (!mounted.view.keyed) {
      singles.delete(name);
      return;
    }
    const byKey = keyed.get(name);
    byKey?.delete(mounted.key ?? "");
    if (byKey?.size === 0) keyed.delete(name);
  };

  function owner(node: Node | null): MountedView | undefined {
    for (let current = node; current; current = current.parentNode) {
      const mounted = byElement.get(current as Element);
      if (mounted && live.has(mounted)) return mounted;
    }
    return undefined;
  }

  const current = (moment: Moment | undefined) =>
    moment && live.has(moment.view as Mounted) ? moment : undefined;

  return {
    track(view, binding) {
      const mounted = new Mounted(view, binding);
      return {
        bind(next) {
          mounted.binding = next;
        },
        ref(element) {
          if (mounted.element === (element ?? undefined)) return;
          unobserve(mounted);
          if (mounted.element) byElement.delete(mounted.element);
          mounted.element = element ?? undefined;
          if (element) byElement.set(element, mounted);
          observe(mounted);
        },
        mount(key) {
          mounted.key = key;
          live.add(mounted);
          stackOf(mounted, true)!.push(mounted);
          listen();
          observe(mounted);
          let mountedNow = true;
          return () => {
            if (!mountedNow) return;
            mountedNow = false;
            unobserve(mounted);
            removeFromStack(mounted);
            live.delete(mounted);
          };
        },
      };
    },
    *singles() {
      for (const stack of singles.values()) yield stack.at(-1)!;
    },
    *onScreenCandidates() {
      for (const [mounted, state] of visibility) {
        if (mounted.view.keyed && state !== "out") yield mounted;
      }
    },
    keyedCount: (viewName) => keyed.get(viewName)?.size ?? 0,
    isCurrent: (mounted) => stackOf(mounted as Mounted, false)?.at(-1) === mounted,
    owner,
    lastEntered: () => current(entered),
    lastInteracted: () => current(interacted),
    awaitingObserver: () => pending > 0 && observer !== undefined,
    observed() {
      if (pending === 0 || !observer) return Promise.resolve();
      return new Promise((resolve) => waiting.push(resolve));
    },
    resume() {
      listen();
      for (const mounted of live) if (!visibility.has(mounted)) observe(mounted);
    },
    dispose() {
      observer?.disconnect();
      observer = undefined;
      visibility.clear();
      pending = 0;
      settle();
      if (listening && env.document) {
        env.document.removeEventListener("pointerdown", onInteraction, true);
        env.document.removeEventListener("focusin", onInteraction, true);
      }
      listening = false;
    },
  };
}

export function refOf(mounted: MountedView): ViewRef {
  return mounted.key === undefined
    ? { view: mounted.view.name }
    : { view: mounted.view.name, key: mounted.key };
}
