import { useActionMutation, useActionQuery, useAgentView } from "@parlor/client/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";

import { newTask as newTaskView, task as taskView } from "../views.js";

export const Route = createFileRoute("/")({
  staticData: {
    description:
      "Home: a greeting, the New task form (title and notes, the user presses Add), and the task list, oldest first, to check off tasks.",
    views: [newTaskView, taskView],
  },
  component: Home,
});

function Home() {
  const [name, setName] = useState("world");
  const greeting = useActionQuery("hello", { name });

  return (
    <>
      <h1>{greeting.data?.message ?? (greeting.error?.message || "...")}</h1>
      <label className="field">
        <span>Name</span>
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
  const list = useActionQuery("listTasks", {});
  const toggle = useActionMutation("toggleTask");

  return (
    <section>
      <h2>Tasks</h2>
      <NewTaskForm />
      <ul data-testid="tasks" className="tasks">
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

const EMPTY_DRAFT = { title: "", notes: "" };

function NewTaskForm() {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const { ref, agentFields } = useAgentView(newTaskView, {
    get: () => draft,
    set: setDraft,
  });
  const create = useActionMutation("createTask", {
    onSuccess: () => setDraft(EMPTY_DRAFT),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const title = draft.title.trim();
    const notes = draft.notes.trim();
    if (title) create.mutate({ title, ...(notes ? { notes } : {}) });
  };

  return (
    <form ref={ref} onSubmit={submit} className="stack">
      <input
        id="task-title"
        name="title"
        autoComplete="off"
        placeholder="New task"
        aria-label="New task"
        value={draft.title}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        data-agent-filled={agentFields.has("title") || undefined}
      />
      <textarea
        id="task-notes"
        name="notes"
        rows={2}
        placeholder="Notes"
        aria-label="Notes"
        value={draft.notes}
        onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
        data-agent-filled={agentFields.has("notes") || undefined}
      />
      <button type="submit" className="primary" disabled={create.isPending}>
        Add
      </button>
    </form>
  );
}

interface TaskRowProps {
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly done: boolean;
    readonly notes: string | null;
  };
  readonly onToggle: () => void;
}

function TaskRow({ task, onToggle }: TaskRowProps) {
  const { ref } = useAgentView(taskView, {
    key: task.id,
    get: () => ({ title: task.title, done: task.done, notes: task.notes ?? "" }),
  });
  return (
    <li ref={ref}>
      <input
        type="checkbox"
        aria-label={task.title}
        checked={task.done}
        onChange={onToggle}
      />
      <Link
        to="/tasks/$taskId"
        params={{ taskId: task.id }}
        data-done={task.done || undefined}
      >
        {task.title}
      </Link>
    </li>
  );
}
