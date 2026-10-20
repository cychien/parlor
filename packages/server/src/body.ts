/**
 * The request body as text, or undefined once it passes `limitBytes`. A declared
 * `Content-Length` over the limit is refused unread; otherwise the stream is read chunk by
 * chunk and cancelled the moment the bytes read pass the limit.
 */
export async function readBoundedText(
  request: Request,
  limitBytes: number,
): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > limitBytes) return undefined;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limitBytes) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
