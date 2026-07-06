import path from "node:path";
import { searchParamsToTransformConfigCodec } from "./searchParamsToTransformConfigCodec";
import { getTransformCacheKey } from "./getTransformCacheKey";
import { readTransformCache } from "./readTransformCache";
import { readCappedBody } from "./readCappedBody";
import { noVarySearchHeader } from "./noVarySearchHeader";
import { pipe } from "fp-ts/function";
import { writeTransformCache } from "./writeTransformCache";
import type { Format } from "./transformConfigSchema";
import type { Sharp } from "sharp";
import type SharpFactory from "sharp";

/**
 * The `sharp` module's callable default export — its factory function. Typed
 * from a type-only import, so this package never pulls Sharp into its own
 * bundle; the caller supplies the instance (see the `sharp` option).
 */
type SharpFactory = typeof import("sharp");

export const createImageTransformRouteHandler = ({
  sourceOrigin,
  sharp,
  cacheDir = path.join(process.cwd(), ".transform-cache"),
  cacheControl = "public, max-age=31536000, immutable",
  maxSourceBytes = 20 * 1024 * 1024,
  maxInputPixels = 3840 * 3840,
  fetchTimeoutMs = 10_000,
  allowedFormats = ["preserve", "webp", "avif"],
}: {
  /**
   * Trusted origin that `source` paths are resolved against, e.g.
   * `"https://images.example.com"`.
   *
   * This is server-side configuration and is intentionally **not** derived from
   * the incoming request (the `Host` header is attacker-controlled). Because the
   * fetch target is always a path under this fixed origin, callers cannot point
   * the handler at arbitrary hosts — this is the handler's SSRF protection.
   */
  sourceOrigin: string;
  /**
   * The `sharp` factory (the module's default export). Sharp is a peer
   * dependency: install it in your app and pass it in, e.g.
   * `import sharp from "sharp"; createImageTransformRouteHandler({ sharp, ... })`.
   *
   * Taking the instance as an option — rather than shipping a bundled one —
   * lets the app control Sharp's version and, where needed, its global
   * configuration (concurrency, SIMD, custom builds) before handing it over.
   */
  sharp: SharpFactory;
  cacheDir?: string;
  cacheControl?: string;
  /**
   * Maximum size, in bytes, of an upstream source image the handler will
   * download. Guards against memory exhaustion from a very large `source`.
   * Enforced against the `Content-Length` header and while streaming the body,
   * so a missing or dishonest `Content-Length` can't get around it.
   *
   * @default 20 * 1024 * 1024 (20 MiB)
   */
  maxSourceBytes?: number;
  /**
   * Maximum number of pixels (width × height) in the *decoded* source image,
   * passed to Sharp's `limitInputPixels`. `maxSourceBytes` bounds bytes off the
   * network, but a tiny compressed file can still decode to an enormous canvas
   * (a "pixel bomb"); this bounds that. A source over the limit is rejected with
   * `502` rather than allocating the memory to decode it.
   *
   * @default 3840 * 3840 (15 megapixels)
   */
  maxInputPixels?: number;
  /**
   * Timeout, in milliseconds, for the upstream fetch. Bounds the whole upstream
   * interaction — connect, response, and body download — so a slow or hanging
   * `source` can't tie up the request indefinitely. On timeout the handler
   * responds with `502`.
   *
   * @default 10_000 (10 seconds)
   */
  fetchTimeoutMs?: number;
  /**
   * Output formats a request is permitted to ask for via the `fmt` param. A
   * request whose effective format (`fmt`, or `"preserve"` when omitted) isn't
   * in this list is rejected with `400`.
   *
   * Restricting this lets you avoid transcoding to formats you never intend to
   * serve — e.g. keeping the surface to modern codecs, or forbidding `preserve`
   * to guarantee every response is re-encoded. The schema still recognises the
   * full set of formats; this narrows which are reachable at runtime.
   *
   * @default ["preserve", "webp", "avif"]
   */
  allowedFormats?: Format[];
}) => {
  let origin: URL;
  try {
    origin = new URL(sourceOrigin);
  } catch {
    throw new Error(
      "createImageTransformRouteHandler: `sourceOrigin` must be an absolute " +
        `URL (got ${JSON.stringify(sourceOrigin)}).`,
    );
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error(
      "createImageTransformRouteHandler: `sourceOrigin` must be an http(s) URL.",
    );
  }

  const allowedFormatSet = new Set<Format>(allowedFormats);

  // The codec's `decode` throws for missing/invalid params (e.g. a missing
  // `source`); `safeDecode` reports schema issues via `error`. Handle both so
  // bad input always yields a 400 rather than a 500.
  const decodeConfig = (reqUrl: string) => {
    try {
      const { searchParams } = new URL(reqUrl);
      const { data, error } =
        searchParamsToTransformConfigCodec.safeDecode(searchParams);
      return error ? null : data;
    } catch {
      return null;
    }
  };

  return async function handler(req: Request): Promise<Response> {
    const transformConfig = decodeConfig(req.url);

    if (!transformConfig) {
      return new Response("Bad Request", { status: 400 });
    }

    // An omitted `fmt` means "preserve", so gate on that same effective format.
    const effectiveFmt = transformConfig.fmt ?? "preserve";
    if (!allowedFormatSet.has(effectiveFmt)) {
      return new Response("Bad Request", { status: 400 });
    }

    // Resolve the requested path against the trusted origin. Resolving against a
    // fixed base means an absolute or protocol-relative `source` (e.g.
    // `"//evil.com/x"` or `"https://evil.com/x"`) lands on a different origin,
    // which we reject: the fetch target can only ever be a path under
    // `sourceOrigin`.
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(transformConfig.source, origin);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (sourceUrl.origin !== origin.origin) {
      return new Response("Bad Request", { status: 400 });
    }

    // Canonical (re-encoded) query so cache hits even if the original request
    // carries superfluous/unknown params or a different param order.
    const canonicalUrl = searchParamsToTransformConfigCodec
      .encode(transformConfig)
      .toString();

    const quality = transformConfig.q ?? 100;

    const cacheKey = getTransformCacheKey({ canonicalUrl });
    const cached = await readTransformCache({ cacheKey, cacheDir });
    if (cached) {
      return new Response(cached.body, {
        headers: {
          "Content-Type": cached.contentType,
          "Cache-Control": cacheControl,
          "No-Vary-Search": noVarySearchHeader,
          // Serve the declared type as-is; never let a browser sniff a different
          // (e.g. executable) type out of the bytes.
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    // `redirect: "manual"` prevents the upstream from bouncing the server
    // off-origin (e.g. to an internal address); a redirect surfaces here as a
    // non-ok response and is treated as a failed fetch.
    //
    // The abort signal bounds the whole upstream interaction — connect,
    // response, and body download — because aborting the request also errors
    // the body stream that `readCappedBody` reads below.
    let upstream: Response;
    try {
      upstream = await fetch(sourceUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(fetchTimeoutMs),
      });
    } catch {
      return new Response("Upstream fetch failed", { status: 502 });
    }
    if (!upstream.ok)
      return new Response("Upstream fetch failed", { status: 502 });

    // For `preserve` we hand back the upstream bytes and its `Content-Type`
    // verbatim, so refuse anything that isn't an image (e.g. an HTML file living
    // on the source origin). Otherwise a browser could content-sniff
    // attacker-controlled bytes as markup and execute them from *this* origin.
    // Transcoding formats are re-encoded and get a fixed `image/*` type below,
    // so they don't need this guard.
    if (effectiveFmt === "preserve") {
      const upstreamType = upstream.headers.get("content-type");
      if (
        !upstreamType ||
        !upstreamType.trim().toLowerCase().startsWith("image/")
      ) {
        return new Response("Upstream is not an image", { status: 502 });
      }
    }

    let sourceBytes: Buffer | null;
    try {
      sourceBytes = await readCappedBody(upstream, maxSourceBytes);
    } catch {
      // A body-stream error, including the timeout firing mid-download.
      return new Response("Upstream fetch failed", { status: 502 });
    }
    if (!sourceBytes) {
      return new Response("Source image too large", { status: 502 });
    }

    const input = sharp(sourceBytes, { limitInputPixels: maxInputPixels });

    const image = pipe(
      input,
      /**
       * auto-orient: read's the image's EXIF data and rotates it to the correct
       * orientation.
       */
      (image: Sharp) => image.rotate(),

      /**
       * Resize
       */
      (image: Sharp) =>
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
      (image: Sharp) => {
        switch (transformConfig.fmt) {
          case undefined:
          case "preserve":
            return image;
          case "jpeg":
            return image.jpeg({ quality });
          case "png":
            // PNG is lossless; `quality` only applies to palette output, so
            // there's no meaningful `q` knob to forward here.
            return image.png();
          case "webp":
            return image.webp({ quality });
          case "avif":
            return image.avif({ quality });
          case "gif":
            // Sharp's GIF encoder has no `quality` option.
            return image.gif();
          case "tiff":
            return image.tiff({ quality });
          default: {
            const _exhaustive: never = transformConfig.fmt;
            throw new Error(`Unreachable case: ${_exhaustive}`);
          }
        }
      },
    );

    // Sharp is lazy, so decode/pixel-limit/encode errors all surface here (e.g.
    // the upstream isn't a valid image, or it exceeds `maxInputPixels`). Treat
    // any of these as an unusable upstream rather than letting it become a 500.
    let out: Buffer;
    try {
      out = await image.toBuffer();
    } catch {
      return new Response("Source image could not be processed", {
        status: 502,
      });
    }
    const body = new Uint8Array(out);

    const contentType = (() => {
      switch (transformConfig.fmt) {
        case "jpeg":
          return "image/jpeg";
        case "png":
          return "image/png";
        case "webp":
          return "image/webp";
        case "avif":
          return "image/avif";
        case "gif":
          return "image/gif";
        case "tiff":
          return "image/tiff";
        case "preserve":
        case undefined:
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
        "No-Vary-Search": noVarySearchHeader,
        // Serve the declared type as-is; never let a browser sniff a different
        // (e.g. executable) type out of the bytes.
        "X-Content-Type-Options": "nosniff",
      },
    });
  };
};
