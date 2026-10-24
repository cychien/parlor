import {
  ensureActionQueryData,
  useActionMutation,
  useActionSuspenseQuery,
  useAgentView,
} from "@parlor/client/react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { routeErrors } from "../route-errors.js";
import { task as taskView } from "../views.js";

export const Route = createFileRoute("/tasks/$taskId")({
  staticData: {
    description:
      "One task: its title, notes and whether it is done, with a Delete task button.",
    views: [taskView],
  },
  loader: ({ context, params }) =>
    ensureActionQueryData(context, "getTask", { id: params.taskId }),
  onError: routeErrors,
  component: TaskDetail,
  notFoundComponent: TaskNotFound,
});

function TaskDetail() {
  const { taskId } = Route.useParams();
  const navigate = useNavigate();
  const remove = useActionMutation("deleteTask", {
    onSuccess: () => navigate({ to: "/" }),
  });
  const { data: task } = useActionSuspenseQuery(
    "getTask",
    { id: taskId },
    { subscribed: !remove.isPending && !remove.isSuccess },
  );

  return (
    <LoadedTask
      task={task}
      deleting={remove.isPending}
      onDelete={() => remove.mutate({ id: task.id })}
    />
  );
}

function TaskNotFound() {
  return (
    <article>
      <h1>Task not found</h1>
      <BackLink />
    </article>
  );
}

interface LoadedTaskProps {
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly done: boolean;
    readonly notes: string | null;
  };
  readonly deleting: boolean;
  readonly onDelete: () => void;
}

function LoadedTask({ task, deleting, onDelete }: LoadedTaskProps) {
  const toggle = useActionMutation("toggleTask");
  const { ref } = useAgentView(taskView, {
    key: task.id,
    get: () => ({ title: task.title, done: task.done, notes: task.notes ?? "" }),
  });

  return (
    <article ref={ref}>
      <h1>{task.title}</h1>
      {task.notes ? <p className="task-notes">{task.notes}</p> : null}
      <div className="task-actions">
        <label>
          <input
            type="checkbox"
            checked={task.done}
            onChange={() => toggle.mutate({ id: task.id })}
          />{" "}
          Done
        </label>
        <button type="button" className="danger" disabled={deleting} onClick={onDelete}>
          Delete task
        </button>
      </div>
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
