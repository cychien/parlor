import { useActionMutation, useActionQuery } from "@parlor/client/react";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";

export const Route = createFileRoute("/")({
  staticData: {
    description: "The todo list: add a todo, check it off, or delete it.",
  },
  component: Todos,
});

function Todos() {
  const list = useActionQuery("listTodos", {});
  const toggle = useActionMutation("toggleTodo");
  const remove = useActionMutation("deleteTodo");
  const todos = list.data ?? [];

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Todos</h1>
      <NewTodo />
      {list.data && todos.length === 0 ? (
        <p className="text-sm text-zinc-500">
          Nothing yet. Add a todo, or ask the agent to.
        </p>
      ) : null}
      <ul
        data-testid="todos"
        className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white empty:hidden"
      >
        {todos.map((todo) => (
          <li key={todo.id} className="flex items-center gap-3 px-4 py-3">
            <input
              type="checkbox"
              className="size-4 accent-zinc-900"
              checked={todo.done}
              aria-label={`Done: ${todo.title}`}
              onChange={() => toggle.mutate({ id: todo.id })}
            />
            <span className={todo.done ? "flex-1 text-zinc-400 line-through" : "flex-1"}>
              {todo.title}
            </span>
            <button
              type="button"
              className="text-sm text-zinc-500 hover:text-red-600"
              onClick={() => remove.mutate({ id: todo.id })}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NewTodo() {
  const [title, setTitle] = useState("");
  const add = useActionMutation("addTodo", { onSuccess: () => setTitle("") });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) add.mutate({ title });
  };

  return (
    <form onSubmit={submit} className="flex gap-2">
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
