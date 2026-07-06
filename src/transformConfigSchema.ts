import z from "zod";

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
  fmt: z.enum(["preserve", "webp", "avif"]).optional(),
  q: z.int32().min(0).max(100).optional(),
  source: z.string(),
});

export type TransformConfig = z.output<typeof transformConfigSchema>;
