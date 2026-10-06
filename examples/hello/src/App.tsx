import { deepLink, notifications } from "@parlor/capabilities";
import { useActionMutation, useActionQuery, useCapability } from "@parlor/client/react";
import { useEffect, useState } from "react";

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

      <NotificationsPanel />
      <DeepLinkPanel />
    </main>
  );
}

function NotificationsPanel() {
  const cap = useCapability(notifications);
  const [status, setStatus] = useState("");
  if (cap.resolving) return null;
  if (!cap.available) {
    return <p data-testid="notifications">Notifications: {cap.reason}</p>;
  }
  const notify = async () => {
    const permission =
      cap.api.permission() === "granted" ? "granted" : await cap.api.request();
    if (permission !== "granted") {
      setStatus(`permission ${permission}`);
      return;
    }
    await cap.api.show("Hello from Parlor", { body: `Running on ${cap.platform}` });
    setStatus("sent");
  };
  return (
    <section style={{ marginTop: 24 }}>
      <p data-testid="notifications">Notifications via {cap.platform}</p>
      <button onClick={() => void notify()}>Notify</button> <output>{status}</output>
    </section>
  );
}

function DeepLinkPanel() {
  const cap = useCapability(deepLink);
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    if (!cap.available) return;
    return cap.api.onOpen((url) => setUrls((current) => [...current, url]));
  }, [cap]);
  if (cap.resolving) return null;
  return (
    <section style={{ marginTop: 24 }}>
      <p data-testid="deeplink">Deep links via {cap.available ? cap.platform : "none"}</p>
      <ul>
        {urls.map((url) => (
          <li key={url}>{url}</li>
        ))}
      </ul>
    </section>
  );
}
