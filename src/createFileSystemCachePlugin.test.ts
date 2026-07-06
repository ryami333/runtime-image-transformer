import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createImageTransformRouteHandler } from "./createImageTransformRouteHandler";
import { createFileSystemCachePlugin } from "./createFileSystemCachePlugin";
import { createImageUrlBuilder } from "./createImageUrlBuilder";
import { makePng, stubUpstream } from "./testHelpers";
import type { CachePlugin } from "./CachePlugin";

const API = "https://cdn.example.com/_image";
const SOURCE_ORIGIN = "https://origin.test";
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

const makeHandler = (cachePlugin: CachePlugin) =>
  createImageTransformRouteHandler({
    sourceOrigin: SOURCE_ORIGIN,
    sharp,
    cachePlugin,
  });

describe("createFileSystemCachePlugin", () => {
  it("caches: a second request does not hit upstream", async () => {
    const fetchMock = stubUpstream(await makePng());
    const handler = makeHandler(createFileSystemCachePlugin({ cacheDir }));
    const send = () => handler(req({ source: "/a.png", fmt: "webp" }));

    const first = await send();
    const second = await send();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("Content-Type")).toBe("image/webp");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not write cache files outside cacheDir for a hostile source", async () => {
    // A root we fully control: the cache is a nested subdir, and `outside` is a
    // sibling a traversal write would have to escape into.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "traversal-"));
    const nestedCacheDir = path.join(root, "cache");
    const outside = path.join(root, "outside");
    await fs.mkdir(outside, { recursive: true });

    stubUpstream(await makePng());
    const handler = makeHandler(
      createFileSystemCachePlugin({ cacheDir: nestedCacheDir }),
    );

    // The raw source (with its `../`) is what gets hashed into the cache key, so
    // this is the exact string a traversal attack would rely on.
    const res = await handler(
      req({ source: "/../../../../outside/pwned", fmt: "webp" }),
    );
    expect(res.status).toBe(200);

    // The sibling dir is untouched — nothing escaped the cache root...
    expect(await fs.readdir(outside)).toEqual([]);

    // ...and the response really was cached (so the assertion above isn't
    // vacuous), entirely under the cache root.
    const written = await fs.readdir(nestedCacheDir, { recursive: true });
    expect(written.some((f) => String(f).endsWith(".bin"))).toBe(true);

    await fs.rm(root, { recursive: true, force: true });
  });
});
