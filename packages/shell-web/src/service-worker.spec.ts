import { describe, expect, it, vi } from "vitest";

import { serviceWorkerRegistrationSource } from "./service-worker.js";

function pageControlledBy(controller: object | null) {
  const listeners = new Map<string, () => void>();
  const serviceWorker = {
    controller,
    register: vi.fn(async () => ({})),
    addEventListener: (type: string, listener: () => void) =>
      listeners.set(type, listener),
  };
  let loaded: (() => void) | undefined;
  const reload = vi.fn();
  const window = {
    addEventListener: (type: string, listener: () => void) => {
      if (type === "load") loaded = listener;
    },
    location: { reload },
  };
  new Function("window", "navigator", serviceWorkerRegistrationSource("/app/"))(window, {
    serviceWorker,
  });
  loaded!();
  return {
    register: serviceWorker.register,
    reload,
    takeOver: () => listeners.get("controllerchange")!(),
  };
}

describe("the service worker registration", () => {
  it("registers the worker under the app's base on load", () => {
    expect(pageControlledBy(null).register).toHaveBeenCalledWith("/app/sw.js", {
      scope: "/app/",
    });
  });

  it("reloads a page an older build's worker served, once, when the new build's worker takes it over", () => {
    const page = pageControlledBy({});
    page.takeOver();
    page.takeOver();
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it("leaves a page alone when the first worker installs", () => {
    const page = pageControlledBy(null);
    page.takeOver();
    expect(page.reload).not.toHaveBeenCalled();
  });
});
