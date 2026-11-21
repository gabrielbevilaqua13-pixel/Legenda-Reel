import { z } from "zod";
export const manifestSchema = z
  .array(
    z.object({
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      offset: z.number().nonnegative(),
      duration: z.number().positive().max(12),
      keepStart: z.number().nonnegative(),
      keepEnd: z.number().positive().max(600.001),
    }),
  )
  .min(1)
  .max(100);
export type Manifest = z.infer<typeof manifestSchema>;
