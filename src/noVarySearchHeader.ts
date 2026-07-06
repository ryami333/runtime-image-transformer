import { transformConfigSchema } from "./transformConfigSchema";

/**
 * `No-Vary-Search` value advertising exactly which query params affect the
 * response, so caches can collapse URLs that differ only in param order or in
 * unrelated params (tracking junk, etc.). This mirrors what the handler already
 * does server-side: it reads only these params and normalizes their order when
 * computing the cache key.
 *
 * The significant params are derived from the transform schema, so this stays in
 * sync automatically if a param is added or removed.
 *
 * Produces e.g. `key-order, params, except=("w" "h" "fit" "fmt" "q" "source")`.
 */
const significantParams = Object.keys(transformConfigSchema.shape);

export const noVarySearchHeader = `key-order, params, except=(${significantParams
  .map((name) => `"${name}"`)
  .join(" ")})`;
