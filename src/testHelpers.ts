import sharp from "sharp";
import { vi } from "vitest";

/** A real PNG of the given size, as a Buffer. */
export const makePng = (w = 100, h = 80) =>
  sharp({
    create: { width: w, height: h, channels: 3, background: "#ff0000" },
  })
    .png()
    .toBuffer();

/**
 * Stub the global `fetch` so upstream image requests resolve to `body` with the
 * given content type. Returns the mock so tests can assert on call counts.
 */
export const stubUpstream = (body: Buffer, contentType = "image/png") => {
  const fetchMock = vi.fn(
    async () =>
      new Response(new Uint8Array(body), {
        status: 200,
        headers: { "content-type": contentType },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};
