import { useActionMutation, useActionQuery } from "@parlor/client/react";
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/tasks/$taskId")({
  staticData: { description: "One task: its title and whether it is done." },
  component: TaskDetail,
});

function TaskDetail() {
  const { taskId } = Route.useParams();
  const task = useActionQuery("getTask", { id: taskId });
  const toggle = useActionMutation("toggleTask");

  return (
    <article>
      <h1>{task.data?.title ?? (task.error?.message || "...")}</h1>
      {task.data && (
        <label>
          <input
            type="checkbox"
            checked={task.data.done}
            onChange={() => toggle.mutate({ id: taskId })}
          />{" "}
          Done
        </label>
      )}
      <p>
        <Link to="/">Back to tasks</Link>
      </p>
    </article>
  );
}
