import { useSyncExternalStore } from "react";

export interface SidebarView {
  readonly open: boolean;
  readonly threadId: string | undefined;
}

export interface SidebarViewStore {
  subscribe(listener: () => void): () => void;
  get(): SidebarView;
  set(patch: Partial<SidebarView>): void;
}

export function createSidebarViewStore(): SidebarViewStore {
  const listeners = new Set<() => void>();
  let view: SidebarView = { open: false, threadId: undefined };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => view,
    set(patch) {
      const next = { ...view, ...patch };
      if (next.open === view.open && next.threadId === view.threadId) return;
      view = next;
      for (const listener of listeners) listener();
    },
  };
}

export const sidebarView = createSidebarViewStore();

export function useSidebarView(): SidebarView {
  return useSyncExternalStore(sidebarView.subscribe, sidebarView.get, sidebarView.get);
}
