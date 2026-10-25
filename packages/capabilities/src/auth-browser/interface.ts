export interface AuthBrowser {
  /**
   * Opens `url`, a sign-in flow that ends by redirecting to `callbackUrl`, and resolves with
   * the URL it ended at, or `undefined` when the user closed it first. A browser tab goes to
   * `url` itself, so there the promise never settles: the flow returns as a new page load.
   */
  open(url: string, callbackUrl: string): Promise<string | undefined>;
}
