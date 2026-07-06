/**
 * Read a fetch `Response` body into a Buffer, but refuse to buffer more than
 * `maxBytes`. Returns `null` if the body exceeds the cap (so the caller can turn
 * that into an error response).
 *
 * Enforcement is two-layered because neither layer is sufficient alone:
 *
 * 1. A declared `Content-Length` over the cap is rejected up front, before any
 *    of the body is downloaded.
 * 2. The body is then read incrementally and aborted the moment the running
 *    total exceeds the cap — this is what protects against a missing or lying
 *    `Content-Length` (e.g. chunked transfer encoding).
 */
export async function readCappedBody(
  response: Response,
  maxBytes: number,
): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return null;
  }

  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > maxBytes) {
        // Stop the transfer instead of draining the rest of the stream.
        await reader.cancel();
        return null;
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}
