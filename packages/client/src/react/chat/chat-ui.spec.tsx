import { defineChatUi } from "@parlor/chat";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Ui } from "./chat-ui.js";

const catalog = defineChatUi({
  Card: {
    description: "A titled group.",
    props: z.object({ title: z.string() }),
    children: true,
  },
  Kpi: {
    description: "One number.",
    props: z.object({
      label: z.string(),
      value: z.number(),
      unit: z.string().default(""),
    }),
  },
});

const components = {
  Card: ({
    title,
    children,
  }: {
    readonly title: string;
    readonly children: ReactNode;
  }) => <section aria-label={title}>{children}</section>,
  Kpi: ({
    label,
    value,
    unit,
  }: {
    readonly label: string;
    readonly value: number;
    readonly unit: string;
  }) => (
    <p>
      {label}: {value}
      {unit}
    </p>
  ),
};

const html = (spec: Parameters<typeof Ui>[0]["spec"], fallback?: ReactNode) =>
  render(<Ui spec={spec} catalog={catalog} components={components} fallback={fallback} />)
    .container.innerHTML;

describe("Chat.Ui", () => {
  it("renders the tree with the app's components and each element's parsed props, adding no DOM", () => {
    expect(
      html({
        root: "card",
        elements: {
          card: { type: "Card", props: { title: "營收" }, children: ["a", "b"] },
          a: { type: "Kpi", props: { label: "訪客", value: 3 } },
          b: { type: "Kpi", props: { label: "轉換率", value: 1.9, unit: "%" } },
        },
      }),
    ).toBe('<section aria-label="營收"><p>訪客: 3</p><p>轉換率: 1.9%</p></section>');
  });

  it("puts the fallback where an element no longer fits the catalog, and keeps the rest", () => {
    expect(
      html(
        {
          root: "card",
          elements: {
            card: { type: "Card", props: { title: "營收" }, children: ["a", "b", "c"] },
            a: { type: "Pie", props: {} },
            b: { type: "Kpi", props: { label: "訪客" } },
            c: { type: "Kpi", props: { label: "訂單", value: 2 } },
          },
        },
        <i>?</i>,
      ),
    ).toBe('<section aria-label="營收"><i>?</i><i>?</i><p>訂單: 2</p></section>');
  });

  it("renders an element once even when the spec names it twice", () => {
    expect(
      html({
        root: "card",
        elements: {
          card: { type: "Card", props: { title: "x" }, children: ["a", "a"] },
          a: { type: "Kpi", props: { label: "訪客", value: 3 } },
        },
      }),
    ).toBe('<section aria-label="x"><p>訪客: 3</p></section>');
  });
});
