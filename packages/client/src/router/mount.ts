import type { AnyRouter } from "@tanstack/react-router";
import { hydrate } from "@tanstack/react-router/ssr/client";
import type { ReactNode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";

import type { ActionClient } from "../action-client.js";
import type { RegisteredActions } from "../register.js";

/** Set on the page's container when the server rendered the app into it. */
export const SERVER_RENDERED = "data-parlor-ssr";

/** One instance of the app: its router and the element that renders it. */
export interface ParlorApp<TRouter extends AnyRouter = AnyRouter> {
  readonly router: TRouter;
  readonly element: ReactNode;
}

/**
 * Builds the app around an action client. The browser calls it once; with `web.ssr`, the
 * server calls it for every page it renders, with a client that reaches the app in process.
 */
export type CreateParlorApp<TRouter extends AnyRouter = AnyRouter> = (
  client: ActionClient<RegisteredActions>,
) => ParlorApp<TRouter>;

function render(container: Element, element: ReactNode): void {
  createRoot(container).render(element);
}

/**
 * Starts the app in `container`: it hydrates what the server rendered there, and renders from
 * scratch otherwise, as on a page the server did not render and in the native shells.
 */
export function mount(container: Element, { router, element }: ParlorApp): void {
  if (!container.hasAttribute(SERVER_RENDERED)) {
    render(container, element);
    return;
  }
  hydrate(router)
    .finally(() => globalThis.window?.$_TSR?.h())
    .then(
      () => {
        hydrateRoot(container, element);
      },
      (error: unknown) => {
        console.error("[parlor] Could not hydrate the server-rendered page:", error);
        container.replaceChildren();
        render(container, element);
      },
    );
}
