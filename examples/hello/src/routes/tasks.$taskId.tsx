import { useActionMutation, useActionQuery, useAgentView } from "@parlor/client/react";
import { createFileRoute, Link } from "@tanstack/react-router";

import { task as taskView } from "../views.js";

export const Route = createFileRoute("/tasks/$taskId")({
  staticData: {
    description: "One task: its title and whether it is done.",
    views: [taskView],
  },
  component: TaskDetail,
});

function TaskDetail() {
  const { taskId } = Route.useParams();
  const task = useActionQuery("getTask", { id: taskId });

  if (!task.data) {
    return (
      <article>
        <h1>{task.error?.message || "..."}</h1>
        <BackLink />
      </article>
    );
  }
  return <LoadedTask task={task.data} />;
}

interface LoadedTaskProps {
  readonly task: { readonly id: string; readonly title: string; readonly done: boolean };
}

function LoadedTask({ task }: LoadedTaskProps) {
  const toggle = useActionMutation("toggleTask");
  const { ref } = useAgentView(taskView, {
    key: task.id,
    get: () => ({ title: task.title, done: task.done }),
  });

  return (
    <article ref={ref}>
      <h1>{task.title}</h1>
      <label>
        <input
          type="checkbox"
          checked={task.done}
          onChange={() => toggle.mutate({ id: task.id })}
        />{" "}
        Done
      </label>
      <BackLink />
    </article>
  );
}

function BackLink() {
  return (
    <p>
      <Link to="/">Back to tasks</Link>
    </p>
  );
}
