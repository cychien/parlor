export const ACTION_QUERY_PREFIX = ["_fw", "action"] as const;

export function actionQueryKey(name: string, input: unknown) {
  return [...ACTION_QUERY_PREFIX, name, input ?? {}] as const;
}
