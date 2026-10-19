// @vitest-environment node
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Rollup } from "vite";
import { describe, expect, it } from "vitest";

const REACT_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
const CHAT_PARTS_MARKER = "Chat.AskChoice must be rendered inside Chat.Ask.";
const RUNTIME_MARKER = "npx @parlor/agent-host connect";

async function emittedChunks(entrySource: string, lazySource: string) {
  const root = await mkdtemp(join(tmpdir(), "parlor-chat-split-"));
  await writeFile(join(root, "entry.ts"), entrySource);
  await writeFile(join(root, "lazy.ts"), lazySource);
  const result = (await build({
    root,
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: join(root, "entry.ts") },
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const output = Array.isArray(result) ? result[0]! : result;
  return output.output.flatMap((file) =>
    file.type === "chunk" ? [{ entry: file.isEntry, code: file.code }] : [],
  );
}

describe("the chat parts in a built app", () => {
  it("stay out of the entry chunk when only a lazy chunk uses them", async () => {
    const chunks = await emittedChunks(
      `import { Chat } from ${JSON.stringify(REACT_ENTRY)};
console.log(Chat.Activity);
import("./lazy.ts");`,
      `import { Chat } from ${JSON.stringify(REACT_ENTRY)};
console.log(Chat.Root, Chat.Thread, Chat.Composer, Chat.AskChoice);`,
    );
    const holding = chunks.filter((chunk) => chunk.code.includes(CHAT_PARTS_MARKER));
    expect(holding.map((chunk) => chunk.entry)).toEqual([false]);
  }, 60_000);

  it("ship with their runtime in one chunk, so opening the chat is not a waterfall", async () => {
    const chunks = await emittedChunks(
      `import("./lazy.ts");`,
      `import { Chat } from ${JSON.stringify(REACT_ENTRY)};
console.log(Chat.Root, Chat.AskChoice);`,
    );
    const holding = (marker: string) =>
      chunks.filter((chunk) => chunk.code.includes(marker)).length;
    expect([holding(CHAT_PARTS_MARKER), holding(RUNTIME_MARKER)]).toEqual([1, 1]);
    expect(
      chunks.filter(
        (chunk) =>
          chunk.code.includes(CHAT_PARTS_MARKER) && chunk.code.includes(RUNTIME_MARKER),
      ),
    ).toHaveLength(1);
  }, 60_000);
});
