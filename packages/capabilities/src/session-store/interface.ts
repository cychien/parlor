/**
 * Where a native shell keeps its bearer session. A browser needs none: the session rides
 * in a cookie the page cannot read.
 */
export interface SessionStore {
  get(): Promise<string | undefined>;
  set(token: string | undefined): Promise<void>;
}
