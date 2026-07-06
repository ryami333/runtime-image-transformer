import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createImageTransformRouteHandler } from "./createImageTransformRouteHandler";
import { createImageUrlBuilder } from "./createImageUrlBuilder";
import { makePng, stubUpstream } from "./testHelpers";

const API = "https://cdn.example.com/_image";
const buildUrl = createImageUrlBuilder({ apiRouteUrl: API });

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "transform-cache-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(cacheDir, { recursive: true, force: true });
});

const req = (config: Parameters<typeof buildUrl>[0]) =>
  new Request(buildUrl(config));

describe("happy path", () => {
  it("resizes and converts to webp", async () => {
    stubUpstream(await makePng(200, 200));
    const handler = createImageTransformRouteHandler({
      apiRouteUrl: API,
      cacheDir,
    });

    const res = await handler(
      req({ source: "https://origin.test/a.png", w: 50, fmt: "webp" }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("Cache-Control")).toContain("immutable");

    // Decode the output and assert on it for real.
    const out = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(50); // withoutEnlargement + inside fit
  });

  it("does not enlarge images past their source size", async () => {
    stubUpstream(await makePng(40, 40));
    const handler = createImageTransformRouteHandler({
      apiRouteUrl: API,
      cacheDir,
    });

    const res = await handler(
      req({ source: "https://origin.test/small.png", w: 500, fmt: "webp" }),
    );

    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta.width).toBe(40);
  });

  it("preserves the upstream content type when fmt is preserve", async () => {
    stubUpstream(await makePng(), "image/png");
    const handler = createImageTransformRouteHandler({
      apiRouteUrl: API,
      cacheDir,
    });

    const res = await handler(
      req({ source: "https://origin.test/a.png", fmt: "preserve" }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("caches: a second request does not hit upstream", async () => {
    const fetchMock = stubUpstream(await makePng());
    const handler = createImageTransformRouteHandler({
      apiRouteUrl: API,
      cacheDir,
    });
    const send = () =>
      handler(req({ source: "https://origin.test/a.png", fmt: "webp" }));

    const first = await send();
    const second = await send();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("Content-Type")).toBe("image/webp");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("rejects bad input", () => {
  const makeHandler = () =>
    createImageTransformRouteHandler({ apiRouteUrl: API, cacheDir });

  it("400 when the request URL is not the transform route", async () => {
    const res = await makeHandler()(new Request("https://x/not-the-route"));
    expect(res.status).toBe(400);
  });

  it("400 on a non-http(s) source", async () => {
    const res = await makeHandler()(
      req({ source: "ftp://origin.test/a.png", fmt: "webp" }),
    );
    expect(res.status).toBe(400);
  });

  it("400 when the source URL carries credentials", async () => {
    const res = await makeHandler()(
      req({ source: "https://user:pass@origin.test/a.png", fmt: "webp" }),
    );
    expect(res.status).toBe(400);
  });

  it("502 when the upstream fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    const res = await makeHandler()(
      req({ source: "https://origin.test/a.png", fmt: "webp" }),
    );
    expect(res.status).toBe(502);
  });
});

describe("allowedHosts", () => {
  it("403 when the source host is not allowlisted", async () => {
    stubUpstream(await makePng());
    const handler = createImageTransformRouteHandler({
      apiRouteUrl: API,
      cacheDir,
      allowedHosts: ["images.example.com"],
    });

    const res = await handler(
      req({ source: "https://evil.test/a.png", fmt: "webp" }),
    );
    expect(res.status).toBe(403);
  });

  it("200 when the source host matches an allowlist entry", async () => {
    stubUpstream(await makePng());
    const handler = createImageTransformRouteHandler({
      apiRouteUrl: API,
      cacheDir,
      allowedHosts: ["images.example.com"],
    });

    const res = await handler(
      req({ source: "https://images.example.com/a.png", fmt: "webp" }),
    );
    expect(res.status).toBe(200);
  });

  it("serves a cached entry even if the host is no longer allowlisted", async () => {
    // Documents current behaviour: the cache lookup happens before the
    // allowedHosts check, so a previously-cached transform is still served.
    stubUpstream(await makePng());
    const source = "https://images.example.com/a.png";

    const permissive = createImageTransformRouteHandler({
      apiRouteUrl: API,
      cacheDir,
    });
    const primed = await permissive(req({ source, fmt: "webp" }));
    expect(primed.status).toBe(200);

    const restricted = createImageTransformRouteHandler({
      apiRouteUrl: API,
      cacheDir,
      allowedHosts: ["other.example.com"],
    });
    const res = await restricted(req({ source, fmt: "webp" }));
    expect(res.status).toBe(200);
  });
});
