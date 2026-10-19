export type CspDirective =
  | "default-src"
  | "script-src"
  | "style-src"
  | "img-src"
  | "font-src"
  | "connect-src"
  | "worker-src"
  | "manifest-src"
  | "frame-src"
  | "frame-ancestors"
  | "object-src"
  | "base-uri"
  | "form-action";

export type CspDirectives = { readonly [D in CspDirective]?: readonly string[] };

export interface DefaultCspInput {
  /** The backend origin the shell build talks to (`server.url`), or the page's own. */
  readonly serverOrigin?: string | undefined;
  /** Extra origins `connect-src` needs, such as a sync relay. */
  readonly connect?: readonly string[] | undefined;
  /** Allows Vite's HMR client and websocket. */
  readonly dev?: boolean | undefined;
}

/**
 * The policy a chat-enabled app ships by default: `script-src 'self'` with no inline
 * script or eval, `connect-src` only to its backend, `frame-ancestors 'none'`,
 * `object-src 'none'`.
 */
export function defaultCsp(input: DefaultCspInput = {}): CspDirectives {
  void input;
  throw new Error("not implemented");
}

/**
 * Adds sources an app allows on top of the default. Never removes a restriction: a
 * `script-src` addition of `'unsafe-inline'` or `'unsafe-eval'` throws.
 */
export function extendCsp(base: CspDirectives, additions: CspDirectives): CspDirectives {
  void base;
  void additions;
  throw new Error("not implemented");
}

/** The header or `<meta http-equiv>` value. */
export function serializeCsp(directives: CspDirectives): string {
  void directives;
  throw new Error("not implemented");
}
