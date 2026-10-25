import { createHash } from "node:crypto";

export const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f6f4; --card: #fff; --text: #1d1d1b; --muted: #5f5f5a; --line: #e2e2dc; --accent: #1d1d1b; --on-accent: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --card: #1f1f1d; --text: #ededea; --muted: #a3a39d; --line: #34342f; --accent: #ededea; --on-accent: #151514; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
h1 { font-size: 20px; line-height: 1.3; margin: 0 0 8px; }
p { margin: 0 0 12px; color: var(--muted); }
ul { margin: 0 0 20px; padding-left: 20px; }
li { margin-bottom: 6px; }
strong { color: var(--text); font-weight: 600; }
code { font: 0.9em ui-monospace, "SF Mono", Menlo, monospace; color: var(--text); }
form { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin: 0; }
label.choice { flex-basis: 100%; display: flex; gap: 10px; align-items: flex-start; margin: 4px 0 12px; color: var(--muted); font-size: 14px; cursor: pointer; }
label.choice input { margin: 3px 0 0; accent-color: var(--accent); }
button { font: inherit; font-weight: 600; padding: 9px 18px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--text); cursor: pointer; }
button[value="true"], button[value="connect"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

const sha256 = (text: string) => createHash("sha256").update(text).digest("base64");

const STYLE_HASH = sha256(STYLE);

export function page(
  title: string,
  body: string,
  formAction: readonly string[],
  script?: string,
): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": [
        "default-src 'none'",
        `style-src 'sha256-${STYLE_HASH}'`,
        ...(script ? [`script-src 'sha256-${sha256(script)}'`] : []),
        `form-action ${formAction.join(" ")}`,
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join("; "),
      "x-content-type-options": "nosniff",
      // no-referrer would make the form POST carry `Origin: null`.
      "referrer-policy": "same-origin",
    },
  });
}

export function failure(message: string, status: number): Response {
  const response = page(
    "Authorization failed",
    `<h1>Authorization failed</h1><p>${escape(message)}</p>`,
    ["'none'"],
  );
  return new Response(response.body, { status, headers: response.headers });
}
