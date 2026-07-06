/**
 * A cached transform: the encoded image bytes plus the `Content-Type` to serve
 * them with.
 */
export type CacheEntry = {
  body: Uint8Array;
  contentType: string;
};

/**
 * Pluggable cache backend for transformed images.
 *
 * The handler derives an opaque, filesystem-safe `key` for each transform and
 * calls `read(key)` before doing any work and `write(key, entry)` after
 * producing a result. Implement this to back the cache with whatever store you
 * like — the on-disk default (`createFileSystemCache`), or a shared/remote
 * store such as S3-compatible object storage, Redis, etc.
 */
export type CachePlugin = {
  /**
   * Look up a previously cached entry. Resolve to the entry on a hit, or `null`
   * on a miss.
   */
  read: (key: string) => Promise<CacheEntry | null>;
  /**
   * Persist an entry under `key`. Resolves once the entry is durably stored (or
   * best-effort stored, for backends without atomicity guarantees).
   */
  write: (key: string, entry: CacheEntry) => Promise<void>;
};
