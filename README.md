# runtime-image-transformer

Self-hosted, Sharp-powered runtime image transforms for server-side web frameworks (Next.js, TanStack Start, and anything else built on the Web `Request`/`Response` API).

If you want something closer to “Imgix/Cloudinary, but inside your own app,” this package gives you:

- A **route handler** that fetches an upstream image, runs a small set of transforms via **Sharp**, and caches results on disk. It's a plain `(req: Request) => Promise<Response>`, so it drops into any framework whose routes speak the Web Fetch API.
- A **URL builder** that creates transform URLs you can use from your app.

> On Next.js specifically, this is an alternative to the built-in image optimization (`next/image` + the `/_next/image` optimizer), which is intentionally **constrained and opinionated**.

This tends to work best on managed app hosting where you run a Node runtime and can put a CDN in front:

- DigitalOcean App Platform (CDN-enabled)
- Render, Fly.io, Railway, Heroku
- AWS App Runner / ECS / EC2 (often fronted by CloudFront)
- Google Cloud Run (often fronted by Cloud CDN)
- Any setup fronted by Cloudflare / Fastly / etc.

### Installation

The examples below use the Next.js App Router; see the collapsible section in step 2 for TanStack Start and other frameworks.

#### 1) Install:

```bash
yarn add runtime-image-transformer sharp
```

#### 2) Add a route handler

