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
- **`fmt`**: `"preserve" | "webp" | "avif"` (optional)
  - If omitted, it defaults to `"preserve"`.
- **`w`**: `number` (optional)
  - 32-bit integer
- **`h`**: `number` (optional)
  - 32-bit integer
- **`fit`**: `"cover" | "contain" | "fill" | "inside" | "outside"` (optional)
  - Only used when resizing (`w` and/or `h` is provided)
  - If omitted, it defaults to `"inside"`.
- **`q`**: `number` (optional)
  - Integer in `[0..100]`
  - **Default**: `100`

### License

See `LICENSE.md`.
