import path from "node:path";
import { createImageUrlCodec } from "./createImageUrlCodec";
import { getTransformCacheKey } from "./getTransformCacheKey";
import { readTransformCache } from "./readTransformCache";
import Sharp from "sharp";
import { pipe } from "fp-ts/function";
import { writeTransformCache } from "./writeTransformCache";

export const createImageTransformRouteHandler = ({
  apiRouteUrl,
  cacheDir = path.join(process.cwd(), ".transform-cache"),
  cacheControl = "public, max-age=31536000, immutable",
  allowedHosts,
}: {
  apiRouteUrl: string;
  cacheDir?: string;
  cacheControl?: string;
  /**
   * Optional allowlist for the `source` URL's host.
   *
   * - Exact matches: `"images.example.com"`
   * - Host + port: `"localhost:3000"`
   * - RegExp: `/^(?:.+\\.)?example\\.com$/` (tested against hostname and host)
   *
   * If omitted, all hosts are allowed (current behavior).
   */
  allowedHosts?: Array<string | RegExp>;
}) => {
  const urlStringToTransformConfig = createImageUrlCodec({ apiRouteUrl });

  const isAllowedSourceUrl = (sourceUrl: URL) => {
    if (!allowedHosts) return true;

    const hostname = sourceUrl.hostname.toLowerCase();
    const host = sourceUrl.host.toLowerCase(); // includes port if present

    return allowedHosts.some((pattern) => {
      if (pattern instanceof RegExp) {
        return pattern.test(hostname) || pattern.test(host);
      }

      const normalized = pattern.toLowerCase();
      return normalized.includes(":")
        ? host === normalized
        : hostname === normalized;
    });
  };

  return async function handler(req: Request): Promise<Response> {
    const { data: transformConfig, error } =
      urlStringToTransformConfig.safeDecode(req.url);

    if (error) {
      return new Response("Bad Request", { status: 400 });
    }

    // Canonical (re-encoded) URL so cache hits even if the original request
    // contains superfluous/unknown query params.
    const canonicalUrl = urlStringToTransformConfig.encode(
      // encode() accepts the decoded transform config shape; we only call this
      // after decoding has succeeded.
      transformConfig,
    );

    const quality = transformConfig.q ?? 100;

    const cacheKey = getTransformCacheKey({ canonicalUrl });
    const cached = await readTransformCache({ cacheKey, cacheDir });
    if (cached) {
      return new Response(cached.body, {
        headers: {
          "Content-Type": cached.contentType,
          "Cache-Control": cacheControl,
        },
      });
    }

    let sourceUrl: URL;
    try {
      sourceUrl = new URL(transformConfig.source);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    if (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") {
      return new Response("Bad Request", { status: 400 });
    }

    if (sourceUrl.username || sourceUrl.password) {
      return new Response("Bad Request", { status: 400 });
    }

    if (!isAllowedSourceUrl(sourceUrl)) {
      return new Response("Forbidden", { status: 403 });
    }

    const upstream = await fetch(sourceUrl);
    if (!upstream.ok)
      return new Response("Upstream fetch failed", { status: 502 });

    const input = Sharp(Buffer.from(await upstream.arrayBuffer()));

    const image = pipe(
      input,
      /**
       * auto-orient: read's the image's EXIF data and rotates it to the correct
       * orientation.
       */
      (image: Sharp.Sharp) => image.rotate(),

      /**
       * Resize
       */
      (image: Sharp.Sharp) =>
        transformConfig.w || transformConfig.h
          ? image.resize({
              width: transformConfig.w,
              height: transformConfig.h,
              fit: transformConfig.fit ?? "inside",
              withoutEnlargement: true,
            })
          : image,

      /**
       * Change format
       */
      (image: Sharp.Sharp) => {
        switch (transformConfig.fmt) {
          case "preserve":
            return image;
          case "avif":
            return image.avif({ quality });
          case "webp":
            return image.webp({ quality });
          default: {
            throw new Error(`Unreachable case: ${transformConfig.fmt}`);
          }
        }
      },
    );

    const out = await image.toBuffer();
    const body = new Uint8Array(out);

    const contentType = (() => {
      switch (transformConfig.fmt) {
        case "avif": {
          return "image/avif";
        }
        case "webp": {
          return "image/webp";
        }
        case "preserve":
        default: {
          return (
            upstream.headers.get("content-type") ?? "application/octet-stream"
          );
        }
      }
    })();

    await writeTransformCache({
      cacheKey,
      body: out,
      meta: { contentType },
      cacheDir,
    });

    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": cacheControl,
      },
    });
  };
};
