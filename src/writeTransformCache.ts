import fs from "node:fs/promises";
import { getTransformCachePaths } from "./getTransformCachePaths";

export async function writeTransformCache({
  cacheKey,
  body,
  meta,
  cacheDir,
}: {
  cacheKey: string;
  body: Uint8Array;
  meta: { contentType: string };
  cacheDir: string;
}) {
  const { dir, bodyPath, metaPath } = getTransformCachePaths({
    cacheKey,
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
    fs.writeFile(tmpMetaPath, JSON.stringify(meta), "utf8"),
  ]);

  // Atomic-ish publish: rename temp files into place.
  await Promise.all([
    fs.rename(tmpBodyPath, bodyPath),
    fs.rename(tmpMetaPath, metaPath),
  ]);
}
