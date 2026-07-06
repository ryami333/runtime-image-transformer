import path from "node:path";
import { readTransformCache } from "./readTransformCache";
import { writeTransformCache } from "./writeTransformCache";
import type { CachePlugin } from "./CachePlugin";

/**
 * The default {@link CachePlugin}: stores transformed images on the local
 * filesystem under `cacheDir`, sharding by key prefix. Requires a writable
 * filesystem on the runtime.
 *
 * This is what the handler uses when no `cache` is supplied. Construct one
 * explicitly to point it at a specific directory, or use it as a template for
 * your own backend.
 */
export function createFileSystemCache({
  cacheDir = path.join(process.cwd(), ".transform-cache"),
}: {
  /**
   * Directory on disk where transformed images are cached.
   *
   * @default path.join(process.cwd(), ".transform-cache")
   */
  cacheDir?: string;
} = {}): CachePlugin {
  return {
    read: (key) => readTransformCache({ cacheKey: key, cacheDir }),
    write: (key, { body, contentType }) =>
      writeTransformCache({
        cacheKey: key,
        body,
        meta: { contentType },
        cacheDir,
      }),
  };
}
