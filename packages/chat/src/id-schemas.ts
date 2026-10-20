import { asId, type Id, type IdKind } from "@parlor/core";
import { z } from "zod";

/** A request field naming an entity: validated, then branded, at the boundary. */
export function idSchema<K extends IdKind>(
  kind: K,
): z.ZodPipe<z.ZodString, z.ZodTransform<Id<K>, string>> {
  return z
    .string()
    .min(1)
    .max(64)
    .transform((value) => asId(kind, value));
}
