# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`runtime-image-transformer` (npm name; the local dir is `next-image-transformer`) is an ESM-only library that provides self-hosted, Sharp-powered runtime image transforms for any server framework whose routes speak the Web `Request`/`Response` API (Next.js, TanStack Start, Hono, etc.). It is published to npm as a library — there is no application to run here.

## Commands

Uses **Yarn 4** (Berry) — run scripts via `yarn`, not `npm`.

- `yarn build` — `vite build && tsc`. Vite (rolldown) bundles the ESM JS to `dist/`; `tsc` runs second with `emitDeclarationOnly` to emit `.d.ts` files only. Both are needed for a complete build.
- `yarn test` — run the Vitest suite once.
- `yarn test:watch` — Vitest in watch mode.
- `yarn tsc` — typecheck (declaration emit); CI runs this separately from tests.
- `yarn lint` — `eslint .`.
- `yarn prettier . --check` — formatting check (CI enforces this).
- Run a single test file: `yarn vitest run src/createImageTransformRouteHandler.test.ts`
- Run tests by name: `yarn vitest run -t "part of test name"`

CI (`.github/workflows/quality-assurance.yml`) runs `tsc` and `test` across Node 22/24/26, plus `build`, `eslint .`, and `prettier --check`. Match all of these before considering work done.

## Architecture

Two public entry points, split so client code never pulls in server-only deps:

- **`runtime-image-transformer`** (`src/index.ts`) — client/build-safe. Exports `createImageUrlBuilder` only. Safe to import anywhere (no Node or Sharp deps).
- **`runtime-image-transformer/server`** (`src/server.ts`) — the route handler `createImageTransformRouteHandler`, the `createFileSystemCachePlugin`, and the `CachePlugin`/`CacheEntry` types. Server-only.

`sharp` is a **peer dependency** and is never bundled (it's marked external in `vite.config.mjs`). The handler takes the `sharp` factory as an option so the consuming app controls its version/config. `next` is an optional peer dep and is not actually imported by the code — the handler is a plain `(req: Request) => Promise<Response>`.

### Request flow (`createImageTransformRouteHandler.ts`)

1. Decode the request URL's search params into a `TransformConfig` (400 on any invalid/missing param).
2. Enforce `allowedFormats` on the effective format (`fmt`, or `"preserve"` when omitted) → 400.
3. Resolve `source` against the fixed `sourceOrigin`; reject anything that lands off-origin → 400.
4. Compute a canonical (re-encoded, order-normalized) query and hash it into a cache key. Return a cache hit if present.
5. Fetch upstream with `redirect: "manual"` and a timeout; cap the downloaded body size; run Sharp (auto-orient → optional resize → optional transcode).
6. Write to the cache (if a plugin is configured) and respond.

### Codec layer (the config plumbing)

The config is defined once and moved between representations by **Zod codecs**, so encode/decode stay in sync. When adding or changing a transform param, touch these together:

- `transformConfigSchema.ts` — the source of truth `TransformConfig` schema + `formatEnum` (the Sharp output formats deliberately limited to those the prebuilt `sharp` binary supports). Read its comments before adding a format.
- `searchParamsToTransformConfigCodec.ts` — `URLSearchParams` ⇄ `TransformConfig`. Used both to decode incoming requests and to encode the canonical cache URL.
- `createImageUrlCodec.ts` / `createImageUrlBuilder.ts` — string URL ⇄ config; the client-facing URL builder.
- `noVarySearchHeader.ts` — derives the `No-Vary-Search` response header from the schema shape automatically, so it stays in sync.

### Caching

Pluggable via the `CachePlugin` contract (`read(key)` / `write(key, entry)`). Caching is **disabled by default** (no plugin → every request transforms fresh, relying on a CDN). `createFileSystemCachePlugin.ts` is the on-disk implementation: sharded by key prefix (`getTransformCachePaths.ts`), keyed by a sha256 of the canonical URL (`getTransformCacheKey.ts`), with atomic-ish temp-file-then-rename writes.

### Security invariants — do not weaken

These are the reason the handler is shaped the way it is; the code comments spell out the attacks. Preserve them:

- **SSRF**: `sourceOrigin` is fixed server-side config, never derived from the request (`Host` is attacker-controlled). `source` is always a path joined to that origin; off-origin resolutions are rejected. Upstream redirects are not followed.
- **Resource exhaustion**: `maxSourceBytes` caps bytes off the network (checked against `Content-Length` *and* while streaming, see `readCappedBody.ts`); `maxInputPixels` caps decoded pixels (pixel bombs); `fetchTimeoutMs` bounds the whole upstream interaction.
- **Content sniffing**: responses always set `X-Content-Type-Options: nosniff`. For `preserve`, the upstream must declare an `image/*` content-type or it's rejected (502) — otherwise attacker HTML on the source origin could be sniffed as markup.

## Conventions

- ESM only (`"type": "module"`), imports are extensionless (bundler resolution).
- Tests are colocated as `*.test.ts` next to their subject in `src/`.
- Prettier defaults; keep the existing dense explanatory comments on security/behavioral decisions.
- Always format changed files with Prettier after editing: `yarn prettier {file} --write`. CI enforces `prettier --check`.
