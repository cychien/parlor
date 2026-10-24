import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createTwoslasher } from "@ec-ts/twoslash";

import { samplesCompilerOptions } from "../src/samples.ts";

export interface SampleError {
  /** `packages/core/README.md:42`, the line of the fence's first code line. */
  readonly at: string;
  readonly message: string;
}

/**
 * D6: every public package has a README, and every `ts`/`tsx` fence in the READMEs and the docs
 * compiles through the twoslasher the site's plugin uses (`@ec-ts/twoslash`) and
 * `SAMPLES_TSCONFIG`, so `// @errors`, `// ---cut---` and `// @filename` mean the same in both.
 */
const DOCS_DIR = new URL("../src/content/docs/", import.meta.url);
const DOCS_LINK = /https:\/\/cychien\.github\.io\/parlor\/([^\s)>"`]*)/g;
const SITE_FILES: ReadonlySet<string> = new Set(["llms.txt", "llms-full.txt"]);

/** Slugs of the docs pages: `guides/actions`, and `` for the home page. */
export function docSlugs(docsDir: URL = DOCS_DIR): ReadonlySet<string> {
  const slugs = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(new URL(dir, docsDir), { withFileTypes: true })) {
      const path = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${path}/`);
      else slugs.add(path.replace(/\.mdx?$/, "").replace(/(^|\/)index$/, ""));
    }
  };
  walk("");
  return slugs;
}

/** Links into the docs site that name no page. */
export function brokenDocsLinks(
  text: string,
  slugs: ReadonlySet<string>,
): readonly string[] {
  return [...text.matchAll(DOCS_LINK)]
    .map((match) => (match[1] ?? "").replace(/[.,;:]+$/, ""))
    .filter((path) => {
      const slug = path.split("#")[0]!.replace(/\/$/, "");
      return !slugs.has(slug) && !SITE_FILES.has(slug);
    })
    .map((path) => `https://cychien.github.io/parlor/${path}`);
}

type Twoslasher = ReturnType<typeof createTwoslasher>;

/** Every `ts`/`tsx` fence of `text` that does not compile, at `<label>:<line>`. */
export function fenceErrors(
  twoslasher: Twoslasher,
  label: string,
  text: string,
): readonly SampleError[] {
  const errors: SampleError[] = [];
  for (const fence of text.matchAll(FENCE)) {
    const [, lang = "ts", code = ""] = fence;
    const line = text.slice(0, fence.index).split("\n").length + 1;
    try {
      twoslasher(code, lang);
    } catch (error) {
      errors.push({ at: `${label}:${line}`, message: (error as Error).message.trim() });
    }
  }
  return errors;
}

/** Every docs page's samples, so a type error fails before Astro renders, with its line. */
export function checkDocs(
  twoslasher: Twoslasher,
  docsDir: URL = DOCS_DIR,
): readonly SampleError[] {
  return [...docSlugs(docsDir)].flatMap((slug) => {
    const file = ["md", "mdx"]
      .map((extension) => new URL(`${slug || "index"}.${extension}`, docsDir))
      .find((candidate) => existsSync(candidate));
    if (!file) return [];
    const label = `website/src/content/docs/${slug || "index"}${file.pathname.endsWith("x") ? ".mdx" : ".md"}`;
    return fenceErrors(twoslasher, label, readFileSync(file, "utf8"));
  });
}

export async function checkReadmes(
  twoslasher: Twoslasher,
  packagesDir: URL,
): Promise<readonly SampleError[]> {
  const slugs = docSlugs();
  const errors: SampleError[] = [];
  for (const dir of readdirSync(packagesDir).sort()) {
    const manifestPath = new URL(`${dir}/package.json`, packagesDir);
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      private?: boolean;
    };
    if (manifest.private) continue;
    const readme = new URL(`${dir}/README.md`, packagesDir);
    if (!existsSync(readme)) {
      errors.push({ at: `packages/${dir}`, message: "no README.md" });
      continue;
    }
    const text = readFileSync(readme, "utf8");
    for (const link of brokenDocsLinks(text, slugs)) {
      errors.push({
        at: `packages/${dir}/README.md`,
        message: `no docs page at ${link}`,
      });
    }
    errors.push(...fenceErrors(twoslasher, `packages/${dir}/README.md`, text));
  }
  return errors;
}

const FENCE = /^```(ts|tsx)\b[^\n]*\n([\s\S]*?)^```/gm;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const twoslasher = createTwoslasher({ compilerOptions: samplesCompilerOptions() });
  const errors = [
    ...(await checkReadmes(twoslasher, new URL("../../packages/", import.meta.url))),
    ...checkDocs(twoslasher),
  ];
  for (const error of errors) console.error(`${error.at}: ${error.message}`);
  if (errors.length > 0) process.exit(1);
}