Create a [route handler](https://nextjs.org/docs/app/getting-started/route-handlers) at some path, for example: `src/app/image/route.ts`

```ts
// src/app/api/image/route.ts

import { createImageTransformRouteHandler } from "runtime-image-transformer/server";

export const runtime = "nodejs";

const handler = createImageTransformRouteHandler({
  // Required. The trusted origin that `source` paths are fetched from. Callers
  // can only ever request paths under this origin, which is the SSRF protection.
  sourceOrigin:
    process.env.IMAGE_SOURCE_ORIGIN ?? "https://images.example.com",
});

export const GET = handler;
```

<details>
<summary><strong>TanStack Start</strong> (or any other Web-standard framework)</summary>

The handler is a plain `(req: Request) => Promise<Response>`. TanStack Start server routes hand you a context object, so unwrap `request` in a one-line adapter:

```ts
// src/routes/api/image.ts

import { createServerFileRoute } from "@tanstack/react-start/server";
import { createImageTransformRouteHandler } from "runtime-image-transformer/server";

const handler = createImageTransformRouteHandler({
  // Required. The trusted origin that `source` paths are fetched from.
  sourceOrigin:
    process.env.IMAGE_SOURCE_ORIGIN ?? "https://images.example.com",
});

export const ServerRoute = createServerFileRoute().methods({
  GET: ({ request }) => handler(request),
});
```

The same pattern works for Hono, Remix, SvelteKit, and bare `Request`-based servers.

</details>

#### 3) Create a URL builder module

Create a helper for example: `src/lib/imageUrlBuilder.ts`

```ts
import { createImageUrlBuilder } from "runtime-image-transformer";

export const imageUrlBuilder = createImageUrlBuilder({
  // The path of the route above. A root-relative path is recommended: the
  // builder then emits root-relative URLs, so there's no origin to configure at
  // build time (and nothing to expose client-side). An absolute URL — e.g. a
  // CDN-hosted route — also works.
  apiRouteUrl: "/api/image",
});
```

#### 4) Start writing URLs:

Then build URLs like:

```tsx
// src/components/MyImage.tsx

import { imageUrlBuilder } from "../lib/imageUrlBuilder";

export function MyImage() {
  return (
    <img
      src={imageUrlBuilder({
        // A path, resolved server-side against the handler's `sourceOrigin`.
        source: "/cat.jpg",
        fmt: "webp",
        w: 800,
        q: 80,
      })}
    />
  );
}
```

### API reference

#### `createImageTransformRouteHandler(options)`

Import from: `runtime-image-transformer/server`

Returns: `(req: Request) => Promise<Response>` (a Web Fetch handler — compatible with Next.js Route Handlers, TanStack Start server routes, etc.)

**Options**

- **`sourceOrigin`**: `string` (**required**)
  - **Description**: The trusted, absolute origin that `source` paths are resolved and fetched against, e.g. `"https://images.example.com"`. This is the handler's [SSRF](https://owasp.org/www-community/attacks/Server_Side_Request_Forgery) protection: because `source` is always a **path** joined to this fixed, server-side origin, callers can never make the server fetch an arbitrary host. Any `source` that resolves off-origin (an absolute URL, or a protocol-relative `//host` value) is rejected with `400`.
  - **Note**: This is intentionally not derived from the incoming request — the `Host` header is attacker-controlled, so trusting it would reintroduce SSRF and enable cache poisoning.
  - **Default**: none (required; must be an `http(s)` URL or the handler throws at construction)
- **`cacheDir`**: `string` (optional)
  - **Description**: Directory on disk where transformed images are cached.
  - **Default**: `path.join(process.cwd(), ".transform-cache")`
- **`cacheControl`**: `string` (optional)
  - **Description**: Value for the response `Cache-Control` header.
  - **Default**: `"public, max-age=31536000, immutable"`
- **`maxSourceBytes`**: `number` (optional)
  - **Description**: Maximum size, in bytes, of an upstream source image the handler will download, to guard against memory exhaustion. Enforced both against the upstream `Content-Length` (rejected before downloading) and while streaming the body (so a missing or dishonest `Content-Length` can't get around it). A source over the limit yields `502`. This bounds bytes buffered from the network; `maxInputPixels` bounds decoded pixels.
  - **Default**: `20 * 1024 * 1024` (20 MiB)
- **`maxInputPixels`**: `number` (optional)
  - **Description**: Maximum number of pixels (width × height) in the **decoded** source image (maps to Sharp's `limitInputPixels`). Guards against a "pixel bomb" — a tiny compressed file that decodes to an enormous canvas, which `maxSourceBytes` can't catch. A source over the limit yields `502`.
  - **Default**: `3840 * 3840` (~15 megapixels)
- **`fetchTimeoutMs`**: `number` (optional)
  - **Description**: Timeout for the upstream fetch. Bounds the whole upstream interaction — connect, response, and body download — so a slow or hanging `source` can't tie up the request indefinitely. On timeout the handler responds with `502`.
  - **Default**: `10_000` (10 seconds)

- **`allowedFormats`**: `Array<"preserve" | "jpeg" | "png" | "webp" | "avif" | "gif" | "tiff">` (optional)
  - **Description**: Output formats a request may ask for via `fmt`. A request whose effective format (`fmt`, or `"preserve"` when omitted) isn't in this list is rejected with `400`. Use it to keep the served surface to the formats you actually want — e.g. modern codecs only, or dropping `"preserve"` to force every response to be re-encoded.
  - **Default**: `["preserve", "webp", "avif"]`

> **Note**: Upstream redirects are **not** followed (`redirect: "manual"`). A redirect is treated as a failed fetch (`502`) so it can't be used to bounce the server off `sourceOrigin` to an internal address.

**Behavior notes**

- **Format defaulting**: if `fmt` is omitted in the URL, it defaults to `"preserve"`.
- **Quality defaulting**: if `q` is omitted, the handler uses `100`.
- **Resize semantics**: if `w` and/or `h` is provided, the image is resized with:
  - `fit: "inside"` (or the provided `fit`)
  - `withoutEnlargement: true`
- **Auto-orient**: Sharp `rotate()` is applied to respect EXIF orientation.
- **Caching**: responses are cached on disk; your runtime must have a writable filesystem.

#### `createImageUrlBuilder(options)`

Import from: `runtime-image-transformer`

Returns: a function `(config: TransformConfig) => string` that builds a transform URL.

**Options**

- **`apiRouteUrl`**: `string` (required)
  - **Description**: The transform route. Usually a root-relative path like `"/api/image"` (the builder then emits root-relative URLs, so no origin is needed at build time). An absolute URL also works.
  - **Default**: none

### Transform config + query parameters

The transform URL uses these query params:

- **`source`**: `string` (required)
  - A path to the upstream image, e.g. `"/photos/cat.jpg"`. Resolved server-side against the handler's `sourceOrigin`; values that resolve to a different origin are rejected.
- **`fmt`**: `"preserve" | "jpeg" | "png" | "webp" | "avif" | "gif" | "tiff"` (optional)
  - If omitted, it defaults to `"preserve"` (the upstream bytes are returned untouched).
  - `png` and `gif` ignore `q` (PNG is lossless; Sharp's GIF encoder has no quality option).
- **`w`**: `number` (optional)
  - Integer in `[1..16384]`
- **`h`**: `number` (optional)
  - Integer in `[1..16384]`
- **`fit`**: `"cover" | "contain" | "fill" | "inside" | "outside"` (optional)
  - Only used when resizing (`w` and/or `h` is provided)
  - If omitted, it defaults to `"inside"`.
- **`q`**: `number` (optional)
  - Integer in `[0..100]`
  - **Default**: `100`

### CDN caching

This package is designed to sit behind a CDN, so responses are built to cache well:

- **Long-lived, immutable responses**: the default `Cache-Control` is `public, max-age=31536000, immutable`. A transform URL fully describes its output, so the result never changes for a given URL — configure it via `cacheControl` if you want a different policy.
- **Explicit format, no `Vary: Accept`**: the output format is chosen by the `fmt` param, not negotiated from the `Accept` header. This deliberately avoids `Vary: Accept`, which fragments cache entries and is handled inconsistently across CDNs.
- **`No-Vary-Search`**: every successful response carries a [`No-Vary-Search`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/No-Vary-Search) header advertising the only params that affect the output:

  ```
  No-Vary-Search: key-order, params, except=("w" "h" "fit" "fmt" "q" "source")
  ```

  This tells caches to ignore param order and any unrelated params (e.g. `utm_*` tracking), so `?source=/cat.jpg&w=800&utm_campaign=x` collapses onto the same entry as `?w=800&source=/cat.jpg`. It mirrors how the handler computes its own cache key. Support is currently strongest in the browser HTTP cache and Speculation-Rules prefetch (Chromium); CDN support is still emerging.

**Configuring the CDN cache key.** Because `No-Vary-Search` isn't yet widely honored by CDNs, get the same normalization at the edge by keying only on the significant params (`w`, `h`, `fit`, `fmt`, `q`, `source`) and ignoring the rest:

- **CloudFront** — a Cache Policy with a query-string allowlist of those params.
- **Cloudflare** — Cache Rules / a custom Cache Key including only those params.
- **Fastly** — sort the query and strip unknown params in VCL.

If all your URLs come from `createImageUrlBuilder`, they're already canonical (fixed param order, no extras), so this mostly matters for hand-built or tracking-decorated URLs.

### License

See `LICENSE.md`.
