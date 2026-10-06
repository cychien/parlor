import type { z } from "zod";

export type ActionErrorCode = "not_found" | "invalid_input" | "internal";

export interface ActionErrorBody {
  readonly error: {
    readonly code: ActionErrorCode;
    readonly message: string;
    readonly issues?: readonly z.core.$ZodIssue[] | undefined;
  };
}

export class ActionError extends Error {
  override readonly name = "ActionError";
  readonly code: ActionErrorCode;
  readonly issues: readonly z.core.$ZodIssue[] | undefined;

  constructor(
    code: ActionErrorCode,
    message: string,
    options?: { issues?: readonly z.core.$ZodIssue[] | undefined; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.issues = options?.issues;
  }

  toBody(): ActionErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.issues ? { issues: this.issues } : {}),
      },
    };
  }

  static fromBody(body: ActionErrorBody): ActionError {
    return new ActionError(body.error.code, body.error.message, {
      issues: body.error.issues,
    });
  }

  static isBody(value: unknown): value is ActionErrorBody {
    if (typeof value !== "object" || value === null || !("error" in value)) return false;
    const error = (value as { error: unknown }).error;
    return (
      typeof error === "object" && error !== null && "code" in error && "message" in error
    );
  }
}
