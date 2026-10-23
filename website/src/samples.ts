import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExpressiveCodePlugin } from "@astrojs/starlight/expressive-code";
import ecTwoSlash from "expressive-code-twoslash";
import ts from "typescript";

/** The compiler options every sample compiles with, on the site and in the READMEs. */
export const SAMPLES_TSCONFIG = fileURLToPath(
  new URL("../tsconfig.samples.json", import.meta.url),
);

/**
 * Read with the TypeScript 6 API, because expressive-code-twoslash 0.6.1 ignores its own
 * `tsConfigPath` and only applies `twoslashOptions.compilerOptions`.
 */
export function samplesCompilerOptions(): ts.CompilerOptions {
  const { config, error } = ts.readConfigFile(SAMPLES_TSCONFIG, ts.sys.readFile);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(SAMPLES_TSCONFIG));
  return parsed.options;
}

/** Every `ts` and `tsx` fence compiles at build; an unannotated type error fails it (D6). */
export function typecheckedSamples(): ExpressiveCodePlugin {
  const plugin = ecTwoSlash({
    instanceConfigs: {
      twoslash: { explicitTrigger: /(?:)/, languages: ["ts", "tsx"] },
    },
    // Dependencies' JSDoc carries Markdown headings that would land in the page's table of contents.
    includeJsDoc: false,
    twoslashOptions: { compilerOptions: samplesCompilerOptions() },
  });
  // Built against Expressive Code 0.41 while Starlight ships 0.44; the plugin works with both.
  return plugin as unknown as ExpressiveCodePlugin;
}
