import { ActionError } from "@parlor/core";
import type { PluginTool } from "@parlor/server";
import { z } from "zod";

import type { HostItemDraft } from "../items.js";
import { type ChatUiCatalog, checkUiSpec } from "../ui.js";

export const CHAT_SHOW_TOOL = "chat_show";

const input = z.object({
  spec: z
    .object({ root: z.string(), elements: z.record(z.string(), z.unknown()) })
    .describe(
      "The UI as a flat tree: root names the top element's key; elements maps each key to { type, props, children? }.",
    ),
});

/** The catalog as the agent reads it in the tool's description, one component per line. */
export function describeChatUi(catalog: ChatUiCatalog): string {
  return Object.entries(catalog)
    .map(([name, component]) => {
      const props =
        component.props instanceof z.ZodType
          ? (({ $schema: _schema, ...schema }) => JSON.stringify(schema))(
              z.toJSONSchema(component.props, { io: "input" }),
            )
          : "object";
      const children = component.children ? " Takes children." : "";
      return `- ${name}: ${component.description.trim()}${children} Props: ${props}`;
    })
    .join("\n");
}

/** Shows the app's components in the chat, where the agent's turn is. */
export function chatShowTool(catalog: ChatUiCatalog): PluginTool<typeof input> {
  return {
    name: CHAT_SHOW_TOOL,
    description: [
      "Show UI in the chat, right after what you have written so far, built from this app's components.",
      "Use it when something reads better seen than told: charts, comparisons, key numbers. Keep explaining in plain text around it, and do not repeat in text what the UI already shows.",
      "The spec is a flat tree: root names the top element's key, elements maps every key to { type, props, children? }, and children lists keys, in order. Every element must be reachable from root, once.",
      "Returns shown: true, or invalid_input with the issues to fix.",
      "",
      "Components:",
      describeChatUi(catalog),
    ].join("\n"),
    input,
    readOnly: true,
    run: async ({ spec }) => {
      const check = checkUiSpec(catalog, spec);
      if (!check.ok) {
        const issues = check.issues.map(
          (issue) => `- ${issue.element ? `${issue.element}: ` : ""}${issue.message}`,
        );
        throw new ActionError(
          "invalid_input",
          ["The spec does not match this app's components:", ...issues].join("\n"),
        );
      }
      return { shown: true };
    },
  };
}

/**
 * The host stores what the agent showed; the catalog decides what is kept. A spec it no longer
 * matches becomes a failed `chat_show` step instead of failing the whole append.
 */
export function checkedUiItems(
  catalog: ChatUiCatalog | undefined,
  items: readonly HostItemDraft[],
): HostItemDraft[] {
  return items.map((item) => {
    if (item.kind !== "ui") return item;
    const check = catalog ? checkUiSpec(catalog, item.body.spec) : undefined;
    if (check?.ok) return { ...item, body: { spec: check.spec } };
    return {
      id: item.id,
      kind: "tool",
      body: {
        title: CHAT_SHOW_TOOL,
        tool: { kind: "app", name: CHAT_SHOW_TOOL },
        status: "failed",
      },
    };
  });
}
