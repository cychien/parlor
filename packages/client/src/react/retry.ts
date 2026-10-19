import { ActionError, type ActionErrorCode } from "@parlor/core";
import type { UseQueryOptions } from "@tanstack/react-query";

type Retry = NonNullable<UseQueryOptions["retry"]>;

const DEFAULT_RETRIES = 3;

const RETRY_CAN_CHANGE_OUTCOME: Readonly<Record<ActionErrorCode, boolean>> = {
  not_found: false,
  invalid_input: false,
  declined: false,
  confirmation_timeout: true,
  confirmation_unavailable: true,
  internal: true,
};

export function actionRetry(base: Retry = DEFAULT_RETRIES) {
  return (failureCount: number, error: Error): boolean => {
    if (error instanceof ActionError && !RETRY_CAN_CHANGE_OUTCOME[error.code])
      return false;
    if (typeof base === "function") return base(failureCount, error);
    return base === true || (base !== false && failureCount < base);
  };
}
