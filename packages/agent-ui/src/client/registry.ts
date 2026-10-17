import type { AnyAgentView, ViewRef } from "../view.js";
import type { BrowserEnvironment } from "./environment.js";

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

export function createViewRegistry(env: BrowserEnvironment): ViewRegistryRuntime {
  void env;
  throw new Error("not implemented");
}

export function refOf(mounted: MountedView): ViewRef {
  void mounted;
  throw new Error("not implemented");
}
