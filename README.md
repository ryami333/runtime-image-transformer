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
  // Must be an absolute URL. This is used to build a canonical URL for caching.
  apiRouteUrl:
    process.env.IMAGE_TRANSFORM_API_URL ?? "http://localhost:3000/api/image",
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
  apiRouteUrl:
    process.env.IMAGE_TRANSFORM_API_URL ?? "http://localhost:3000/api/image",
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
  // Same absolute URL as the route above, but safe to expose publicly
  // if you want to build URLs client-side.
  apiRouteUrl:
    process.env.NEXT_PUBLIC_IMAGE_TRANSFORM_API_URL ??
    "http://localhost:3000/api/image",
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
        source: "https://images.example.com/cat.jpg",
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

- **`apiRouteUrl`**: `string` (required)
  - **Description**: Absolute URL for the transform route (used to generate a canonical URL for caching).
  - **Default**: none
- **`cacheDir`**: `string` (optional)
  - **Description**: Directory on disk where transformed images are cached.
  - **Default**: `path.join(process.cwd(), ".transform-cache")`
- **`cacheControl`**: `string` (optional)
  - **Description**: Value for the response `Cache-Control` header.
  - **Default**: `"public, max-age=31536000, immutable"`
- **`allowedHosts`**: `Array<string | RegExp>` (optional)
  - **Description**: Allowlist for the upstream `source` URL host. If omitted, **all hosts are allowed**.
    - Exact host: `"images.example.com"`
    - Host + port: `"localhost:3000"`
    - RegExp: `/^(?:.+\.)?example\.com$/` (tested against both `hostname` and `host`)
  - **Default**: `undefined` (allow all)

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
  - **Description**: Absolute URL for your transform route.
  - **Default**: none

### Transform config + query parameters

The transform URL uses these query params:

- **`source`**: `string` (required)
  - Absolute `http(s)` URL to the upstream image.
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
