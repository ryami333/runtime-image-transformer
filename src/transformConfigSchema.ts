import z from "zod";

/**
 * Output formats the handler can transcode to, in addition to `"preserve"`
 * (leave the upstream bytes untouched).
 *
 * This is the subset of Sharp's dedicated output encoders that both produce a
 * servable image (a real `image/*` MIME type) and are actually available in the
 * standard prebuilt `sharp` binary. Sharp also exposes `jp2`, `jxl`, and `heif`
 * encoders, but the prebuilt libvips isn't compiled with OpenJPEG / JPEG-XL /
 * HEVC support, so requesting them would fail at encode time; `raw` is omitted
 * because it emits headerless pixel data with no MIME type.
 */
export const formatEnum = z.enum([
  "preserve",
  "jpeg",
  "png",
  "webp",
  "avif",
  "gif",
  "tiff",
]);

export type Format = z.output<typeof formatEnum>;

export const transformConfigSchema = z.object({
  // Bounded to positive, sane values: negatives make Sharp throw, and absurd
  // sizes are a needless resource sink. `withoutEnlargement` already caps output
  // at the source dimensions, so the ceiling is just a guardrail.
  w: z.int32().min(1).max(16384).optional(),
  h: z.int32().min(1).max(16384).optional(),
  /**
   * Resize fit mode (Sharp's `ResizeOptions["fit"]`).
   *
   * Defaults to `"inside"` when omitted.
   */
  fit: z.enum(["cover", "contain", "fill", "inside", "outside"]).optional(),
  fmt: formatEnum.optional(),
  q: z.int32().min(0).max(100).optional(),
  source: z.string(),
});

export type TransformConfig = z.output<typeof transformConfigSchema>;
