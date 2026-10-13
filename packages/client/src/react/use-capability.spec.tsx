import { defineCapability } from "@parlor/capabilities";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useCapability } from "./use-capability.js";

const greeter = defineCapability<{ greet(): string }>({
  name: "greeter",
  adapters: [
    { platform: "web", available: () => true, create: () => ({ greet: () => "hi" }) },
  ],
});
const missing = defineCapability<never>({ name: "missing", adapters: [] });

function Probe({ definition }: { definition: typeof greeter | typeof missing }) {
  const cap = useCapability(definition);
  if (cap.resolving) return <output>resolving</output>;
  return (
    <output>
      {cap.available ? (cap.api as { greet(): string }).greet() : cap.reason}
    </output>
  );
}

describe("useCapability", () => {
  it("starts resolving, then exposes the api", async () => {
    render(<Probe definition={greeter} />);
    expect(screen.getByRole("status").textContent).toBe("resolving");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("hi"));
  });

  it("reports unavailability with the reason", async () => {
    render(<Probe definition={missing} />);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        'Capability "missing" has no available adapter on web',
      ),
    );
  });
});
