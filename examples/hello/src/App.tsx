import { useActionMutation, useActionQuery } from "@parlor/client/react";
import { useState } from "react";

export function App() {
  const [name, setName] = useState("world");
  const greeting = useActionQuery("hello", { name });
  const counter = useActionQuery("getCount", {});
  const increment = useActionMutation("increment");

  return (
    <main style={{ fontFamily: "system-ui", padding: 24, maxWidth: 480 }}>
      <h1>{greeting.data?.message ?? (greeting.error?.message || "...")}</h1>
      <label>
        Name{" "}
        <input
          id="name"
          name="name"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <section style={{ marginTop: 24 }}>
        <p>
          Count: <output data-testid="count">{counter.data?.count ?? "..."}</output>
        </p>
        <button
          onClick={() => increment.mutate({ by: 1 })}
          disabled={increment.isPending}
        >
          +1
        </button>
      </section>
    </main>
  );
}
