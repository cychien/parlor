import { deepLink, notifications } from "@parlor/capabilities";
import { useCapability } from "@parlor/client/react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AccountPanel } from "../account.js";

export const Route = createFileRoute("/settings")({
  staticData: {
    description:
      "App settings: the signed-in account, where it is signed in, which agents and computers it connected, and notification and deep link support on this device.",
  },
  component: Settings,
});

function Settings() {
  return (
    <>
      <h1>Settings</h1>
      <AccountPanel />
      <h2>This device</h2>
      <NotificationsPanel />
      <DeepLinkPanel />
    </>
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
    <section className="stack">
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
    <section className="stack">
      <p data-testid="deeplink">Deep links via {cap.available ? cap.platform : "none"}</p>
      <ul>
        {urls.map((url) => (
          <li key={url}>{url}</li>
        ))}
      </ul>
    </section>
  );
}
