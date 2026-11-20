/** Past this, an unread body is cancelled instead of read, so refusing a large upload stays cheap. */
export const UNREAD_BODY_LIMIT_BYTES = 1 << 20;

/**
 * Reads the part of `request`'s body the server left unread. The Worker streams the body into
 * the Durable Object, and workerd throws in the Worker when it reads the body after the object
 * answered, so the object reads it first.
 */
export async function readUnreadBody(
  request: Request,
  limitBytes: number,
): Promise<void> {
  if (!request.body || request.bodyUsed) return;
  const reader = request.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
      if (size > limitBytes) {
        await reader.cancel();
        return;
      }
    }
  } catch {
    // The client went away; nothing is left to read.
  }
}
