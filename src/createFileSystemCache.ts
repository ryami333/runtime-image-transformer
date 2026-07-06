import fs from "node:fs/promises";
import path from "node:path";
import z from "zod";
import { getTransformCachePaths } from "./getTransformCachePaths";
import type { CachePlugin } from "./CachePlugin";

const metaSchema = z.object({ contentType: z.string() }).loose();

/**
 * The default {@link CachePlugin}: stores transformed images on the local
 * filesystem under `cacheDir`, sharding by key prefix. Requires a writable
 * filesystem on the runtime.
 *
 * This is what the handler uses when no `cachePlugin` is supplied. Construct one
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
    read: async (key) => {
      const { bodyPath, metaPath } = getTransformCachePaths({
        cacheKey: key,
        cacheDir,
      });

      try {
        const [body, metaRaw] = await Promise.all([
          fs.readFile(bodyPath),
          fs.readFile(metaPath, "utf8"),
        ]);
        const meta = (() => {
          try {
            const result = metaSchema.safeParse(JSON.parse(metaRaw));
            return result.success ? result.data : null;
          } catch {
            return null;
          }
        })();
        if (!meta) return null;

        return { body: new Uint8Array(body), contentType: meta.contentType };
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
          return null;
        }
        throw err;
      }
    },

    write: async (key, { body, contentType }) => {
      const { dir, bodyPath, metaPath } = getTransformCachePaths({
        cacheKey: key,
        cacheDir,
      });
      await fs.mkdir(dir, { recursive: true });

      const tmpSuffix = `${process.pid}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`;
      const tmpBodyPath = `${bodyPath}.${tmpSuffix}.tmp`;
      const tmpMetaPath = `${metaPath}.${tmpSuffix}.tmp`;

      await Promise.all([
        fs.writeFile(tmpBodyPath, body),
        fs.writeFile(tmpMetaPath, JSON.stringify({ contentType }), "utf8"),
      ]);

      // Atomic-ish publish: rename temp files into place.
      await Promise.all([
        fs.rename(tmpBodyPath, bodyPath),
        fs.rename(tmpMetaPath, metaPath),
      ]);
    },
  };
}
