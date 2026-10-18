import { useActionMutation, useActionQuery, useAgentView } from "@parlor/client/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";

import { task as taskView } from "../views.js";

export const Route = createFileRoute("/")({
  staticData: {
    description:
      "Home: a greeting and the task list, oldest first, to add and check off tasks.",
    views: [taskView],
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
          <TaskRow
            key={task.id}
            task={task}
            onToggle={() => toggle.mutate({ id: task.id })}
          />
        ))}
      </ul>
    </section>
  );
}

interface TaskRowProps {
  readonly task: { readonly id: string; readonly title: string; readonly done: boolean };
  readonly onToggle: () => void;
}

function TaskRow({ task, onToggle }: TaskRowProps) {
  const { ref } = useAgentView(taskView, {
    key: task.id,
    get: () => ({ title: task.title, done: task.done }),
  });
  return (
    <li ref={ref} style={{ padding: "4px 0" }}>
      <input
        type="checkbox"
        aria-label={task.title}
        checked={task.done}
        onChange={onToggle}
      />{" "}
      <Link
        to="/tasks/$taskId"
        params={{ taskId: task.id }}
        style={{ color: "inherit", textDecoration: task.done ? "line-through" : "none" }}
      >
        {task.title}
      </Link>
    </li>
  );
}
