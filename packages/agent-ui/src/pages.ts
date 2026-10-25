/**
 * Marks the 404 the app's server answers when none of its routes match, so the host serves
 * the app's document instead and the page shows its own not-found view.
 */
export const UNROUTED_HEADER = "x-parlor-unrouted";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Mirrors `parseSegment` in `@tanstack/router-core`, erring towards matching more. */
function segmentSource(segment: string): {
  readonly source: string;
  readonly rest: boolean;
} {
  if (segment === "$") return { source: "(?:/.*)?", rest: true };
  if (segment.startsWith("$")) return { source: "/[^/]+", rest: false };
  const open = segment.indexOf("{");
  const close = segment.indexOf("}", open);
  const optional = segment[open + 1] === "-";
  const nameStart = open + (optional ? 3 : 2);
  if (open < 0 || close < 0 || segment[nameStart - 1] !== "$") {
    return { source: `/${escape(segment)}`, rest: false };
  }
  const prefix = escape(segment.slice(0, open));
  const suffix = escape(segment.slice(close + 1));
  if (optional) return { source: `(?:/${prefix}[^/]+${suffix})?`, rest: false };
  if (nameStart === close) return { source: `/${prefix}.*`, rest: true };
  return { source: `/${prefix}[^/]+${suffix}`, rest: false };
}

/**
 * Matches the URL paths, with or without a query string, that the page route at `path`
 * renders, case-insensitively like the router.
 */
export function pagePattern(path: string): RegExp {
  let source = "";
  for (const segment of path.split("/").filter(Boolean)) {
    const next = segmentSource(segment);
    source += next.source;
    if (next.rest) break;
  }
  return new RegExp(`^${source}/?(?:\\?.*)?$`, "i");
}
