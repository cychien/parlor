export type ScopeResolver = (request: Request) => string | Promise<string>;

export const DEFAULT_SCOPE = "default";

export const defaultScope: ScopeResolver = () => DEFAULT_SCOPE;
