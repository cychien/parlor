import {
  type ActionErrorBody,
  isMutating,
  type ReadRequest,
  type RefreshedRead,
  readTagsFor,
  type Tag,
  tagsOverlap,
} from "@parlor/core";
import type { ActionRegistry } from "@parlor/core/registry";

export interface ReadRun {
  readonly data: unknown;
  readonly tags: readonly Tag[];
  readonly cursor?: string | undefined;
}

/** Whether a read shows anything `writes` changed, by the tables it declares for its input. */
function touched(
  actions: ActionRegistry,
  [name, input]: ReadRequest,
  writes: readonly Tag[],
) {
  const action = actions.get(name);
  if (!action || isMutating(action) || writes.length === 0) return false;
  const parsed = action.input.safeParse(input);
  if (!parsed.success) return false;
  return readTagsFor(action, parsed.data).some((read) =>
    writes.some((write) => tagsOverlap(read, write)),
  );
}

/**
 * The reads a page named on a write, each run again after it when the write changed what it
 * shows, else null. Each runs as its own call, with the caller's own access; one that fails
 * answers its error and leaves the others.
 */
export function refreshReads(
  actions: ActionRegistry,
  requests: readonly ReadRequest[],
  writes: readonly Tag[],
  run: (name: string, input: unknown) => Promise<ReadRun>,
  errorBody: (error: unknown) => ActionErrorBody,
): Promise<RefreshedRead[]> {
  return Promise.all(
    requests.map(async (request): Promise<RefreshedRead> => {
      if (!touched(actions, request, writes)) return null;
      try {
        const { data, tags, cursor } = await run(request[0], request[1]);
        return cursor === undefined ? { data, tags } : { data, tags, cursor };
      } catch (error) {
        return errorBody(error);
      }
    }),
  );
}
