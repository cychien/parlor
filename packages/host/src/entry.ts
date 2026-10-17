export interface EntryOptions {
  readonly serverEntry: string;
  readonly basePath: string;
}

export const INDEX_HTML_PLACEHOLDER = "__PARLOR_INDEX_HTML__";
export const UI_MANIFEST_PLACEHOLDER = "__PARLOR_UI_MANIFEST__";

export function hostEntrySource({ serverEntry, basePath }: EntryOptions): string {
  return `import app from ${JSON.stringify(serverEntry)};

const INDEX_HTML = ${INDEX_HTML_PLACEHOLDER};
const BASE_PATH = ${JSON.stringify(basePath)};

function wantsDocument(request) {
  if (request.method !== "GET") return false;
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(BASE_PATH) && INDEX_HTML && wantsDocument(request)) {
      return new Response(INDEX_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    return app.fetch(request);
  },
};
`;
}
