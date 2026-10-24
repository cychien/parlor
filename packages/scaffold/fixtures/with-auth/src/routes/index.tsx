import { defineAgentView } from "@parlor/client";
import {
  ensureActionQueryData,
  useActionMutation,
  useActionSuspenseQuery,
  useAgentView,
} from "@parlor/client/react";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import * as z from "zod/mini";

const todoView = defineAgentView({
  name: "todo",
  description: "A todo. The key is the todo id that toggleTodo and deleteTodo take.",
  keyed: true,
  schema: z.object({ title: z.string(), done: z.boolean() }),
});

const newTodoView = defineAgentView({
  name: "newTodo",
  description: "The New todo field. Fill it in for the user; they press Add themselves.",
  schema: z.object({ title: z.string() }),
  writable: true,
});

export const Route = createFileRoute("/")({
  staticData: {
    description: "The todo list: add a todo, check it off, or delete it.",
    views: [newTodoView, todoView],
  },
  loader: ({ context }) => ensureActionQueryData(context, "listTodos", {}),
  component: Todos,
});

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

function Todos() {
  const { data: todos } = useActionSuspenseQuery("listTodos", {});
  const toggle = useActionMutation("toggleTodo");
  const remove = useActionMutation("deleteTodo");

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Todos</h1>
      <NewTodo />
      {todos.length === 0 ? (
        <p className="text-sm text-zinc-500">
          Nothing yet. Add a todo, or ask the agent to.
        </p>
      ) : null}
      <ul
        data-testid="todos"
        className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white empty:hidden"
      >
        {todos.map((todo) => (
          <TodoRow
            key={todo.id}
            todo={todo}
            onToggle={() => toggle.mutate({ id: todo.id })}
            onDelete={() => remove.mutate({ id: todo.id })}
          />
        ))}
      </ul>
    </section>
  );
}

function TodoRow({
  todo,
  onToggle,
  onDelete,
}: {
  readonly todo: Todo;
  readonly onToggle: () => void;
  readonly onDelete: () => void;
}) {
  const { ref } = useAgentView(todoView, {
    key: todo.id,
    get: () => ({ title: todo.title, done: todo.done }),
  });
  return (
    <li ref={ref} className="flex items-center gap-3 px-4 py-3">
      <input
        type="checkbox"
        className="size-4 accent-zinc-900"
        checked={todo.done}
        aria-label={`Done: ${todo.title}`}
        onChange={onToggle}
      />
      <span className={todo.done ? "flex-1 text-zinc-400 line-through" : "flex-1"}>
        {todo.title}
      </span>
      <button
        type="button"
        className="text-sm text-zinc-500 hover:text-red-600"
        onClick={onDelete}
      >
        Delete
      </button>
    </li>
  );
}

function NewTodo() {
  const [title, setTitle] = useState("");
  const { ref } = useAgentView(newTodoView, {
    get: () => ({ title }),
    set: (value) => setTitle(value.title),
  });
  const add = useActionMutation("addTodo", { onSuccess: () => setTitle("") });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) add.mutate({ title });
  };

  return (
    <form ref={ref} onSubmit={submit} className="flex gap-2">
      <input
        name="title"
        aria-label="New todo"
        placeholder="What needs to be done?"
        autoComplete="off"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 focus:border-zinc-900 focus:outline-none"
      />
      <button
        type="submit"
        disabled={add.isPending}
        className="rounded-md bg-zinc-900 px-4 py-2 font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
      >
        Add
      </button>
    </form>
  );
}
