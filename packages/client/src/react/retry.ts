import type { UseQueryOptions } from "@tanstack/react-query";

type Retry = NonNullable<UseQueryOptions["retry"]>;

const DEFAULT_RETRIES = 3;

export function actionRetry(base: Retry = DEFAULT_RETRIES) {
  return (failureCount: number, error: Error): boolean => {
    if (typeof base === "function") return base(failureCount, error);
    return base === true || (base !== false && failureCount < base);
  };
}
