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
