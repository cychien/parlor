const TYPES: Readonly<Record<string, string>> = {
  csv: "text/csv",
  gif: "image/gif",
  heic: "image/heic",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  zip: "application/zip",
};

const extensionOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

/** A file's MIME type from its extension; `""` when unknown. */
export function typeOf(name: string): string {
  return TYPES[extensionOf(name)] ?? "";
}

/** The last segment of a path on any platform. */
export function nameOf(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/**
 * `accept` as file-dialog extensions, or undefined when some entry has no extension to
 * name, so a dialog never hides a file the app would take.
 */
export function extensionsOf(
  accept: readonly string[] | undefined,
): string[] | undefined {
  if (!accept?.length) return undefined;
  const extensions = new Set<string>();
  for (const entry of accept.map((item) => item.trim().toLowerCase())) {
    if (entry.startsWith(".")) {
      extensions.add(entry.slice(1));
      continue;
    }
    const known = Object.entries(TYPES).filter(([, type]) =>
      entry.endsWith("/*") ? type.startsWith(entry.slice(0, -1)) : type === entry,
    );
    if (known.length === 0) return undefined;
    for (const [extension] of known) extensions.add(extension);
  }
  return [...extensions];
}

export async function bytesOf(data: Blob | Uint8Array | string): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(await data.arrayBuffer());
}
