import { useActionMutation, useActionQuery } from "@parlor/client/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";

export const Route = createFileRoute("/")({
  staticData: {
    description:
      "Home: a greeting and the task list, oldest first, to add and check off tasks.",
  },
  component: Home,
});

function Home() {
  const [name, setName] = useState("world");
  const greeting = useActionQuery("hello", { name });

  return (
    <>
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
    </>
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
          aria-label="New task"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />{" "}
        <button type="submit" disabled={create.isPending}>
          Add
        </button>
      </form>
      <ul data-testid="tasks" style={{ paddingLeft: 0, listStyle: "none" }}>
        {(list.data ?? []).map((task) => (
          <li key={task.id} style={{ padding: "4px 0" }}>
            <input
              type="checkbox"
              aria-label={task.title}
              checked={task.done}
              onChange={() => toggle.mutate({ id: task.id })}
            />{" "}
            <Link
              to="/tasks/$taskId"
              params={{ taskId: task.id }}
              style={{
                color: "inherit",
                textDecoration: task.done ? "line-through" : "none",
              }}
            >
              {task.title}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
