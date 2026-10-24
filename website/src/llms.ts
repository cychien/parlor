export interface DocPage {
  /** `guides/actions`; the page is served at `/<slug>/` and as Markdown at `/<slug>.md`. */
  readonly slug: string;
  readonly title: string;
  readonly description: string | undefined;
  /** The page's Markdown source. Pages use plain Markdown, so the source reads as is. */
  readonly body: string;
}

const CUT = /^\/\/ ---cut(?:-before)?---$/m;
const TWOSLASH_LINE = /^\s*\/\/\s*(?:\^\?|@errors:.*|@noErrors|@filename:.*)\s*$\n?/gm;

/**
 * A sample as a reader copies it: lines above `// ---cut---` are setup for the compiler, and
 * queries and directives are for the renderer.
 */
export function stripTwoslash(markdown: string): string {
  return markdown.replace(
    /^```(tsx?)([^\n]*)\n([\s\S]*?)^```$/gm,
    (_fence, lang, meta, code) => {
      const cut = CUT.exec(code);
      const kept = cut ? code.slice(cut.index + cut[0].length + 1) : code;
      return `\`\`\`${lang}${meta}\n${kept.replace(TWOSLASH_LINE, "")}\`\`\``;
    },
  );
}

/** llms.txt (llmstxt.org): the title, a summary, then one link per page, every page. */
/** `root` is where the docs are served, base path included: `https://example.com/docs/`. */
export function llmsIndex(pages: readonly DocPage[], root: URL, summary: string): string {
  const links = [...pages]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((page) => {
      const url = new URL(`${page.slug}.md`, root).href;
      return `- [${page.title}](${url})${page.description ? `: ${page.description}` : ""}`;
    });
  return `# Parlor\n\n> ${summary}\n\n## Docs\n\n${links.join("\n")}\n`;
}

export function llmsFull(pages: readonly DocPage[]): string {
  return pages
    .map((page) => `# ${page.title}\n\n${stripTwoslash(page.body).trim()}\n`)
    .join("\n");
}
