import { platformEnv } from "./platform.js";

export const env = platformEnv();

/** Lets modules that define Durable Objects load; parlor dev never constructs one. */
export class DurableObject<Env = unknown> {
  protected readonly ctx: unknown;
  protected readonly env: Env;

  constructor(state: unknown, bindings: Env) {
    this.ctx = state;
    this.env = bindings;
  }
}

/** On Workers it keeps the request alive for `promise`; a Node process runs on anyway, so this only reports a failure. */
export function waitUntil(promise: Promise<unknown>): void {
  promise.catch((error: unknown) => {
    console.error("[parlor] work passed to waitUntil failed:", error);
  });
}
