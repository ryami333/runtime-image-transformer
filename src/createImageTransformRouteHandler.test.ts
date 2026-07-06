import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createImageTransformRouteHandler } from "./createImageTransformRouteHandler";
import { createFileSystemCache } from "./createFileSystemCache";
import { createImageUrlBuilder } from "./createImageUrlBuilder";
import { makePng, stubUpstream } from "./testHelpers";
import type { CacheEntry, CachePlugin } from "./CachePlugin";

const API = "https://cdn.example.com/_image";
const SOURCE_ORIGIN = "https://origin.test";
const buildUrl = createImageUrlBuilder({ apiRouteUrl: API });

let cacheDir: string;
let cache: CachePlugin;

beforeEach(async () => {
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "transform-cache-"));
  cache = createFileSystemCache({ cacheDir });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(cacheDir, { recursive: true, force: true });
});

const req = (config: Parameters<typeof buildUrl>[0]) =>
  new Request(buildUrl(config));

const makeHandler = () =>
  createImageTransformRouteHandler({
    sourceOrigin: SOURCE_ORIGIN,
    sharp,
    cache,
  });

describe("happy path", () => {
  it("resizes and converts to webp", async () => {
    stubUpstream(await makePng(200, 200));
    const handler = makeHandler();

    const res = await handler(req({ source: "/a.png", w: 50, fmt: "webp" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("Cache-Control")).toContain("immutable");

    // Decode the output and assert on it for real.
    const out = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(50); // withoutEnlargement + inside fit
  });

  it.each([
    // `decodedFormat` is what Sharp reports when re-reading the output, which
    // isn't always the request name (AVIF is a HEIF-family container).
    ["jpeg", "image/jpeg", "jpeg"],
    ["png", "image/png", "png"],
    ["avif", "image/avif", "heif"],
    ["gif", "image/gif", "gif"],
    ["tiff", "image/tiff", "tiff"],
  ] as const)("transcodes to %s", async (fmt, contentType, decodedFormat) => {
    stubUpstream(await makePng(200, 200));
    // These formats aren't in the default allowlist, so opt them all in.
    const handler = createImageTransformRouteHandler({
      sourceOrigin: SOURCE_ORIGIN,
      sharp,
      cache,
      allowedFormats: ["jpeg", "png", "webp", "avif", "gif", "tiff"],
    });

    const res = await handler(req({ source: "/a.png", fmt }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(contentType);

    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta.format).toBe(decodedFormat);
  });

  it("resolves the source path against sourceOrigin", async () => {
    const fetchMock = stubUpstream(await makePng());
    const handler = makeHandler();

    await handler(req({ source: "/nested/a.png", fmt: "webp" }));

    const fetchedUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(fetchedUrl).toBe("https://origin.test/nested/a.png");
  });

  it("does not enlarge images past their source size", async () => {
    stubUpstream(await makePng(40, 40));
    const handler = makeHandler();

    const res = await handler(
      req({ source: "/small.png", w: 500, fmt: "webp" }),
    );

    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta.width).toBe(40);
  });

  it("preserves the upstream content type when fmt is preserve", async () => {
    stubUpstream(await makePng(), "image/png");
    const handler = makeHandler();

    const res = await handler(req({ source: "/a.png", fmt: "preserve" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("accepts preserve when the image content type has odd casing or params", async () => {
    // The guard normalizes before matching, so a legitimate image labelled
    // `IMAGE/PNG; charset=binary` must not be falsely rejected.
    stubUpstream(await makePng(), "IMAGE/PNG; charset=binary");
    const res = await makeHandler()(req({ source: "/a.png", fmt: "preserve" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("IMAGE/PNG; charset=binary");
  });

  it("sends X-Content-Type-Options: nosniff on fresh and cached responses", async () => {
    stubUpstream(await makePng());
    const handler = makeHandler();

    const fresh = await handler(req({ source: "/a.png", fmt: "webp" }));
    const cached = await handler(req({ source: "/a.png", fmt: "webp" }));

    expect(fresh.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(cached.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("advertises the significant query params via No-Vary-Search", async () => {
    stubUpstream(await makePng());
    const handler = makeHandler();

    // Fresh response, then the cache-hit response — both should carry it.
    const fresh = await handler(req({ source: "/a.png", fmt: "webp" }));
    const cached = await handler(req({ source: "/a.png", fmt: "webp" }));

    const expected =
      'key-order, params, except=("w" "h" "fit" "fmt" "q" "source")';
    expect(fresh.headers.get("No-Vary-Search")).toBe(expected);
    expect(cached.headers.get("No-Vary-Search")).toBe(expected);
  });

  it("caches: a second request does not hit upstream", async () => {
    const fetchMock = stubUpstream(await makePng());
    const handler = makeHandler();
    const send = () => handler(req({ source: "/a.png", fmt: "webp" }));

    const first = await send();
    const second = await send();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("Content-Type")).toBe("image/webp");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("rejects bad input", () => {
  it("400 when the request URL is not the transform route", async () => {
    const res = await makeHandler()(new Request("https://x/not-the-route"));
    expect(res.status).toBe(400);
  });

  it("400 on an absolute (cross-origin) source", async () => {
    stubUpstream(await makePng());
    const res = await makeHandler()(
      req({ source: "https://evil.test/a.png", fmt: "webp" }),
    );
    expect(res.status).toBe(400);
  });

  it("400 on a protocol-relative source", async () => {
    stubUpstream(await makePng());
    const res = await makeHandler()(
      req({ source: "//evil.test/a.png", fmt: "webp" }),
    );
    expect(res.status).toBe(400);
  });

  it("400 on a file: source (opaque origin)", async () => {
    stubUpstream(await makePng());
    const res = await makeHandler()(
      req({ source: "file:///etc/passwd", fmt: "webp" }),
    );
    expect(res.status).toBe(400);
  });

  it("400 on a data: source", async () => {
    stubUpstream(await makePng());
    const res = await makeHandler()(
      req({ source: "data:text/html,<script>alert(1)</script>", fmt: "webp" }),
    );
    expect(res.status).toBe(400);
  });

  it("400 on a userinfo-smuggled cross-origin source", async () => {
    // `origin.test@evil.test` parses with host evil.test — the origin check must
    // compare the real host, not be fooled by the userinfo prefix.
    stubUpstream(await makePng());
    const res = await makeHandler()(
      req({ source: "https://origin.test@evil.test/a.png", fmt: "webp" }),
    );
    expect(res.status).toBe(400);
  });

  it("400 on a same-host but different-port source", async () => {
    // The guard is origin equality (scheme + host + port), so a different port
    // is off-origin even though the host matches.
    stubUpstream(await makePng());
    const res = await makeHandler()(
      req({ source: "https://origin.test:1234/a.png", fmt: "webp" }),
    );
    expect(res.status).toBe(400);
  });

  it("502 when the upstream fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    const res = await makeHandler()(req({ source: "/a.png", fmt: "webp" }));
    expect(res.status).toBe(502);
  });

  it("502 on preserve when the upstream content type is not an image", async () => {
    // An HTML file living on the source origin: without the guard its bytes and
    // text/html type would be served verbatim from this origin (sniffing XSS).
    stubUpstream(Buffer.from("<script>alert(1)</script>"), "text/html");
    const res = await makeHandler()(req({ source: "/evil.html" }));
    expect(res.status).toBe(502);
  });

  it("502 on preserve when the upstream sends no content type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      ),
    );
    const res = await makeHandler()(req({ source: "/x" }));
    expect(res.status).toBe(502);
  });

  it("transcodes even when the upstream content type is not an image", async () => {
    // The preserve-only guard must not block re-encoding: the output type is
    // fixed by `fmt`, so a mislabeled upstream is fine as long as it decodes.
    stubUpstream(await makePng(), "application/octet-stream");
    const res = await makeHandler()(req({ source: "/a.png", fmt: "webp" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
  });
});

describe("allowedFormats", () => {
  it("400 when the requested fmt is not allowed (gif, by default)", async () => {
    stubUpstream(await makePng());
    const res = await makeHandler()(req({ source: "/a.png", fmt: "gif" }));
    expect(res.status).toBe(400);
  });

  it("allows a format once it is added to allowedFormats", async () => {
    stubUpstream(await makePng());
    const handler = createImageTransformRouteHandler({
      sourceOrigin: SOURCE_ORIGIN,
      sharp,
      cache,
      allowedFormats: ["preserve", "webp", "avif", "gif"],
    });

    const res = await handler(req({ source: "/a.png", fmt: "gif" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/gif");
  });

  it("400 on an omitted fmt when preserve is not allowed", async () => {
    stubUpstream(await makePng());
    const handler = createImageTransformRouteHandler({
      sourceOrigin: SOURCE_ORIGIN,
      sharp,
      cache,
      allowedFormats: ["webp", "avif"],
    });

    // No `fmt` means the effective format is "preserve", which this config
    // forbids — so every request must name an allowed format.
    const res = await handler(req({ source: "/a.png" }));
    expect(res.status).toBe(400);
  });
});

describe("maxSourceBytes", () => {
  it("502 when the streamed body exceeds the cap", async () => {
    // No Content-Length is set on this Response, so the cap can only be
    // enforced while reading the body.
    stubUpstream(await makePng(200, 200));
    const handler = createImageTransformRouteHandler({
      sourceOrigin: SOURCE_ORIGIN,
      sharp,
      cache,
      maxSourceBytes: 10,
    });

    const res = await handler(req({ source: "/a.png", fmt: "webp" }));
    expect(res.status).toBe(502);
  });

  it("502 up front when Content-Length exceeds the cap", async () => {
    const png = await makePng(1, 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(png), {
            status: 200,
            headers: {
              "content-type": "image/png",
              // Lie about a small body being huge; the pre-check should reject
              // it without reading the (small) body.
              "content-length": "999999999",
            },
          }),
      ),
    );
    const handler = createImageTransformRouteHandler({
      sourceOrigin: SOURCE_ORIGIN,
      sharp,
      cache,
      maxSourceBytes: 1024,
    });

    const res = await handler(req({ source: "/a.png", fmt: "webp" }));
    expect(res.status).toBe(502);
  });

  it("allows images under the cap", async () => {
    stubUpstream(await makePng(20, 20));
    const handler = createImageTransformRouteHandler({
      sourceOrigin: SOURCE_ORIGIN,
      sharp,
      cache,
      maxSourceBytes: 10 * 1024 * 1024,
    });

    const res = await handler(req({ source: "/a.png", fmt: "webp" }));
    expect(res.status).toBe(200);
  });
});

describe("maxInputPixels", () => {
  it("502 when the decoded source exceeds the pixel limit", async () => {
    // A modest byte size, but more pixels than the (tiny) limit allows — the
    // case maxSourceBytes can't catch.
    stubUpstream(await makePng(1000, 1000));
    const handler = createImageTransformRouteHandler({
      sourceOrigin: SOURCE_ORIGIN,
      sharp,
      cache,
      maxInputPixels: 1000,
    });

    const res = await handler(req({ source: "/a.png", fmt: "webp" }));
    expect(res.status).toBe(502);
  });

  it("502 when the upstream is not a decodable image", async () => {
    stubUpstream(Buffer.from("this is not an image"));
    const res = await makeHandler()(req({ source: "/a.png", fmt: "webp" }));
    expect(res.status).toBe(502);
  });
});

describe("rejects out-of-range dimensions", () => {
  // Hand-craft the URL: the builder validates on encode, so an out-of-range
  // dimension can only reach the handler from a forged/malicious request.
  const forge = (query: string) => new Request(`${API}?source=/a.png&${query}`);

  it("400 on a non-positive width", async () => {
    stubUpstream(await makePng());
    const res = await makeHandler()(forge("w=0"));
    expect(res.status).toBe(400);
  });

  it("400 on an oversized width", async () => {
    stubUpstream(await makePng());
    const res = await makeHandler()(forge("w=100000"));
    expect(res.status).toBe(400);
  });
});

describe("fetch timeout", () => {
  it("502 when the upstream does not respond within fetchTimeoutMs", async () => {
    // A fetch that only settles when its abort signal fires, so the real
    // AbortSignal.timeout drives the test (quickly).
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const handler = createImageTransformRouteHandler({
      sourceOrigin: SOURCE_ORIGIN,
      sharp,
      cache,
      fetchTimeoutMs: 20,
    });

    const res = await handler(req({ source: "/a.png", fmt: "webp" }));

    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("502 when the upstream fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const res = await makeHandler()(req({ source: "/a.png", fmt: "webp" }));
    expect(res.status).toBe(502);
  });
});

describe("sourceOrigin validation", () => {
  it("throws when sourceOrigin is not an absolute URL", () => {
    expect(() =>
      createImageTransformRouteHandler({
        sourceOrigin: "/images",
        sharp,
        cache,
      }),
    ).toThrow(/absolute/);
  });

  it("throws when sourceOrigin is not http(s)", () => {
    expect(() =>
      createImageTransformRouteHandler({
        sourceOrigin: "ftp://origin.test",
        sharp,
        cache,
      }),
    ).toThrow(/http/);
  });
});

describe("SSRF: upstream redirects are not followed", () => {
  it("passes redirect: manual to fetch and rejects a redirected upstream", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await makeHandler()(req({ source: "/a.png", fmt: "webp" }));

    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ redirect: "manual" }),
    );
  });
});

describe("path traversal", () => {
  it("collapses ../ in the source onto the trusted origin's root", async () => {
    const fetchMock = stubUpstream(await makePng());

    const res = await makeHandler()(
      req({ source: "/../../../etc/passwd", fmt: "webp" }),
    );

    // URL normalization eats the `..` segments: the fetch target stays under
    // sourceOrigin and can never climb above its root.
    expect(res.status).toBe(200);
    const fetchedUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(fetchedUrl).toBe("https://origin.test/etc/passwd");
  });

  it("does not write cache files outside cacheDir for a hostile source", async () => {
    // A root we fully control: cacheDir is a nested subdir, and `outside` is a
    // sibling a traversal write would have to escape into.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "traversal-"));
    const nestedCacheDir = path.join(root, "cache");
    const outside = path.join(root, "outside");
    await fs.mkdir(outside, { recursive: true });

    stubUpstream(await makePng());
    const handler = createImageTransformRouteHandler({
      sourceOrigin: SOURCE_ORIGIN,
      sharp,
      cache: createFileSystemCache({ cacheDir: nestedCacheDir }),
    });

    // The raw source (with its `../`) is what gets hashed into the cache key, so
    // this is the exact string a traversal attack would rely on.
    const res = await handler(
      req({ source: "/../../../../outside/pwned", fmt: "webp" }),
    );
    expect(res.status).toBe(200);

    // The sibling dir is untouched — nothing escaped the cache root...
    expect(await fs.readdir(outside)).toEqual([]);

    // ...and the response really was cached (so the assertion above isn't
    // vacuous), entirely under cacheDir.
    const written = await fs.readdir(nestedCacheDir, { recursive: true });
    expect(written.some((f) => String(f).endsWith(".bin"))).toBe(true);

    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("custom cache plugin", () => {
  it("disables caching when no cache is supplied", async () => {
    const fetchMock = stubUpstream(await makePng());
    const handler = createImageTransformRouteHandler({
      sourceOrigin: SOURCE_ORIGIN,
      sharp,
    });
    const send = () => handler(req({ source: "/a.png", fmt: "webp" }));

    const first = await send();
    const second = await send();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("Content-Type")).toBe("image/webp");
    // No cache means every request is transformed from upstream.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads from and writes to a supplied CachePlugin", async () => {
    const store = new Map<string, CacheEntry>();
    const reads: string[] = [];
    const cache: CachePlugin = {
      read: async (key) => {
        reads.push(key);
        return store.get(key) ?? null;
      },
      write: async (key, entry) => {
        store.set(key, entry);
      },
    };

    const fetchMock = stubUpstream(await makePng());
    const handler = createImageTransformRouteHandler({
      sourceOrigin: SOURCE_ORIGIN,
      sharp,
      cache,
    });
    const send = () => handler(req({ source: "/a.png", fmt: "webp" }));

    const first = await send();
    expect(first.status).toBe(200);
    // The miss populated the custom store...
    expect(store.size).toBe(1);

    const second = await send();
    expect(second.status).toBe(200);
    expect(second.headers.get("Content-Type")).toBe("image/webp");
    // ...and the second request was served from it, never touching upstream.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Same key both times: a write followed by a hit.
    expect(new Set(reads).size).toBe(1);
  });
});

describe("createImageUrlBuilder", () => {
  it("emits a root-relative URL when given a path route", () => {
    const build = createImageUrlBuilder({ apiRouteUrl: "/api/image" });
    const url = build({ source: "/cat.jpg", w: 800, fmt: "webp" });

    expect(url.startsWith("/api/image?")).toBe(true);
    const params = new URL(url, "http://x").searchParams;
    expect(params.get("source")).toBe("/cat.jpg");
    expect(params.get("w")).toBe("800");
    expect(params.get("fmt")).toBe("webp");
  });
});
