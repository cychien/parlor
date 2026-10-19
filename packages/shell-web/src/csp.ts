import { CSP_DIRECTIVES, type ParlorConfig } from "@parlor/config";

export type CspDirective = (typeof CSP_DIRECTIVES)[number];

export type CspDirectives = { readonly [D in CspDirective]?: readonly string[] };

export interface DefaultCspInput {
  /** The backend origin the shell build talks to (`server.url`), or the page's own. */
  readonly serverOrigin?: string | undefined;
  /** Extra origins `connect-src` needs, such as a sync relay. */
  readonly connect?: readonly string[] | undefined;
  /** Allows Vite's HMR client and websocket. */
  readonly dev?: boolean | undefined;
}

const SELF = "'self'";
const NONE = "'none'";
const SCRIPT_LOOSENERS = new Set(["'unsafe-inline'", "'unsafe-eval'"]);
const UNSAFE_SOURCE = /[\s;,]/;

/**
 * The policy a chat-enabled app ships by default: `script-src 'self'` with no inline
 * script or eval, `connect-src` only to its backend, `frame-ancestors 'none'`,
 * `object-src 'none'`.
 */
export function defaultCsp(input: DefaultCspInput = {}): CspDirectives {
  const connect = [
    SELF,
    ...(input.serverOrigin ? [new URL(input.serverOrigin).origin] : []),
    ...(input.connect ?? []),
    ...(input.dev ? ["ws:"] : []),
  ];
  const inline = input.dev ? ["'unsafe-inline'"] : [];
  return {
    "default-src": [SELF],
    "script-src": [SELF, ...inline],
    "style-src": [SELF, ...inline],
    "img-src": [SELF, "data:"],
    "font-src": [SELF],
    "connect-src": unique(connect),
    "worker-src": [SELF],
    "manifest-src": [SELF],
    "frame-src": [NONE],
    "frame-ancestors": [NONE],
    "object-src": [NONE],
    "base-uri": [SELF],
    "form-action": [SELF],
  };
}

/**
 * Adds sources an app allows on top of the default. Never removes a restriction: a
 * `script-src` addition of `'unsafe-inline'` or `'unsafe-eval'` throws.
 */
export function extendCsp(base: CspDirectives, additions: CspDirectives): CspDirectives {
  const extended: { -readonly [D in CspDirective]?: readonly string[] } = { ...base };
  for (const directive of CSP_DIRECTIVES) {
    const added = additions[directive];
    if (!added || added.length === 0) continue;
    if (directive === "script-src") {
      const loosening = added.find((source) =>
        SCRIPT_LOOSENERS.has(source.toLowerCase()),
      );
      if (loosening) {
        throw new Error(
          `script-src cannot take ${loosening}: the default policy forbids it`,
        );
      }
    }
    const current = (base[directive] ?? []).filter(
      (source) => source !== NONE || added.includes(NONE),
    );
    extended[directive] = unique([...current, ...added]);
  }
  return extended;
}

/** The header or `<meta http-equiv>` value. */
export function serializeCsp(directives: CspDirectives): string {
  return CSP_DIRECTIVES.flatMap((directive) => {
    const sources = directives[directive];
    if (!sources) return [];
    for (const source of sources) {
      if (UNSAFE_SOURCE.test(source) || source === "") {
        throw new Error(`${directive} has an invalid source: ${JSON.stringify(source)}`);
      }
    }
    return [[directive, ...(sources.length === 0 ? [NONE] : sources)].join(" ")];
  }).join("; ");
}

/** A `<meta http-equiv>` policy cannot carry `frame-ancestors`; browsers ignore it and warn. */
export function metaCsp(directives: CspDirectives): CspDirectives {
  const { "frame-ancestors": _ignored, ...rest } = directives;
  return rest;
}

/** The policy an app ships: the default for this shell's backend plus `web.csp`. */
export function appCsp(config: ParlorConfig, input: DefaultCspInput): CspDirectives {
  return extendCsp(defaultCsp(input), config.web.csp ?? {});
}

function unique(sources: readonly string[]): string[] {
  return [...new Set(sources)];
}
