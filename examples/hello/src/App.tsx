import { deepLink, notifications } from "@parlor/capabilities";
import { useActionMutation, useActionQuery, useCapability } from "@parlor/client/react";
import { type FormEvent, useEffect, useState } from "react";

export function App() {
  const [name, setName] = useState("world");
  const greeting = useActionQuery("hello", { name });

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

      <Tasks />
      <NotificationsPanel />
      <DeepLinkPanel />
    </main>
  );
}

function Tasks() {
  const [title, setTitle] = useState("");
  const list = useActionQuery("listTasks", {});
  const create = useActionMutation("createTask", { onSuccess: () => setTitle("") });
  const toggle = useActionMutation("toggleTask");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) create.mutate({ title: title.trim() });
  };

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 18 }}>Tasks</h2>
      <form onSubmit={submit}>
        <input
          id="task-title"
          name="title"
          autoComplete="off"
          placeholder="New task"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />{" "}
        <button type="submit" disabled={create.isPending}>
          Add
        </button>
      </form>
      <ul data-testid="tasks">
        {(list.data ?? []).map((task) => (
          <li key={task.id}>
            <label>
              <input
                type="checkbox"
                checked={task.done}
                onChange={() => toggle.mutate({ id: task.id })}
              />{" "}
              <span style={{ textDecoration: task.done ? "line-through" : "none" }}>
                {task.title}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
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
