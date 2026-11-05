import type { Plugin } from "vite";

export const SERVICE_WORKER_REGISTRATION = "register-sw.js";

/**
 * Registers the service worker, and reloads a page that an older build's worker served once
 * the new build's worker takes it over, so a deploy reaches open and reopened pages.
 */
export function serviceWorkerRegistrationSource(base: string): string {
  return `if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const updating = navigator.serviceWorker.controller !== null;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!updating || reloaded) return;
      reloaded = true;
      window.location.reload();
    });
    navigator.serviceWorker.register(${JSON.stringify(`${base}sw.js`)}, { scope: ${JSON.stringify(base)} });
  });
}
`;
}

export function serviceWorkerRegistration(): Plugin {
  let base = "/";
  return {
    name: "parlor:service-worker-registration",
    apply: "build",
    configResolved(resolved) {
      base = resolved.base;
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: SERVICE_WORKER_REGISTRATION,
        source: serviceWorkerRegistrationSource(base),
      });
    },
    transformIndexHtml: () => [
      {
        tag: "script",
        attrs: { src: `${base}${SERVICE_WORKER_REGISTRATION}`, defer: true },
        injectTo: "head",
      },
    ],
  };
}
