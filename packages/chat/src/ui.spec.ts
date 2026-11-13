import { asId } from "@parlor/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { checkedUiItems, describeChatUi } from "./server/ui-tool.js";
import { checkUiSpec, defineChatUi } from "./ui.js";

const catalog = defineChatUi({
  Card: {
    description: "A titled group.",
    props: z.object({ title: z.string() }),
    children: true,
  },
  Bars: {
    description: "Labelled values as bars.",
    props: z.object({
      rows: z.array(z.object({ label: z.string(), value: z.number() })),
      unit: z.string().default(""),
    }),
  },
});

const bars = { type: "Bars", props: { rows: [{ label: "Paid Social", value: 55400 }] } };

describe("checkUiSpec", () => {
  it("passes a tree and parses each element's props", () => {
    const check = checkUiSpec(catalog, {
      root: "card",
      elements: {
        card: { type: "Card", props: { title: "營收變化" }, children: ["bars"] },
        bars,
      },
    });
    expect(check).toEqual({
      ok: true,
      spec: {
        root: "card",
        elements: {
          card: { type: "Card", props: { title: "營收變化" }, children: ["bars"] },
          bars: {
            type: "Bars",
            props: { rows: [{ label: "Paid Social", value: 55400 }], unit: "" },
          },
        },
      },
    });
  });

  it("names every element that does not fit the catalog", () => {
    const check = checkUiSpec(catalog, {
      root: "card",
      elements: {
        card: { type: "Card", props: {}, children: ["bars", "chart", "gone"] },
        bars: { ...bars, children: ["chart"] },
        chart: { type: "Pie", props: {} },
        stray: bars,
      },
    });
    expect(check).toEqual({
      ok: false,
      issues: [
        {
          element: "card",
          message: "props.title: Invalid input: expected string, received undefined",
        },
        { element: "bars", message: "Bars takes no children." },
        {
          element: "chart",
          message: 'Unknown type "Pie". Use one of: Card, Bars.',
        },
        { element: "chart", message: '"chart" appears more than once in the tree.' },
        { element: "gone", message: 'No element "gone".' },
        { element: "stray", message: '"stray" is not reachable from root.' },
      ],
    });
  });

  it("refuses a cycle back to the root", () => {
    const check = checkUiSpec(catalog, {
      root: "card",
      elements: { card: { type: "Card", props: { title: "a" }, children: ["card"] } },
    });
    expect(check).toEqual({
      ok: false,
      issues: [
        { element: "card", message: '"card" appears more than once in the tree.' },
      ],
    });
  });

  it("refuses a spec that is not a tree of elements", () => {
    expect(checkUiSpec(catalog, { root: "", elements: {} })).toEqual({
      ok: false,
      issues: [{ message: "root must be a key of 1 to 64 characters." }],
    });
  });
});

describe("describeChatUi", () => {
  it("lists each component with its props schema for the agent", () => {
    expect(describeChatUi(defineChatUi({ Card: catalog.Card }))).toBe(
      '- Card: A titled group. Takes children. Props: {"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}',
    );
  });
});

describe("defineChatUi", () => {
  it("refuses a name an agent could not write as a type", () => {
    expect(() => defineChatUi({ "my card": catalog.Card })).toThrow(
      'defineChatUi(): "my card" is not a component name.',
    );
  });
});

describe("checkedUiItems", () => {
  const id = asId("item", "t1.2");

  it("keeps a ui item the catalog matches, with parsed props", () => {
    expect(
      checkedUiItems(catalog, [
        {
          id,
          kind: "ui",
          body: {
            spec: {
              root: "bars",
              elements: { bars: { ...bars, props: { ...bars.props } } },
            },
          },
        },
      ]),
    ).toEqual([
      {
        id,
        kind: "ui",
        body: {
          spec: {
            root: "bars",
            elements: {
              bars: {
                type: "Bars",
                props: { rows: [{ label: "Paid Social", value: 55400 }], unit: "" },
              },
            },
          },
        },
      },
    ]);
  });

  it("turns one the catalog no longer matches into a failed chat_show step", () => {
    expect(
      checkedUiItems(undefined, [
        {
          id,
          kind: "ui",
          body: { spec: { root: "bars", elements: { bars: { ...bars } } } },
        },
      ]),
    ).toEqual([
      {
        id,
        kind: "tool",
        body: {
          title: "chat_show",
          tool: { kind: "app", name: "chat_show" },
          status: "failed",
        },
      },
    ]);
  });
});
